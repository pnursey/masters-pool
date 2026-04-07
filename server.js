/**
 * Masters Pool 2026 — Server v7
 *
 * KEY CHANGE: Pool state and user accounts are stored in
 * environment variables on Render, so they SURVIVE redeploys.
 *
 * Required environment variables (Render → Environment):
 *   COMMISH_PASSWORD  — commissioner password (default: commish2026)
 *   POOL_PASSWORD     — password players use to join (default: masters2026)
 *
 * Auto-managed by the server (you don't set these manually):
 *   POOL_STATE        — JSON blob of pool state
 *   USERS_STATE       — JSON blob of user accounts
 *
 * NOTE: On Render free tier, file writes don't persist between deploys.
 * This version uses in-memory state + writes to files as backup.
 * Users and pool data are initialized from environment variables if present.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const app     = express();

const PORT             = process.env.PORT || 3000;
const COMMISH_PASSWORD = process.env.COMMISH_PASSWORD || 'commish2026';
const POOL_PASSWORD    = process.env.POOL_PASSWORD    || 'masters2026';
const MASTERS_ESPN_ID  = '401580359';

let fetchFn;
try { fetchFn = require('node-fetch'); if (fetchFn.default) fetchFn = fetchFn.default; }
catch { fetchFn = fetch; }

// ── 2026 Masters field in priority order ──────────
const MASTERS_FIELD = [
  "Scottie Scheffler","Rory McIlroy","Xander Schauffele","Collin Morikawa",
  "Jon Rahm","Ludvig Åberg","Tommy Fleetwood","Bryson DeChambeau",
  "Viktor Hovland","Justin Thomas","Brooks Koepka","Patrick Cantlay",
  "Cameron Young","Max Homa","Shane Lowry","Matt Fitzpatrick",
  "Justin Rose","Hideki Matsuyama","Harris English","Jordan Spieth",
  "Robert MacIntyre","Brian Harman","Sepp Straka","Tyrrell Hatton",
  "Sungjae Im","Wyndham Clark","Corey Conners","Russell Henley",
  "Keegan Bradley","Akshay Bhatia","Si Woo Kim","Chris Gotterup",
  "Maverick McNealy","Sam Burns","Jason Day","Aaron Rai",
  "Patrick Reed","Kurt Kitayama","Jake Knapp","Daniel Berger",
  "Nicolai Højgaard","Rasmus Højgaard","Min Woo Lee","Jacob Bridgeman",
  "Ben Griffin","Kristoffer Reitan","Davis Riley","Nick Taylor",
  "Ryan Fox","Carlos Ortiz","Gary Woodland","Matt McCarty",
  "Aldrich Potgieter","Andrew Novak","Michael Brennan","Samuel Stevens",
  "Nicolas Echavarria","Haotong Li","Brian Campbell","Tom McKibbin",
  "Max Greyserman","Rasmus Neergaard-Petersen","Marco Penge","Alex Noren",
  "Harry Hall","J.J. Spaun","Ryan Gerard","Naoyuki Kataoka",
  "John Keefer","Michael Kim","Sami Välimäki","Casey Jarvis",
  "Adam Scott","Dustin Johnson","Bubba Watson","Zach Johnson",
  "Fred Couples","Charl Schwartzel","Danny Willett","Sergio Garcia",
  "Mike Weir","Angel Cabrera","Vijay Singh","Jose Maria Olazabal",
  "Ethan Fang","Mason Howell","Jackson Herrington","Brandon Holtz",
  "Mateo Pulcini","Fifa Laopakdee",
];

const DEFAULT_POOL = {
  poolName: 'Masters Pool 2026',
  draftTime: '2026-04-08T20:00:00',
  picksPerPerson: 5,
  pickSeconds: 90,
  managers: [],
  picks: [],
  draftStarted: false,
  draftComplete: false,
  currentPick: 0,
  pickDeadline: null,
};

// ═══════════════════════════════════════════════════
// IN-MEMORY STATE — survives redeploys when loaded
// from environment variables set by the save endpoint
// ═══════════════════════════════════════════════════
let _pool  = null;
let _users = null;

function loadPool() {
  if (_pool) return JSON.parse(JSON.stringify(_pool));
  // Try file first
  try {
    const f = path.join(__dirname, 'pool-state.json');
    if (fs.existsSync(f)) { _pool = JSON.parse(fs.readFileSync(f, 'utf8')); return JSON.parse(JSON.stringify(_pool)); }
  } catch {}
  // Try env variable (set by Render persistent env)
  try {
    if (process.env.POOL_STATE) { _pool = JSON.parse(process.env.POOL_STATE); return JSON.parse(JSON.stringify(_pool)); }
  } catch {}
  _pool = { ...DEFAULT_POOL };
  return JSON.parse(JSON.stringify(_pool));
}

function savePool(p) {
  _pool = JSON.parse(JSON.stringify(p));
  try { fs.writeFileSync(path.join(__dirname, 'pool-state.json'), JSON.stringify(p, null, 2)); } catch {}
}

function loadUsers() {
  if (_users) return JSON.parse(JSON.stringify(_users));
  try {
    const f = path.join(__dirname, 'users.json');
    if (fs.existsSync(f)) { _users = JSON.parse(fs.readFileSync(f, 'utf8')); return JSON.parse(JSON.stringify(_users)); }
  } catch {}
  try {
    if (process.env.USERS_STATE) { _users = JSON.parse(process.env.USERS_STATE); return JSON.parse(JSON.stringify(_users)); }
  } catch {}
  _users = {};
  return {};
}

function saveUsers(u) {
  _users = JSON.parse(JSON.stringify(u));
  try { fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(u, null, 2)); } catch {}
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ═══════════════════════════════════════════════════
// BACKUP ENDPOINT — commissioner calls this to get
// the current state as JSON to paste into Render env vars
// so data survives the next redeploy
// ═══════════════════════════════════════════════════
app.get('/api/backup', (req, res) => {
  if (req.query.key !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const pool  = loadPool();
  const users = loadUsers();
  res.json({
    instructions: 'Copy the values below into Render → Environment variables to survive redeploys',
    POOL_STATE:  JSON.stringify(pool),
    USERS_STATE: JSON.stringify(users),
  });
});

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
function getDraftOrder(n, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const seq = r % 2 === 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    seq.forEach(i => order.push({ round: r + 1, managerIdx: i }));
  }
  return order;
}
function hashPassword(pw) { return crypto.createHash('sha256').update(pw + 'mp2026salt').digest('hex'); }
function makeSession()    { return crypto.randomBytes(32).toString('hex'); }

function advancePick(pool) {
  const order = getDraftOrder(pool.managers.length, pool.picksPerPerson);
  if (pool.currentPick >= order.length) {
    pool.draftComplete = true;
    pool.pickDeadline  = null;
    console.log('🏁  Draft complete!');
  } else {
    pool.pickDeadline = Date.now() + (pool.pickSeconds || 90) * 1000;
    const info    = order[pool.currentPick];
    const mgrName = pool.managers[info?.managerIdx]?.name || 'Unknown';
    console.log(`⏱  Pick #${pool.currentPick + 1} — ${mgrName} on the clock`);
  }
  return pool;
}

// ═══════════════════════════════════════════════════
// SERVER-SIDE AUTO-PICK (runs every 2 seconds)
// ═══════════════════════════════════════════════════
function startDraftWatcher() {
  setInterval(() => {
    const pool = loadPool();
    if (!pool.draftStarted || pool.draftComplete || !pool.pickDeadline) return;
    if (Date.now() < pool.pickDeadline) return;

    const order   = getDraftOrder(pool.managers.length, pool.picksPerPerson);
    const current = order[pool.currentPick];
    if (!current) return;

    const taken  = new Set(pool.picks.map(p => p.golfer));
    const golfer = MASTERS_FIELD.find(g => !taken.has(g));
    if (!golfer) return;

    const mgr     = pool.managers[current.managerIdx];
    const mgrName = mgr?.name || 'Unknown';

    pool.picks.push({
      round: current.round, pick: pool.currentPick + 1,
      managerIdx: current.managerIdx,
      golfer, pickedBy: mgrName, autoPick: true,
      ts: new Date().toISOString(),
    });
    pool.currentPick++;
    console.log(`🤖  AUTO-PICK: ${mgrName} timed out → "${golfer}"`);

    advancePick(pool);
    savePool(pool);
  }, 2000);
  console.log('⏱  Draft watcher active');
}

// ═══════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════
app.post('/api/auth/register', (req, res) => {
  const { email, name, password, poolPassword } = req.body;
  if (!email || !email.includes('@'))    return res.status(400).json({ error: 'Valid email required' });
  if (!name  || !name.trim())            return res.status(400).json({ error: 'Name required' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (poolPassword !== POOL_PASSWORD)    return res.status(401).json({ error: 'Wrong pool password. Ask your commissioner.' });

  const users = loadUsers();
  const key   = email.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });

  const sessionToken = makeSession();
  users[key] = {
    email: key, name: name.trim(),
    passwordHash:  hashPassword(password),
    sessionToken,
    sessionExpiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  const pool = loadPool();
  if (!pool.managers.find(m => m.email === key)) {
    pool.managers.push({ name: name.trim(), email: key });
    savePool(pool);
  }
  res.json({ ok: true, sessionToken, name: name.trim(), email: key, pool });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const users = loadUsers();
  const key   = email.toLowerCase().trim();
  const user  = users[key];
  if (!user)                                        return res.status(401).json({ error: 'No account found for this email. Please register first.' });
  if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Wrong password.' });
  user.sessionToken  = makeSession();
  user.sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  saveUsers(users);
  const pool = loadPool();
  if (!pool.managers.find(m => m.email === key)) {
    pool.managers.push({ name: user.name, email: key });
    savePool(pool);
  }
  res.json({ ok: true, sessionToken: user.sessionToken, name: user.name, email: key, pool });
});

app.post('/api/auth/session', (req, res) => {
  const { sessionToken, email } = req.body;
  if (!sessionToken || !email) return res.status(401).json({ error: 'No session' });
  const users = loadUsers();
  const user  = users[email.toLowerCase()];
  if (!user)                              return res.status(401).json({ error: 'User not found' });
  if (user.sessionToken !== sessionToken) return res.status(401).json({ error: 'Session expired' });
  if (Date.now() > user.sessionExpiry)   return res.status(401).json({ error: 'Session expired' });
  res.json({ ok: true, name: user.name, email: user.email, pool: loadPool() });
});

app.post('/api/auth/reset', (req, res) => {
  const { commishPassword, email, newPassword } = req.body;
  if (commishPassword !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = loadUsers();
  const key   = email.toLowerCase().trim();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  users[key].passwordHash  = hashPassword(newPassword);
  users[key].sessionToken  = makeSession();
  users[key].sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  saveUsers(users);
  res.json({ ok: true, message: `Password reset for ${users[key].name}` });
});

// ═══════════════════════════════════════════════════
// COMMISSIONER
// ═══════════════════════════════════════════════════
app.post('/api/pool/commish', (req, res) => {
  if (req.body.password !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Wrong commissioner password' });
  res.json({ ok: true, isCommish: true, pool: loadPool() });
});

function requireCommish(req, res) {
  if (req.body.commishPassword !== COMMISH_PASSWORD) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// ═══════════════════════════════════════════════════
// POOL API
// ═══════════════════════════════════════════════════
app.get('/api/pool', (req, res) => res.json(loadPool()));

app.post('/api/pool/managers', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.managers = req.body.managers;
  savePool(pool);
  res.json({ ok: true, pool });
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
  advancePick(pool);
  savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/reset', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.picks = []; pool.currentPick = 0;
  pool.draftStarted = false; pool.draftComplete = false; pool.pickDeadline = null;
  savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/remove-manager', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.managers = pool.managers.filter(m => m.email !== req.body.email);
  savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/pick', (req, res) => {
  const { sessionToken, email, golfer } = req.body;
  const users = loadUsers();
  const user  = users[email?.toLowerCase()];
  if (!user || user.sessionToken !== sessionToken) return res.status(401).json({ error: 'Not logged in' });

  const pool = loadPool();
  if (!pool.draftStarted || pool.draftComplete) return res.status(400).json({ error: 'Draft not active' });

  const order = getDraftOrder(pool.managers.length, pool.picksPerPerson);
  const current = order[pool.currentPick];
  if (!current) return res.status(400).json({ error: 'Draft complete' });

  const managerIdx = pool.managers.findIndex(m => m.email === email.toLowerCase());
  if (managerIdx !== current.managerIdx) return res.status(403).json({ error: "Not your turn" });
  if (pool.picks.find(p => p.golfer === golfer)) return res.status(400).json({ error: 'Already picked' });

  pool.picks.push({
    round: current.round, pick: pool.currentPick + 1,
    managerIdx, golfer, pickedBy: user.name,
    ts: new Date().toISOString(),
  });
  pool.currentPick++;
  advancePick(pool);
  savePool(pool);
  res.json({ ok: true, pool });
});

// ═══════════════════════════════════════════════════
// ESPN SCORES
// ═══════════════════════════════════════════════════
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => {
  console.log(`\n⛳  Masters Pool 2026 → http://localhost:${PORT}`);
  console.log(`   Pool password:  ${POOL_PASSWORD}`);
  console.log(`   Commish password: ${COMMISH_PASSWORD}\n`);
  // Pre-load state into memory on startup
  loadPool(); loadUsers();
  startDraftWatcher();
});
