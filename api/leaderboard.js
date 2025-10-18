export const config = { runtime: 'edge' };
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const ZSET_KEY = 'puzzle:best_time';
const USER_HASH_PREFIX = 'puzzle:user:';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      const list = await redis.zrange(ZSET_KEY, 0, 9, { withScores: true });
      const out = [];
      for (const row of list) {
        const name = row.member;
        const time = Number(row.score);
        const h = await redis.hgetall(USER_HASH_PREFIX + name);
        out.push({ name, time, moves: Number(h?.moves || 0) });
      }
      return json(out);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const username = String(body.name || 'Anon').slice(0, 40);
      const time = Number(body.time);
      const moves = Number(body.moves);

      await redis.zadd(ZSET_KEY, { score: time, member: username });
      await redis.hset(USER_HASH_PREFIX + username, {
        time,
        moves,
        updated: Date.now(),
      });

      return json({ ok: true });
    }

    return json({ error: 'Method Not Allowed' }, 405);
  } catch (e) {
    return json({ error: e.message || 'Server error' }, 500);
  }
}
