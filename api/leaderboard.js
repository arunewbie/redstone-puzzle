// /api/leaderboard.js
export const config = { runtime: 'edge' };

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;   // e.g. https://careful-guppy-6271.upstash.io
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function ucall(cmd, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash not configured');

  // ✅ Format yang benar untuk Upstash REST:
  // POST { command: "ZRANGE", args: ["key","0","9","WITHSCORES"] } ke base URL
  const payload = {
    command: String(cmd).toUpperCase(),
    args: args.map(v => String(v)),
  };

  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json(); // { result: ... }
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      // Ambil top 10
      const r = await ucall('ZRANGE', 'puzzle:best_time', '0', '9', 'WITHSCORES');
      const arr = r?.result || [];
      const out = [];
      for (let i = 0; i < arr.length; i += 2) {
        out.push({ name: String(arr[i]), time: Number(arr[i + 1]) });
      }
      return new Response(JSON.stringify(out), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400 });
      }

      const name  = (body.name  || 'Anon').toString().trim().slice(0, 40);
      const time  = Math.max(0, Number(body.time  || 0)); // ms
      const moves = Math.max(0, Number(body.moves || 0));

      // Simpan hanya jika lebih baik (LT)
      await ucall('ZADD', 'puzzle:best_time', 'LT', String(time), name);
      await ucall('HSET', `puzzle:user:${name}`,
        'time',   String(time),
        'moves',  String(moves),
        'updated', String(Date.now())
      );

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || 'Server error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
