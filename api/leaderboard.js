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

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      // SDK mengembalikan: [{ member, score }, ...]
      const rows = await redis.zrange(Z, 0, 9, { withScores: true });

      const out = await Promise.all(
        (rows || []).map(async ({ member, score }) => {
          const h = (await redis.hgetall(H(member))) || {};
          return {
            name: member || 'Anon',
            time: Number(score || 0),
            moves: Number(h.moves || 0),
          };
        })
      );

      // guard sort
      out.sort((a, b) => (a.time - b.time) || (a.moves - b.moves));
      return json(out);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return json({ error: 'Invalid body' }, 400);
      }

      const name  = String(body.name || 'Anon').trim().replace(/[\x00-\x1F\x7F]+/g,'').slice(0, 40) || 'Anon';
      const time  = Math.max(0, Number(body.time || 0));
      const moves = Math.max(0, Number(body.moves || 0));

      // validasi ringan
      if (time < 2000)             return json({ ok:false, code:'too_fast' }, 400);
      if (time > 1000 * 60 * 60)   return json({ ok:false, code:'time_too_large' }, 400);
      if (moves < 0 || moves > 5000) return json({ ok:false, code:'moves_invalid' }, 400);

      // hanya update jika lebih baik dari best sebelumnya
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
