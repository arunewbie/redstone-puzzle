// /api/leaderboard.ts
export const config = { runtime: 'edge' };

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;

const ZSET_KEY = 'puzzle:best_time';     // skor = waktu (ms), semakin kecil semakin bagus
const USER_HASH_PREFIX = 'puzzle:user:'; // HSET per user: time, moves, updated, last_submit

// Panggil Upstash REST: POST {args[]} ke {BASE}/{command}
async function ucall(cmd: string, ...args: any[]) {
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

function sanitizeName(name?: string) {
  if (!name) return 'Anon';
  let n = String(name).trim().replace(/[\x00-\x1F\x7F]+/g, '');
  if (n.length > 40) n = n.slice(0, 40);
  return n || 'Anon';
}

async function getUserHash(username: string) {
  const r = await ucall('hgetall', USER_HASH_PREFIX + username);
  const arr = (r as any)?.result || r;
  if (!Array.isArray(arr)) return {};
  const obj: Record<string, string> = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
}

async function submitScore({ name, time, moves }: { name: string; time: number; moves: number; }) {
  const username = sanitizeName(name);
  const t = Math.max(0, Number(time || 0));
  const m = Math.max(0, Number(moves || 0));
  const now = Date.now();

  // Validasi ringan
  const MIN_TIME_MS = 2000;           // minimal 2s
  const MAX_TIME_MS = 1000 * 60 * 60; // maksimal 1 jam
  const RATE_LIMIT_MS = 5000;         // minimal jeda submit per user 5s
  const MAX_MOVES = 5000;

  if (t < MIN_TIME_MS)  return { ok: false, code: 'too_fast', message: `time too small (<${MIN_TIME_MS}ms)` };
  if (t > MAX_TIME_MS)  return { ok: false, code: 'time_too_large', message: 'time value seems invalid' };
  if (m < 0 || m > MAX_MOVES) return { ok: false, code: 'moves_invalid', message: 'moves value invalid' };

  // Rate-limit per user
  const userKey = USER_HASH_PREFIX + username;
  const userHash = await getUserHash(username);
  const lastSubmit = Number((userHash as any).last_submit || 0);
  if (lastSubmit && (now - lastSubmit) < RATE_LIMIT_MS) {
    return { ok: false, code: 'rate_limited', message: `submit too often. wait ${((RATE_LIMIT_MS - (now - lastSubmit)) / 1000) | 0}s` };
  }

  // ZADD (LT → hanya update kalau waktu baru lebih kecil/lebih baik)
  await ucall('zadd', ZSET_KEY, { lt: true }, t, username);
  // HSET info user
  await ucall('hset', userKey, 'time', t, 'moves', m, 'updated', now, 'last_submit', now);

  return { ok: true };
}

async function getTop(limit = 10) {
  // Ambil top N dari zset
  const r = await ucall('zrange', ZSET_KEY, 0, limit - 1, { withScores: true });
  const arr = (r as any)?.result || r || [];
  const rows: { name: string; time: number }[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    rows.push({ name: arr[i], time: Number(arr[i + 1]) });
  }
  if (!rows.length) return [];

  // Pipeline ambil moves per user dari hash
  const pipe = rows.map(row => ['HGETALL', USER_HASH_PREFIX + row.name]);
  const resp = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(pipe),
  });
  if (!resp.ok) {
    // Kalau pipeline gagal, kembalikan tanpa moves
    return rows.map(r => ({ ...r, moves: 0 }));
  }
  const all = await resp.json();
  return rows.map((row, i) => {
    const h = all?.[i]?.result || [];
    const obj: Record<string, string> = {};
    for (let j = 0; j < (h.length || 0); j += 2) obj[h[j]] = h[j + 1];
    return { name: row.name, time: row.time, moves: Number(obj.moves || 0) };
  });
}

export default async function handler(req: Request) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Upstash not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    if (req.method === 'GET') {
      const top = await getTop(10);
      return new Response(JSON.stringify(top), { headers: { 'content-type': 'application/json' } });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null) as any;
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ ok: false, code: 'invalid_body', message: 'invalid JSON' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      const out = await submitScore({ name: body.name, time: body.time, moves: body.moves });
      const status = out.ok ? 200 : (out.code === 'rate_limited' ? 429 : 400);
      return new Response(JSON.stringify(out.ok ? { ok: true } : out), {
        status, headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Server error' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
}
