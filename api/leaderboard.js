export const config = { runtime: 'edge' };

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function ucall(cmd, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash not configured');
  const payload = { args: [cmd.toUpperCase(), ...args.map(v => String(v))] };
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') {
      const r = await ucall('ZRANGE', 'puzzle:best_time', '0', '9', 'WITHSCORES');
      const arr = r?.result || [];
      const out = [];
      for (let i = 0; i < arr.length; i += 2) {
        out.push({ name: String(arr[i]), time: Number(arr[i + 1]) });
      }
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const name = (body.name || 'Anon').trim().slice(0, 40);
      const time = String(Math.max(0, Number(body.time || 0)));
      const moves = String(Math.max(0, Number(body.moves || 0)));

      await ucall('ZADD', 'puzzle:best_time', 'LT', time, name);
      await ucall('HSET', `puzzle:user:${name}`, 'time', time, 'moves', moves, 'updated', String(Date.now()));

      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
