// /api/leaderboard.js
export const config = { runtime: 'edge' };

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Panggilan REST Upstash – kirim { args: [...] } dan semua argumen sebagai string
async function ucall(cmd, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Upstash not configured' }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }

  const payload = { args: args.map(v => (v == null ? '' : String(v))) };

  const res = await fetch(`${UPSTASH_URL}/${cmd}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Upstash ${cmd} failed: ${txt || res.status}`);
  }
  return res.json();
}

export default async function handler(req) {
  try {
    // GET: ambil TOP 10
    if (req.method === 'GET') {
      // ZRANGE key 0 9 WITHSCORES
      const r = await ucall('zrange', 'puzzle:best_time', '0', '9', 'WITHSCORES');
      const arr = r?.result || r || [];
      const out = [];
      for (let i = 0; i < arr.length; i += 2) {
        out.push({ name: String(arr[i]), time: Number(arr[i + 1]) });
      }
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
    }

    // POST: simpan score (lebih baik = waktu lebih kecil)
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ error: 'Invalid body' }), {
          status: 400, headers: { 'content-type': 'application/json' }
        });
      }

      const rawName = (body.name ?? 'Anon') + '';
      const name = rawName.trim().replace(/[\x00-\x1F\x7F]+/g, '').slice(0, 40) || 'Anon';
      const time = Math.max(0, Number(body.time || 0));
      const moves = Math.max(0, Number(body.moves || 0));

      // ZADD key LT time name
      await ucall('zadd', 'puzzle:best_time', 'LT', String(time), name);
      await ucall('hset', `puzzle:user:${name}`, 'time', String(time), 'moves', String(moves), 'updated', String(Date.now()));

      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Server error' }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
}
