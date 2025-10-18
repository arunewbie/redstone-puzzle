// /api/leaderboard.js
export const config = { runtime: 'edge' };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Helper call ke Upstash REST API
async function ucall(cmd, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('Upstash not configured');
  }

  const res = await fetch(`${UPSTASH_URL}/${cmd}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Upstash ${cmd} failed: ${txt || res.status}`);
  }
  return res.json();
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      // Ambil top 10 score
      const r = await ucall('zrange', 'puzzle:best_time', 0, 9, { withScores: true });
      const arr = r.result || [];
      const scores = [];
      for (let i = 0; i < arr.length; i += 2) {
        scores.push({ name: arr[i], time: Number(arr[i + 1]) });
      }
      return new Response(JSON.stringify(scores), { headers: { 'content-type': 'application/json' } });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400 });
      }

      const name = (body.name || 'Anon').slice(0, 40);
      const time = Number(body.time || 0);
      const moves = Number(body.moves || 0);

      // Simpan score hanya jika lebih baik (time lebih kecil)
      await ucall('zadd', 'puzzle:best_time', { lt: true }, time, name);
      await ucall('hset', `puzzle:user:${name}`, 'time', time, 'moves', moves, 'updated', Date.now());

      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Server error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
