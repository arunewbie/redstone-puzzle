// /api/leaderboard.js
export const config = { runtime: 'edge' };
import { Redis } from '@upstash/redis/cloudflare';

const redis = Redis.fromEnv();
const Z = 'puzzle:best_time';               // zset: score = time(ms), lebih kecil lebih bagus
const H = (u) => `puzzle:user:${u}`;        // hash per user: { time, moves, updated }

const ok = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// --- Normalizer: apapun bentuk return zrange, jadikan [{name, time}]
async function normalizeZRange(raw) {
  if (!raw) return [];
  // Bentuk A (SDK modern): [{ member, score }, ...]
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === 'object' && 'member' in raw[0]) {
    return raw.map(r => ({ name: r.member, time: Number(r.score) }));
  }
  // Bentuk B (REST lama): [member, score, member, score, ...]
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string' && typeof raw[1] !== 'string') {
    const rows = [];
    for (let i = 0; i < raw.length; i += 2) rows.push({ name: raw[i], time: Number(raw[i + 1]) });
    return rows;
  }
  // Bentuk C (members saja): [member, member, ...] → ambil skor via ZSCORE
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string') {
    const withScore = await Promise.all(
      raw.map(async (m) => {
        const s = await redis.zscore(Z, m);
        return { name: m, time: Number(s ?? 0) };
      })
    );
    return withScore;
  }
  return [];
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      const raw = await redis.zrange(Z, 0, 9, { withScores: true });
      const rows = await normalizeZRange(raw);

      // lengkapi moves dari hash (kalau ada)
      const full = await Promise.all(rows.map(async r => {
        const h = await redis.hgetall(H(r.name)) || {};
        return { name: r.name || 'Anon', time: Number(r.time || 0), moves: Number(h.moves || 0) };
      }));

      // sort guard (kalau provider balik acak)
      full.sort((a,b) => (a.time - b.time) || (a.moves - b.moves));
      return ok(full);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') return ok({ error: 'Invalid body' }, 400);

      const name  = String(body.name || 'Anon').trim().replace(/[\x00-\x1F\x7F]+/g,'').slice(0,40) || 'Anon';
      const time  = Math.max(0, Number(body.time || 0));
      const moves = Math.max(0, Number(body.moves || 0));

      // validasi ringan
      if (time < 2000) return ok({ ok:false, code:'too_fast' }, 400);
      if (time > 1000*60*60) return ok({ ok:false, code:'time_too_large' }, 400);
      if (moves < 0 || moves > 5000) return ok({ ok:false, code:'moves_invalid' }, 400);

      // update hanya jika lebih baik
      const best = await redis.zscore(Z, name);
      if (best == null || time < Number(best)) {
        await redis.zadd(Z, { score: time, member: name }); // simpan best baru
      }
      await redis.hset(H(name), { time, moves, updated: Date.now() });

      return ok({ ok: true });
    }

    return ok({ error: 'Method Not Allowed' }, 405);
  } catch (e) {
    return ok({ error: e?.message || 'Server error' }, 500);
  }
}
