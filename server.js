/**
 * Masters Pool 2026 — Server v3
 * Magic link email auth via Resend.com
 *
 * Required environment variable (set in Render dashboard):
 *   RESEND_API_KEY  — get free at resend.com
 *   FROM_EMAIL      — e.g. pool@yourdomain.com  (or onboarding@resend.dev for testing)
 *   SITE_URL        — your Render URL e.g. https://masters-pool-dbga.onrender.com
 *   COMMISH_PASSWORD — commissioner password (default: commish2026)
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const app     = express();

let fetchFn;
try { fetchFn = require('node-fetch'); if (fetchFn.default) fetchFn = fetchFn.default; }
catch { fetchFn = fetch; }

const PORT             = process.env.PORT || 3000;
const RESEND_API_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL       = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const SITE_URL         = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
const COMMISH_PASSWORD = process.env.COMMISH_PASSWORD || 'commish2026';
const MASTERS_ESPN_ID  = '401580359';

const POOL_FILE    = path.join(__dirname, 'pool-state.json');
const TOKENS_FILE  = path.join(__dirname, 'auth-tokens.json');
const USERS_FILE   = path.join(__dirname, 'users.json');

// ── Default pool ────────────────────────────────────────
const DEFAULT_POOL = {
  poolName: 'Masters Pool 2026',
  draftTime: '2026-04-08T19:00:00',
  picksPerPerson: 5,
  pickSeconds: 90,
  managers: [],   // [ { name, email } ]
  picks: [],
  draftStarted: false,
  draftComplete: false,
  currentPick: 0,
};

// ── File helpers ────────────────────────────────────────
function readJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return def;
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error(e.message); }
}

function loadPool()    { return readJSON(POOL_FILE,   { ...DEFAULT_POOL }); }
function savePool(p)   { writeJSON(POOL_FILE, p); }
function loadTokens()  { return readJSON(TOKENS_FILE, {}); }
function saveTokens(t) { writeJSON(TOKENS_FILE, t); }
function loadUsers()   { return readJSON(USERS_FILE,  {}); }
function saveUsers(u)  { writeJSON(USERS_FILE, u); }

// ── Middleware ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ── Draft order helper ──────────────────────────────────
function getDraftOrder(n, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const seq = r % 2 === 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    seq.forEach(i => order.push({ round: r + 1, managerIdx: i }));
  }
  return order;
}

// ── Safe pool (strip nothing — no passwords stored in pool anymore) ──
function safePool(pool) { return pool; }

// ═══════════════════════════════════════════════════════
// AUTH — MAGIC LINK
// ═══════════════════════════════════════════════════════

// POST /api/auth/request  — send magic link email
app.post('/api/auth/request', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  // Generate a token valid for 15 minutes
  const token  = crypto.randomBytes(32).toString('hex');
  const expiry  = Date.now() + 15 * 60 * 1000;
  const tokens  = loadTokens();
  tokens[token] = { email, expiry };
  saveTokens(tokens);

  const link = `${SITE_URL}/api/auth/verify?token=${token}`;

  // Look up user's name if they've logged in before
  const users    = loadUsers();
  const existing = users[email];
  const pool     = loadPool();
  const greeting = existing ? `Welcome back, ${existing.name}!` : `You've been invited to join ${pool.poolName}.`;

  // Send email via Resend
  if (!RESEND_API_KEY) {
    // Dev mode: just log the link
    console.log(`\n🔗 Magic link for ${email}:\n${link}\n`);
    return res.json({ ok: true, dev: true, link });
  }

  try {
    const emailRes = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to:   email,
        subject: `Your link to ${pool.poolName} ⛳`,
        html: `
          <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#152a15;color:#f0ead6;border-radius:12px;">
            <div style="text-align:center;margin-bottom:24px;">
              <div style="font-size:48px;">⛳</div>
              <h1 style="color:#c9a84c;font-size:22px;margin:8px 0 4px;letter-spacing:1px;">${pool.poolName}</h1>
              <p style="color:#b8af94;font-size:13px;margin:0;">2026 Augusta National</p>
            </div>
            <p style="font-size:15px;line-height:1.6;margin-bottom:24px;">${greeting}</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${link}" style="background:#c9a84c;color:#152a15;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:bold;display:inline-block;letter-spacing:.5px;">
                Join the Pool →
              </a>
            </div>
            <p style="font-size:12px;color:#b8af94;text-align:center;margin-top:24px;">
              This link expires in 15 minutes.<br>If you didn't request this, ignore this email.
            </p>
          </div>`,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send email. Check RESEND_API_KEY.' });
    }

    res.json({ ok: true });
  } catch(e) {
    console.error('Email send failed:', e.message);
    res.status(500).json({ error: 'Email send failed' });
  }
});

// GET /api/auth/verify?token=xxx  — validate token, redirect into app
app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  const tokens = loadTokens();
  const entry  = tokens[token];

  if (!entry || Date.now() > entry.expiry) {
    return res.send(`
      <html><body style="font-family:Georgia;background:#152a15;color:#f0ead6;text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">⛳</div>
        <h2 style="color:#c9a84c;">Link Expired</h2>
        <p style="color:#b8af94;">This magic link has expired or already been used.</p>
        <a href="/" style="color:#c9a84c;">Request a new link →</a>
      </body></html>`);
  }

  // Consume token
  delete tokens[token];
  saveTokens(tokens);

  const email = entry.email;
  const users = loadUsers();

  // If new user, create a session token and redirect to name-collection page
  // If existing user, create session and redirect to app
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

  users[email] = users[email] || { email, name: '', sessionTokens: [] };
  users[email].sessionTokens = users[email].sessionTokens || [];
  // Keep only last 5 sessions
  users[email].sessionTokens = users[email].sessionTokens.slice(-4);
  users[email].sessionTokens.push({ token: sessionToken, expiry: sessionExpiry });
  saveUsers(users);

  const isNew = !users[email].name;
  res.redirect(`/?session=${sessionToken}&email=${encodeURIComponent(email)}&new=${isNew ? '1' : '0'}`);
});

// POST /api/auth/session  — validate a session token (called on page load)
app.post('/api/auth/session', (req, res) => {
  const { sessionToken, email } = req.body;
  if (!sessionToken || !email) return res.status(401).json({ error: 'No session' });

  const users = loadUsers();
  const user  = users[email.toLowerCase()];
  if (!user) return res.status(401).json({ error: 'User not found' });

  const sess = (user.sessionTokens || []).find(s => s.token === sessionToken && Date.now() < s.expiry);
  if (!sess) return res.status(401).json({ error: 'Session expired' });

  const pool = loadPool();
  res.json({ ok: true, name: user.name, email: user.email, pool: safePool(pool) });
});

// POST /api/auth/setname  — called after first login to set display name
app.post('/api/auth/setname', (req, res) => {
  const { sessionToken, email, name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const users = loadUsers();
  const user  = users[email?.toLowerCase()];
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const sess = (user.sessionTokens || []).find(s => s.token === sessionToken && Date.now() < s.expiry);
  if (!sess) return res.status(401).json({ error: 'Session expired' });

  user.name = name.trim();
  saveUsers(users);

  // Add to pool managers if not already there
  const pool = loadPool();
  const mgr  = pool.managers.find(m => m.email === email);
  if (!mgr) {
    pool.managers.push({ name: user.name, email });
    savePool(pool);
  } else if (mgr.name !== user.name) {
    mgr.name = user.name;
    savePool(pool);
  }

  res.json({ ok: true, name: user.name, pool: safePool(pool) });
});

// ═══════════════════════════════════════════════════════
// COMMISSIONER AUTH
// ═══════════════════════════════════════════════════════
app.post('/api/pool/commish', (req, res) => {
  if (req.body.password !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Wrong commissioner password' });
  const pool = loadPool();
  res.json({ ok: true, isCommish: true, pool: safePool(pool) });
});

// ═══════════════════════════════════════════════════════
// POOL API
// ═══════════════════════════════════════════════════════
app.get('/api/pool', (req, res) => res.json(safePool(loadPool())));

function requireCommish(req, res) {
  if (req.body.commishPassword !== COMMISH_PASSWORD) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.post('/api/pool/managers', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.managers = req.body.managers; // array of { name, email }
  savePool(pool);
  res.json({ ok: true, pool: safePool(pool) });
});

app.post('/api/pool/settings', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  const { poolName, draftTime, picksPerPerson, pickSeconds } = req.body;
  if (poolName)       pool.poolName       = poolName;
  if (draftTime)      pool.draftTime      = draftTime;
  if (picksPerPerson) pool.picksPerPerson = parseInt(picksPerPerson);
  if (pickSeconds)    pool.pickSeconds    = parseInt(pickSeconds);
  savePool(pool);
  res.json({ ok: true });
});

app.post('/api/pool/start', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.draftStarted = true;
  savePool(pool);
  res.json({ ok: true, pool: safePool(pool) });
});

app.post('/api/pool/reset', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.picks = []; pool.currentPick = 0; pool.draftStarted = false; pool.draftComplete = false;
  savePool(pool);
  res.json({ ok: true, pool: safePool(pool) });
});

// Commissioner: remove a manager
app.post('/api/pool/remove-manager', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  const email = req.body.email;
  pool.managers = pool.managers.filter(m => m.email !== email);
  savePool(pool);
  res.json({ ok: true, pool: safePool(pool) });
});

// Submit a pick — identified by session token
app.post('/api/pool/pick', (req, res) => {
  const { sessionToken, email, golfer } = req.body;

  const users = loadUsers();
  const user  = users[email?.toLowerCase()];
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const sess = (user.sessionTokens || []).find(s => s.token === sessionToken && Date.now() < s.expiry);
  if (!sess) return res.status(401).json({ error: 'Session expired' });

  const pool = loadPool();
  if (!pool.draftStarted || pool.draftComplete) return res.status(400).json({ error: 'Draft not active' });

  const order = getDraftOrder(pool.managers.length, pool.picksPerPerson);
  const current = order[pool.currentPick];
  if (!current) return res.status(400).json({ error: 'Draft complete' });

  const managerIdx = pool.managers.findIndex(m => m.email === email.toLowerCase());
  if (managerIdx !== current.managerIdx) return res.status(403).json({ error: "Not your turn" });
  if (pool.picks.find(p => p.golfer === golfer)) return res.status(400).json({ error: 'Already picked' });

  pool.picks.push({ round: current.round, pick: pool.currentPick + 1, managerIdx, golfer, pickedBy: user.name, ts: new Date().toISOString() });
  pool.currentPick++;
  if (pool.currentPick >= order.length) pool.draftComplete = true;
  savePool(pool);
  res.json({ ok: true, pool: safePool(pool) });
});

// ═══════════════════════════════════════════════════════
// ESPN SCORES PROXY
// ═══════════════════════════════════════════════════════
let scoreCache = { data: null, ts: 0 };
app.get('/api/scores', async (req, res) => {
  if (scoreCache.data && Date.now() - scoreCache.ts < 60000) return res.json(scoreCache.data);
  try {
    const data = await fetchESPNScores();
    scoreCache = { data, ts: Date.now() };
    res.json(data);
  } catch(err) {
    if (scoreCache.data) return res.json({ ...scoreCache.data, _stale: true });
    res.status(503).json({ error: 'Scores unavailable' });
  }
});

async function fetchESPNScores() {
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${MASTERS_ESPN_ID}`,
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga`,
  ];
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) return normalizeESPN(await r.json());
    } catch {}
  }
  throw new Error('ESPN unavailable');
}
function normalizeESPN(raw) {
  const event = raw?.events?.[0] || {};
  const comp  = event?.competitions?.[0] || {};
  const leaderboard = (comp?.competitors || []).map(c => ({
    name: c?.athlete?.displayName || '', toPar: parseScore(c?.score),
    thru: c?.status?.thru || '', status: c?.status?.type?.description || '',
  })).sort((a, b) => a.toPar - b.toPar);
  return { tournament: event?.name || 'Masters Tournament', round: comp?.status?.type?.shortDetail || '', status: comp?.status?.type?.description || 'Scheduled', leaderboard, fetchedAt: new Date().toISOString() };
}
function parseScore(s) { if (!s || s === 'E') return 0; const n = parseInt(s, 10); return isNaN(n) ? 0 : n; }

// ── Catch-all ────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`\n⛳  Masters Pool 2026 → http://localhost:${PORT}\n`));
