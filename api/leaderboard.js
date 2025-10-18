// /api/leaderboard.js
export const config = { runtime: 'edge' };

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ZSET_KEY = 'puzzle:best_time';     // skor = waktu (ms), makin kecil makin bagus
const USER_HASH_PREFIX = 'puzzle:user:'; // HSET per user: time, moves, updated, last_submit


function validateEnv() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash not configured (missing REST URL/TOKEN).');
  }
  if (!/^https:\/\/.*upstash\.io/.test(process.env.UPSTASH_REDIS_REST_URL)) {
    throw new Error('UPSTASH_REDIS_REST_URL must be an HTTPS Upstash REST URL (not rediss://).');
  }
}


async function ucall(cmd, ...args) {
  // Upstash REST: POST {args[]} ke {BASE}/{command}
  const res = await fetch(`${UPSTASH_URL}/${cmd}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>null);
    throw new Error(`Upstash ${cmd} failed: ${t || res.status}`);
  }
  return res.json();
}

function sanitizeName(name){
  if (!name) return 'Anon';
  let n = String(name).trim().replace(/[\x00-\x1F\x7F]+/g, '');
  if (n.length > 40) n = n.slice(0, 40);
  return n || 'Anon';
}

async function getUserHash(username) {
  const r = await ucall('hgetall', USER_HASH_PREFIX + username);
  const arr = r?.result || r;
  if (!Array.isArray(arr)) return {};
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i+1];
  return obj;
}

async function submitScore({ name, time, moves }) {
  const username = sanitizeName(name);
  const t = Math.max(0, Number(time || 0));
  const m = Math.max(0, Number(moves || 0));
  const now = Date.now();

  // Validasi ringan
  const MIN_TIME_MS = 2000;
  const MAX_TIME_MS = 1000 * 60 * 60;
  const RATE_LIMIT_MS = 5000;
  const MAX_MOVES = 5000;

  if (t < MIN_TIME_MS)  return { ok:false, code:'too_fast',       message:`time too small (<${MIN_TIME_MS}ms)` };
  if (t > MAX_TIME_MS)  return { ok:false, code:'time_too_large', message:'time value seems invalid' };
  if (m < 0 || m > MAX_MOVES) return { ok:false, code:'moves_invalid', message:'moves value invalid' };

  // rate limit
  const userHash = await getUserHash(username);
  const lastSubmit = Number(userHash.last_submit || 0);
  if (lastSubmit && (now - lastSubmit) < RATE_LIMIT_MS) {
    return { ok:false, code:'rate_limited', message:`submit too often. wait ${((RATE_LIMIT_MS - (now - lastSubmit))/1000|0)}s` };
  }

  // Simpan: ZADD LT (hanya update kalau waktu lebih baik) + HSET
  await ucall('zadd', ZSET_KEY, { lt: true }, t, username);
  await ucall('hset', USER_HASH_PREFIX + username,
    'time', t, 'moves', m, 'updated', now, 'last_submit', now
  );

  return { ok:true };
}

async function getTop(limit = 10) {
  const r = await ucall('zrange', ZSET_KEY, 0, limit - 1, { withScores: true });
  const arr = r?.result || r || [];
  const rows = [];
  for (let i=0; i<arr.length; i+=2) rows.push({ name: arr[i], time: Number(arr[i+1]) });
  if (!rows.length) return [];

  // pipeline untuk ambil moves dari hash per user
  const pipe = rows.map(row => (['HGETALL', USER_HASH_PREFIX + row.name]));
  const resp = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipe)
  });

  if (!resp.ok) {
    // fallback: tanpa moves
    return rows.map(r => ({ ...r, moves: 0 }));
  }

  const all = await resp.json();
  return rows.map((row, i) => {
    const h = all?.[i]?.result || [];
    const obj = {};
    for (let j=0; j<(h.length||0); j+=2) obj[h[j]] = h[j+1];
    return { name: row.name, time: row.time, moves: Number(obj.moves || 0) };
  });
}

export default async function handler(req) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error:'Upstash not configured' }), { status:500, headers:{'content-type':'application/json'} });
  }

  try {
    if (req.method === 'GET') {
      const top = await getTop(10);
      return new Response(JSON.stringify(top), { headers:{'content-type':'application/json'} });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(()=>null);
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ ok:false, code:'invalid_body', message:'invalid JSON' }), { status:400, headers:{'content-type':'application/json'} });
      }
      const out = await submitScore({ name: body.name, time: body.time, moves: body.moves });
      const status = out.ok ? 200 : (out.code === 'rate_limited' ? 429 : 400);
      return new Response(JSON.stringify(out.ok ? { ok:true } : out), { status, headers:{'content-type':'application/json'} });
    }

    return new Response('Method Not Allowed', { status:405 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Server error' }), { status:500, headers:{'content-type':'application/json'} });
  }
}
