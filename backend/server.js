import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DB_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !DB_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

function getCorsOrigin(reqOrigin) {
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  if (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) return reqOrigin;
  return ALLOWED_ORIGINS[0] || '*';
}

function withCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, payload, origin) {
  withCors(res, origin);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBearer(req) {
  const raw = req.headers.authorization || '';
  if (!raw.startsWith('Bearer ')) return null;
  return raw.slice(7).trim() || null;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const body = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(body);
}

async function verifySupabaseUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabaseRest(path, opts = {}) {
  const method = opts.method || 'GET';
  const headers = {
    apikey: DB_KEY,
    Authorization: `Bearer ${DB_KEY}`,
    ...opts.headers
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: opts.body
  });
  return res;
}

function toIsoDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function calcStreakFromXpData(xpData) {
  let streak = 0;
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const day = toIsoDay(d);
    const pts = Number(xpData[day] || 0);
    if (pts > 0) streak += 1;
    else if (i > 0) break;
  }
  return streak;
}

function totalXpFromData(xpData) {
  return Object.values(xpData).reduce((sum, v) => sum + Number(v || 0), 0);
}

async function getProfile(user) {
  const select = 'id,username,email,xp_data,xp_total,streak';
  const path = `/profiles?id=eq.${encodeURIComponent(user.id)}&select=${encodeURIComponent(select)}&limit=1`;
  const res = await supabaseRest(path);
  if (!res.ok) throw new Error(`profile read failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] || {
    id: user.id,
    username: user.user_metadata?.username || user.email?.split('@')[0] || 'user',
    email: user.email || '',
    xp_data: {},
    xp_total: 0,
    streak: 0
  };
}

async function upsertProfile(profile) {
  const payload = [{
    id: profile.id,
    username: profile.username,
    email: profile.email,
    xp_data: profile.xp_data,
    xp_total: profile.xp_total,
    streak: profile.streak,
    updated_at: new Date().toISOString()
  }];
  const res = await supabaseRest('/profiles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`profile upsert failed: ${res.status} ${err}`);
  }
  const rows = await res.json();
  return rows[0] || profile;
}

async function insertXpEvent(event) {
  const res = await supabaseRest('/xp_events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify([event])
  });
  if (res.ok) return { ok: true };
  const err = await res.text();
  if (res.status === 409 || err.includes('duplicate key value violates unique constraint')) {
    return { ok: false, duplicate: true };
  }
  throw new Error(`xp event insert failed: ${res.status} ${err}`);
}

const server = http.createServer(async (req, res) => {
  const origin = getCorsOrigin(req.headers.origin || '');
  if (req.method === 'OPTIONS') {
    withCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'vocabflow-backend' }, origin);
      return;
    }

    if (url.pathname === '/api/xp/summary') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' }, origin);
        return;
      }
      const token = parseBearer(req);
      if (!token) {
        sendJson(res, 401, { error: 'Missing bearer token' }, origin);
        return;
      }
      const user = await verifySupabaseUser(token);
      if (!user) {
        sendJson(res, 401, { error: 'Invalid token' }, origin);
        return;
      }
      const profile = await getProfile(user);
      sendJson(res, 200, {
        xp_data: profile.xp_data || {},
        xp_total: Number(profile.xp_total || 0),
        streak: Number(profile.streak || 0)
      }, origin);
      return;
    }

    if (url.pathname === '/api/xp/events') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' }, origin);
        return;
      }
      const token = parseBearer(req);
      if (!token) {
        sendJson(res, 401, { error: 'Missing bearer token' }, origin);
        return;
      }
      const user = await verifySupabaseUser(token);
      if (!user) {
        sendJson(res, 401, { error: 'Invalid token' }, origin);
        return;
      }

      const body = await readJson(req);
      const points = Number(body.points || 0);
      const clientEventId = String(body.clientEventId || '').trim();
      const reason = String(body.reason || 'learn').slice(0, 40);
      if (!Number.isFinite(points) || points <= 0 || points > 50) {
        sendJson(res, 400, { error: 'points must be between 1 and 50' }, origin);
        return;
      }
      if (!clientEventId || clientEventId.length > 120) {
        sendJson(res, 400, { error: 'clientEventId required (max 120 chars)' }, origin);
        return;
      }

      const profile = await getProfile(user);
      const insert = await insertXpEvent({
        user_id: user.id,
        client_event_id: clientEventId,
        points,
        reason,
        created_at: new Date().toISOString()
      });

      if (!insert.ok && insert.duplicate) {
        sendJson(res, 200, {
          xp_data: profile.xp_data || {},
          xp_total: Number(profile.xp_total || 0),
          streak: Number(profile.streak || 0),
          duplicate: true
        }, origin);
        return;
      }

      const xpData = { ...(profile.xp_data || {}) };
      const today = toIsoDay();
      xpData[today] = Number(xpData[today] || 0) + points;
      const nextProfile = {
        ...profile,
        email: profile.email || user.email || '',
        xp_data: xpData,
        xp_total: totalXpFromData(xpData),
        streak: calcStreakFromXpData(xpData)
      };
      const saved = await upsertProfile(nextProfile);
      sendJson(res, 200, {
        xp_data: saved.xp_data || {},
        xp_total: Number(saved.xp_total || 0),
        streak: Number(saved.streak || 0)
      }, origin);
      return;
    }

    sendJson(res, 404, { error: 'Not found' }, origin);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal error' }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`VocabFlow backend running on :${PORT}`);
});
