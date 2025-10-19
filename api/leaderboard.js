// /api/leaderboard.js
export const config = { runtime: 'edge' };

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const Z = 'puzzle:best_time';
const H = (u) => `puzzle:user:${u}`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function sanitize(name) {
  const n = String(name || '').trim().replace(/[\x00-\x1F\x7F]+/g, '').slice(0, 40);
  return n || 'Anon';
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      // Bisa kembali dalam 2 bentuk:
      // 1) SDK: [{ member, score }, ...]
      // 2) “flat array”: ["user1","12345","user2","23456", ...]
      const raw = await redis.zrange(Z, 0, 9, { withScores: true });

      let pairs = [];
      if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && raw[0] !== null && 'member' in raw[0]) {
        // Bentuk SDK
        pairs = raw.map(({ member, score }) => [member, Number(score)]);
      } else if (Array.isArray(raw)) {
        // Jaga-jaga kalau bentuknya flat
        for (let i = 0; i < raw.length; i += 2) {
          pairs.push([raw[i], Number(raw[i + 1])]);
        }
      }

      // Ambil moves dari hash per user
      const out = await Promise.all(
        pairs
          .filter(([m, s]) => typeof m === 'string' && m.length) // buang yang kosong
          .map(async ([member, score]) => {
            const h = (await redis.hgetall(H(member))) || {};
            return {
              name: member,
              time: Number(score || 0),
              moves: Number(h.moves || 0),
            };
          })
      );

      // urutkan (waktu kecil dulu, lalu moves kecil)
      out.sort((a, b) => (a.time - b.time) || (a.moves - b.moves));
      return json(out);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);

      const name = sanitize(body.name);
      const time = Math.max(0, Number(body.time || 0));
      const moves = Math.max(0, Number(body.moves || 0));

      // validasi ringan
      if (time < 2000) return json({ ok: false, code: 'too_fast' }, 400);
      if (time > 1000 * 60 * 60) return json({ ok: false, code: 'time_too_large' }, 400);
      if (moves < 0 || moves > 5000) return json({ ok: false, code: 'moves_invalid' }, 400);

      // update hanya kalau lebih baik
      const best = await redis.zscore(Z, name);
      if (best == null || time < Number(best)) {
        await redis.zadd(Z, { score: time, member: name });
      }
      await redis.hset(H(name), { time, moves, updated: Date.now() });

      return json({ ok: true });
    }

    return json({ error: 'Method Not Allowed' }, 405);
  } catch (e) {
    return json({ error: e?.message || 'Server error' }, 500);
  }
}
