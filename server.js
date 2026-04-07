/**
 * Masters Pool 2026 — Server v6
 * Adds server-side auto-pick timer.
 * If a player's clock runs out server-side, the best available
 * golfer is automatically drafted for them — even if they're offline.
 *
 * Environment variables (set in Render → Environment):
 *   COMMISH_PASSWORD  — commissioner password (default: commish2026)
 *   POOL_PASSWORD     — shared password everyone uses to join (default: masters2026)
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

const POOL_FILE  = path.join(__dirname, 'pool-state.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// ── 2026 Masters field in draft priority order ──────
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

// ── Default pool ─────────────────────────────────────
const DEFAULT_POOL = {
  poolName: 'Masters Pool 2026',
  draftTime: '2026-04-08T19:00:00',
  picksPerPerson: 5,
  pickSeconds: 90,
  managers: [],
  picks: [],
  draftStarted: false,
  draftComplete: false,
  currentPick: 0,
  pickDeadline: null,  // timestamp: when current pick expires
};

// ── File helpers ─────────────────────────────────────
function readJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return def;
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error(e.message); }
}
function loadPool()   { return readJSON(POOL_FILE,  { ...DEFAULT_POOL }); }
function savePool(p)  { writeJSON(POOL_FILE, p); }
function loadUsers()  { return readJSON(USERS_FILE, {}); }
function saveUsers(u) { writeJSON(USERS_FILE, u); }

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ── Helpers ──────────────────────────────────────────
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

// Advance pick and set new deadline — called after every pick (real or auto)
function advancePick(pool) {
  const order = getDraftOrder(pool.managers.length, pool.picksPerPerson);
  if (pool.currentPick >= order.length) {
    pool.draftComplete = true;
    pool.pickDeadline  = null;
  } else {
    pool.pickDeadline = Date.now() + (pool.pickSeconds || 90) * 1000;
    const info    = order[pool.currentPick];
    const mgrName = pool.managers[info.managerIdx]?.name || 'Unknown';
    console.log(`⏱  Pick #${pool.currentPick + 1} — ${mgrName} on the clock until ${new Date(pool.pickDeadline).toLocaleTimeString()}`);
  }
  return pool;
}

// ═══════════════════════════════════════════════════
// SERVER-SIDE AUTO-PICK WATCHER
// Runs every 2 seconds. If pickDeadline has passed and
// the draft is still active, auto-picks best available golfer.
// ═══════════════════════════════════════════════════
function startDraftWatcher() {
  setInterval(() => {
    const pool = loadPool();
    if (!pool.draftStarted || pool.draftComplete) return;
    if (!pool.pickDeadline) return;
    if (Date.now() < pool.pickDeadline) return;

    // Deadline passed — auto-pick
    const order   = getDraftOrder(pool.managers.length, pool.picksPerPerson);
    const current = order[pool.currentPick];
    if (!current) return;

    const taken  = new Set(pool.picks.map(p => p.golfer));
    const golfer = MASTERS_FIELD.find(g => !taken.has(g));
    if (!golfer) return;

    const mgr     = pool.managers[current.managerIdx];
    const mgrName = mgr?.name || mgr || 'Unknown';

    pool.picks.push({
      round:      current.round,
      pick:       pool.currentPick + 1,
      managerIdx: current.managerIdx,
      golfer,
      pickedBy:   mgrName,
      autoPick:   true,
      ts:         new Date().toISOString(),
    });
    pool.currentPick++;
    console.log(`🤖  AUTO-PICK: ${mgrName} timed out → "${golfer}" (pick #${pool.currentPick})`);

    advancePick(pool);
    savePool(pool);
  }, 2000);
  console.log('⏱  Server-side draft timer active');
}

// ═══════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/auth/register', (req, res) => {
  const { email, name, password, poolPassword } = req.body;
  if (!email || !email.includes('@'))     return res.status(400).json({ error: 'Valid email required' });
  if (!name  || !name.trim())             return res.status(400).json({ error: 'Name required' });
  if (!password || password.length < 4)  return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (poolPassword !== POOL_PASSWORD)     return res.status(401).json({ error: 'Wrong pool password. Ask your commissioner.' });

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
  if (!user) return res.status(401).json({ error: 'No account found for this email. Please register first.' });
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
  const pool = loadPool();
  res.json({ ok: true, name: user.name, email: user.email, pool });
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
  advancePick(pool); // set first pick deadline immediately
  savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/reset', (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = loadPool();
  pool.picks = []; pool.currentPick = 0;
  pool.draftStarted = false; pool.draftComplete = false;
  pool.pickDeadline = null;
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

// Submit a pick
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

  advancePick(pool); // set deadline for next pick immediately
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

// ── Start ─────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => {
  console.log(`\n⛳  Masters Pool 2026 → http://localhost:${PORT}`);
  startDraftWatcher();
});
