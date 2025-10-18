export const config = { runtime: 'edge' };

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ZSET_KEY = 'puzzle:best_time';     // zset skor (score = time ms)
const USER_HASH_PREFIX = 'puzzle:user:'; // hash per user: time, moves, updated, last_submit

// convenience wrapper for Upstash REST calls
async function ucall(cmd, ...args) {
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

// get hash fields for a user
async function getUserHash(username) {
  const key = USER_HASH_PREFIX + username;
  const r = await ucall('hgetall', key);
  // Upstash returns { result: [k1,v1,k2,v2...] } or array — normalize
  const arr = r?.result || r;
  if (!Array.isArray(arr)) return {};
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i+1];
  return obj;
}

function sanitizeName(name){
  if (!name) return 'Anon';
  let n = String(name).trim();
  // remove control chars
  n = n.replace(/[\x00-\x1F\x7F]+/g, '');
  // limit length
  if (n.length > 40) n = n.slice(0, 40);
  return n || 'Anon';
}

async function submitScore({ name, time, moves }) {
  const username = sanitizeName(name);
  const t = Math.max(0, Number(time || 0));
  const m = Math.max(0, Number(moves || 0));
  const now = Date.now();

  // Light validation rules
  const MIN_TIME_MS = 2000;       // minimal believable time (2s)
  const MAX_TIME_MS = 1000 * 60 * 60; // 1 hour (sanity)
  const RATE_LIMIT_MS = 5000;     // minimal interval between submissions per user (5s)
  const MAX_MOVES = 5000;         // sanity cap

  if (t < MIN_TIME_MS) {
    return { ok: false, code: 'too_fast', message: `time too small (<${MIN_TIME_MS}ms)` };
  }
  if (t > MAX_TIME_MS) {
    return { ok: false, code: 'time_too_large', message: 'time value seems invalid' };
  }
  if (m < 0 || m > MAX_MOVES) {
    return { ok: false, code: 'moves_invalid', message: 'moves value invalid' };
  }

  // rate limit check (based on last_submit stored in user hash)
  const key = USER_HASH_PREFIX + username;
  const userHash = await getUserHash(username);
  const lastSubmit = Number(userHash.last_submit || 0);
  if (lastSubmit && (now - lastSubmit) < RATE_LIMIT_MS) {
    return { ok: false, code: 'rate_limited', message: `submit too often. wait ${(RATE_LIMIT_MS - (now - lastSubmit))/1000 | 0}s` };
  }

  // Save: ZADD (only if improved) + HSET user info + update last_submit
  // zadd with LT option ensures only update if new score is lower (better)
  await ucall('zadd', ZSET_KEY, { lt: true }, t, username);
  await ucall('hset', key, 'time', t, 'moves', m, 'updated', now, 'last_submit', now);

  return { ok: true };
}

async function getTop(limit = 10) {
  const r = await ucall('zrange', ZSET_KEY, 0, limit - 1, { withScores: true });
  const arr = r?.result || r || [];
  const rows = [];
  for (let i = 0; i < arr.length; i += 2) rows.push({ name: arr[i], time: Number(arr[i+1]) });

  if (!rows.length) return [];


  async function saveScore(username, ms, moves){
  try{
    const res = await fetch('/api/leaderboard', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name: username||'Anon', time: ms, moves })
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({ message: 'submit failed' }));
      alert('⚠️ ' + err.message);
    }
  }catch(e){
    // fallback simpan lokal
    let board = JSON.parse(localStorage.getItem('ps_leaderboard')||'[]');
    board.push({ name: username||'Anon', time: ms, moves });
    board.sort((a,b)=> (a.time - b.time) || (a.moves - b.moves));
    board = board.slice(0, 10);
    localStorage.setItem('ps_leaderboard', JSON.stringify(board));
  }
  renderLeaderboard();
}

  async function renderLeaderboard(){
  const el = document.getElementById('leaderboard');
  el.innerHTML = '';
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    data.forEach((e,i)=>{
      const row = document.createElement('div');
      row.className = 'leader';
      row.innerHTML = `<span>${i===0?'👑 ':''}${i+1}. ${e.name}</span><span>${fmt(e.time)} • ${e.moves} mv</span>`;
      el.appendChild(row);
    });
  } catch {
    const data = JSON.parse(localStorage.getItem('ps_leaderboard') || '[]');
    data.forEach((e,i)=>{
      const row = document.createElement('div');
      row.className = 'leader';
      row.innerHTML = `<span>${i+1}. ${e.name}</span><span>${fmt(e.time)} • ${e.moves} mv</span>`;
      el.appendChild(row);
    });
  }
}


  // pipeline (HGETALL) to retrieve moves
  const pipe = rows.map(row => (['HGETALL', USER_HASH_PREFIX + row.name]));
  const resp = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipe)
  });
  const all = await resp.json();
  return rows.map((row, i) => {
    const h = all?.[i]?.result || {};
    const obj = {};
    for (let j = 0; j < (h.length || 0); j+=2) obj[h[j]] = h[j+1];
    return { name: row.name, time: row.time, moves: Number(obj.moves || 0) };
  });
}

export default async function handler(req) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Upstash not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  try {
    if (req.method === 'GET') {
      const top = await getTop(10);
      return new Response(JSON.stringify(top), { headers: { 'content-type': 'application/json' } });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(()=>null);
      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ ok:false, code:'invalid_body', message:'invalid JSON' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const { name, time, moves } = body;
      const out = await submitScore({ name, time, moves });
      if (!out.ok) {
        // return 429 for rate_limited, 400 for others
        const status = out.code === 'rate_limited' ? 429 : 400;
        return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok:true }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Server error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
