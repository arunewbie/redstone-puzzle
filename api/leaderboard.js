// /api/leaderboard.js (Edge, ESM)
import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ZSET_KEY = 'puzzle:best_time';     // score = time(ms), makin kecil makin bagus
const USER_PREFIX = 'puzzle:user:';      // hash: time, moves, updated, last_submit

const MIN_TIME_MS = 2000;
const MAX_TIME_MS = 1000 * 60 * 60;
const RATE_LIMIT_MS = 5000;
const MAX_MOVES = 5000;

const json = (obj, init = 200) =>
  new Response(JSON.stringify(obj), {
    status: init,
    headers: { 'content-type': 'application/json' },
  });

const sanitizeName = (name) => {
  if (!name) return 'Anon';
  let n = String(name).trim().replace(/[\x00-\x1F\x7F]+/g, '');
  if (n.length > 40) n = n.slice(0, 40);
  return n || 'Anon';
};

async function getUserHash(username) {
  const key = USER_PREFIX + username;
  // Upstash returns flat array via HGETALL
  const arr = await redis.hgetall(key);
  // SDK already returns object in newer versions; fallback if null
  return arr || {};
}

async function submitScore({ name, time, moves }) {
  const username = sanitizeName(name);
  const t = Math.max(0, Number(time || 0));
  const m = Math.max(0, Number(moves || 0));
  const now = Date.now();

  if (t < MIN_TIME_MS) return { ok: false, code: 'too_fast', message: `time < ${MIN_TIME_MS}ms` };
  if (t > MAX_TIME_MS) return { ok: false, code: 'time_too_large', message: 'time too large' };
  if (m < 0 || m > MAX_MOVES) return { ok: false, code: 'moves_invalid', message: 'moves invalid' };

  const key = USER_PREFIX + username;
  const info = await getUserHash(username);
  const last = Number(info.last_submit || 0);
  if (last && now - last < RATE_LIMIT_MS) {
    return {
      ok: false,
      code: 'rate_limited',
      message: `wait ${((RATE_LIMIT_MS - (now - last)) / 1000) | 0}s`,
    };
  }

  // ZADD with LT (only replace if better/smaller time)
  await redis.zadd(ZSET_KEY, { score: t, member: username, lt: true });
  await redis.hset(key, { time: t, moves: m, updated: now, last_submit: now });

  return { ok: true };
}

async function getTop(limit = 10) {
  // zrange withScores returns [{member, score}]
  const rows = await redis.zrange(ZSET_KEY, 0, limit - 1, { withScores: true });
  if (!rows?.length) return [];

  // fetch moves for each user
  const keys = rows.map(r => USER_PREFIX + r.member);
  const pipeline = redis.pipeline();
  keys.forEach(k => pipeline.hgetall(k));
  const hashes = await pipeline.exec();

  return rows.map((r, i) => {
    const h = hashes[i] || {};
    return { name: r.member, time: Number(r.score), moves: Number(h?.moves || 0) };
  });
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      const top = await getTop(10);
      return json(top);
    }
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object')
        return json({ ok: false, code: 'invalid_body' }, 400);

      const out = await submitScore({
        name: body.name,
        time: body.time,
        moves: body.moves,
      });
      const status = out.ok ? 200 : out.code === 'rate_limited' ? 429 : 400;
      return json(out.ok ? { ok: true } : out, status);
    }
    return new Response('Method Not Allowed', { status: 405 });
  } catch (e) {
    return json({ error: e?.message || 'Server error' }, 500);
  }
}
