/**
 * Golf Pool 2026 — PGA Championship Edition
 * Persistent storage via Turso (SQLite cloud database)
 * Data survives Render restarts, redeploys, everything.
 *
 * Required Render Environment Variables:
 *   TURSO_URL          — from Turso dashboard (libsql://your-db.turso.io)
 *   TURSO_TOKEN        — auth token from Turso dashboard
 *   COMMISH_PASSWORD   — your commissioner password (default: commish2026)
 *   POOL_PASSWORD      — shared password for players (default: pga2026)
 */

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const app     = express();

const PORT             = process.env.PORT || 3000;
const COMMISH_PASSWORD = process.env.COMMISH_PASSWORD || 'commish2026';
const POOL_PASSWORD    = process.env.POOL_PASSWORD    || 'pga2026';
const PGA_ESPN_ID      = '401811947'; // 2026 PGA Championship at Aronimink - confirmed // 2026 PGA Championship ESPN event ID

let fetchFn;
try { fetchFn = require('node-fetch'); if (fetchFn.default) fetchFn = fetchFn.default; }
catch { fetchFn = fetch; }

// ── PGA Championship 2026 field in draft priority order ──
const PGA_FIELD = [
  "Scottie Scheffler","Rory McIlroy","Xander Schauffele","Collin Morikawa",
  "Jon Rahm","Ludvig Åberg","Tommy Fleetwood","Bryson DeChambeau",
  "Viktor Hovland","Justin Thomas","Brooks Koepka","Patrick Cantlay",
  "Cameron Young","Matt Fitzpatrick","Shane Lowry","Justin Rose",
  "Hideki Matsuyama","Harris English","Jordan Spieth","Robert MacIntyre",
  "Brian Harman","Sepp Straka","Tyrrell Hatton","Sungjae Im",
  "Wyndham Clark","Corey Conners","Russell Henley","Keegan Bradley",
  "Akshay Bhatia","Si Woo Kim","Chris Gotterup","Maverick McNealy",
  "Sam Burns","Jason Day","Aaron Rai","Patrick Reed",
  "Kurt Kitayama","Jake Knapp","Daniel Berger","Nicolai Højgaard",
  "Rasmus Højgaard","Min Woo Lee","Jacob Bridgeman","Ben Griffin",
  "Kristoffer Reitan","Davis Riley","Nick Taylor","Ryan Fox",
  "Carlos Ortiz","Matt McCarty","Aldrich Potgieter","Andrew Novak",
  "Michael Brennan","Samuel Stevens","Nicolas Echavarria","Haotong Li",
  "Brian Campbell","Tom McKibbin","Max Greyserman","Alex Noren",
  "Harry Hall","J.J. Spaun","Ryan Gerard","Naoyuki Kataoka",
  "Michael Kim","Sami Välimäki","Casey Jarvis","Adam Scott",
  "Dustin Johnson","Bubba Watson","Zach Johnson","Stewart Cink",
  "Jason Dufner","Luke Donald","Brandt Snedeker","Max Homa",
  "Thomas Detry","David Puig","Elvis Smylie","Pierceson Coody",
  "Angel Ayora","Derek Berg","Chandler Blanchet","Tyler Collet",
  "Jesse Droemer","Bryce Fisher","Steven Fisk","Ricky Castillo",
];

const DEFAULT_POOL = {
  poolName: 'PGA Championship Pool 2026',
  tournamentName: 'PGA Championship',
  venue: 'Aronimink Golf Club · Newtown Square, PA',
  draftTime: '2026-05-13T20:00:00',
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
// TURSO DATABASE — persistent cloud SQLite
// Falls back to in-memory if Turso not configured
// ═══════════════════════════════════════════════════
let db = null;
let _memPool  = { ...DEFAULT_POOL };
let _memUsers = {};

async function initDB() {
  const url   = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;

  if (!url || !token) {
    console.log('⚠  No TURSO_URL/TURSO_TOKEN set — using in-memory storage (data will not persist restarts)');
    return;
  }

  try {
    const { createClient } = require('@libsql/client');
    db = createClient({ url, authToken: token });

    // Create tables if they don't exist
    await db.execute(`CREATE TABLE IF NOT EXISTS pool (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT NOT NULL
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT NOT NULL
    )`);

    // Seed defaults if empty
    const poolRow = await db.execute('SELECT data FROM pool WHERE id=1');
    if (poolRow.rows.length === 0) {
      await db.execute({ sql: 'INSERT INTO pool (id, data) VALUES (1, ?)', args: [JSON.stringify(DEFAULT_POOL)] });
    }
    const usersRow = await db.execute('SELECT data FROM users WHERE id=1');
    if (usersRow.rows.length === 0) {
      await db.execute({ sql: 'INSERT INTO users (id, data) VALUES (1, ?)', args: ['{}'] });
    }

    console.log('✅  Turso database connected — data will persist restarts');
  } catch(e) {
    console.error('Turso init failed:', e.message);
    console.log('⚠  Falling back to in-memory storage');
    db = null;
  }
}

async function loadPool() {
  if (!db) return JSON.parse(JSON.stringify(_memPool));
  try {
    const r = await db.execute('SELECT data FROM pool WHERE id=1');
    if (r.rows.length) return JSON.parse(r.rows[0].data);
  } catch(e) { console.error('loadPool:', e.message); }
  return JSON.parse(JSON.stringify(_memPool));
}

async function savePool(p) {
  _memPool = JSON.parse(JSON.stringify(p));
  if (!db) return;
  try {
    await db.execute({ sql: 'UPDATE pool SET data=? WHERE id=1', args: [JSON.stringify(p)] });
  } catch(e) { console.error('savePool:', e.message); }
}

async function loadUsers() {
  if (!db) return JSON.parse(JSON.stringify(_memUsers));
  try {
    const r = await db.execute('SELECT data FROM users WHERE id=1');
    if (r.rows.length) return JSON.parse(r.rows[0].data);
  } catch(e) { console.error('loadUsers:', e.message); }
  return JSON.parse(JSON.stringify(_memUsers));
}

async function saveUsers(u) {
  _memUsers = JSON.parse(JSON.stringify(u));
  if (!db) return;
  try {
    await db.execute({ sql: 'UPDATE users SET data=? WHERE id=1', args: [JSON.stringify(u)] });
  } catch(e) { console.error('saveUsers:', e.message); }
}

// ── Helpers ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

function getDraftOrder(n, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const seq = r % 2 === 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    seq.forEach(i => order.push({ round: r + 1, managerIdx: i }));
  }
  return order;
}
function hashPassword(pw) { return crypto.createHash('sha256').update(pw + 'gp2026salt').digest('hex'); }
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

function requireCommish(req, res) {
  if (req.body.commishPassword !== COMMISH_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized' }); return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════
// SERVER-SIDE AUTO-PICK WATCHER
// ═══════════════════════════════════════════════════
function startDraftWatcher() {
  setInterval(async () => {
    try {
      const pool = await loadPool();
      if (!pool.draftStarted || pool.draftComplete || !pool.pickDeadline) return;
      if (Date.now() < pool.pickDeadline) return;

      const order   = getDraftOrder(pool.managers.length, pool.picksPerPerson);
      const current = order[pool.currentPick];
      if (!current) return;

      const taken  = new Set(pool.picks.map(p => p.golfer));
      const golfer = PGA_FIELD.find(g => !taken.has(g));
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
      console.log(`🤖  AUTO-PICK: ${mgrName} timed out → "${golfer}" (pick #${pool.currentPick})`);

      advancePick(pool);
      await savePool(pool);
    } catch(e) { console.error('Watcher error:', e.message); }
  }, 2000);
  console.log('⏱  Draft watcher active');
}

// ═══════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { email, name, password, poolPassword } = req.body;
  if (!email || !email.includes('@'))    return res.status(400).json({ error: 'Valid email required' });
  if (!name  || !name.trim())            return res.status(400).json({ error: 'Name required' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (poolPassword !== POOL_PASSWORD)    return res.status(401).json({ error: 'Wrong pool password. Ask your commissioner.' });

  const users = await loadUsers();
  const key   = email.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Account already exists. Please sign in instead.' });

  const sessionToken = makeSession();
  users[key] = {
    email: key, name: name.trim(),
    passwordHash:  hashPassword(password),
    sessionToken,
    sessionExpiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
    createdAt: new Date().toISOString(),
  };
  await saveUsers(users);

  const pool = await loadPool();
  if (!pool.managers.find(m => m.email === key)) {
    pool.managers.push({ name: name.trim(), email: key });
    await savePool(pool);
  }
  res.json({ ok: true, sessionToken, name: name.trim(), email: key, pool });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const users = await loadUsers();
  const key   = email.toLowerCase().trim();
  const user  = users[key];
  if (!user)                                        return res.status(401).json({ error: 'No account found. Please register first.' });
  if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Wrong password.' });
  user.sessionToken  = makeSession();
  user.sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await saveUsers(users);
  const pool = await loadPool();
  if (!pool.managers.find(m => m.email === key)) {
    pool.managers.push({ name: user.name, email: key });
    await savePool(pool);
  }
  res.json({ ok: true, sessionToken: user.sessionToken, name: user.name, email: key, pool });
});

app.post('/api/auth/session', async (req, res) => {
  const { sessionToken, email } = req.body;
  if (!sessionToken || !email) return res.status(401).json({ error: 'No session' });
  const users = await loadUsers();
  const user  = users[email.toLowerCase()];
  if (!user || user.sessionToken !== sessionToken || Date.now() > user.sessionExpiry)
    return res.status(401).json({ error: 'Session expired' });
  const pool = await loadPool();
  res.json({ ok: true, name: user.name, email: user.email, pool });
});

app.post('/api/auth/reset', async (req, res) => {
  const { commishPassword, email, newPassword } = req.body;
  if (commishPassword !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await loadUsers();
  const key   = email.toLowerCase().trim();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  users[key].passwordHash  = hashPassword(newPassword);
  users[key].sessionToken  = makeSession();
  users[key].sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await saveUsers(users);
  res.json({ ok: true, message: `Password reset for ${users[key].name}` });
});

// ═══════════════════════════════════════════════════
// COMMISSIONER
// ═══════════════════════════════════════════════════
app.post('/api/pool/commish', async (req, res) => {
  if (req.body.password !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Wrong commissioner password' });
  res.json({ ok: true, isCommish: true, pool: await loadPool() });
});

// ═══════════════════════════════════════════════════
// POOL API
// ═══════════════════════════════════════════════════
app.get('/api/pool', async (req, res) => res.json(await loadPool()));

app.post('/api/pool/managers', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  pool.managers = req.body.managers;
  await savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/settings', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  const { poolName, draftTime, picksPerPerson, pickSeconds } = req.body;
  if (poolName)       pool.poolName       = poolName;
  if (draftTime)      pool.draftTime      = draftTime;
  if (picksPerPerson) pool.picksPerPerson = parseInt(picksPerPerson);
  if (pickSeconds)    pool.pickSeconds    = parseInt(pickSeconds);
  await savePool(pool);
  res.json({ ok: true });
});

app.post('/api/pool/start', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  pool.draftStarted = true;
  advancePick(pool);
  await savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/reset', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  pool.picks = []; pool.currentPick = 0;
  pool.draftStarted = false; pool.draftComplete = false; pool.pickDeadline = null;
  await savePool(pool);
  res.json({ ok: true, pool });
});

// Commissioner: manually set a pick (for recovery/corrections)
app.post('/api/pool/manual-pick', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const { pickIndex, managerIdx, golfer, round } = req.body;
  const pool = await loadPool();
  const existing = pool.picks.findIndex(p => p.pick === pickIndex);
  const pickData = {
    round, pick: pickIndex, managerIdx,
    golfer, pickedBy: pool.managers[managerIdx]?.name || 'Unknown',
    manualEntry: true, ts: new Date().toISOString(),
  };
  if (existing >= 0) pool.picks[existing] = pickData;
  else pool.picks.push(pickData);
  pool.picks.sort((a,b) => a.pick - b.pick);
  await savePool(pool);
  res.json({ ok: true, pool });
});

// Commissioner: remove a pick
app.post('/api/pool/remove-pick', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  pool.picks = pool.picks.filter(p => p.pick !== req.body.pickIndex);
  await savePool(pool);
  res.json({ ok: true, pool });
});

app.post('/api/pool/remove-manager', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  pool.managers = pool.managers.filter(m => m.email !== req.body.email);
  await savePool(pool);
  res.json({ ok: true, pool });
});

// Mark draft complete manually
app.post('/api/pool/complete', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool();
  pool.draftComplete = true; pool.draftStarted = true; pool.pickDeadline = null;
  pool.currentPick = pool.picks.length;
  await savePool(pool);
  res.json({ ok: true, pool });
});

// Player pick submission
app.post('/api/pool/pick', async (req, res) => {
  const { sessionToken, email, golfer } = req.body;
  const users = await loadUsers();
  const user  = users[email?.toLowerCase()];
  if (!user || user.sessionToken !== sessionToken) return res.status(401).json({ error: 'Not logged in' });

  const pool = await loadPool();
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
  console.log(`✅  PICK: ${user.name} → "${golfer}" (pick #${pool.currentPick})`);
  advancePick(pool);
  await savePool(pool);
  res.json({ ok: true, pool });
});

// ═══════════════════════════════════════════════════
// ESPN SCORES
// ═══════════════════════════════════════════════════
let scoreCache = { data: null, ts: 0 };
app.get('/api/scores', async (req, res) => {
  // Return cached data if fresh (10 min)
  if (scoreCache.data && Date.now() - scoreCache.ts < 600000) {
    return res.json(scoreCache.data);
  }
  // Hard 8-second timeout so site never gets stuck loading
  try {
    const data = await Promise.race([
      fetchESPNScores(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    scoreCache = { data, ts: Date.now() };
    res.json(data);
  } catch(err) {
    console.warn('Score fetch failed:', err.message);
    if (scoreCache.data) return res.json({ ...scoreCache.data, _stale: true });
    // Return empty leaderboard so app doesn't hang
    res.json({ leaderboard: [], tournament: 'PGA Championship 2026', status: 'Loading...', round: '', fetchedAt: new Date().toISOString() });
  }
});

async function fetchESPNScores() {
  // Try Slash Golf first (real-time) if key is configured
  if (SLASH_GOLF_KEY) {
    try {
      const r = await fetchFn(
        `https://${SLASH_GOLF_HOST}/leaderboard?orgId=1&tournId=${PGA_TOURN_ID}&year=${PGA_YEAR}`,
        {
          headers: {
            'x-rapidapi-key':  SLASH_GOLF_KEY,
            'x-rapidapi-host': SLASH_GOLF_HOST,
            'Content-Type':    'application/json',
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (r.ok) {
        const data = await r.json();
        const normalized = normalizeSlashGolf(data);
        if (normalized.leaderboard.length > 0) {
          console.log(`✅ Slash Golf: ${normalized.leaderboard.length} players, round ${normalized.round}`);
          return normalized;
        }
      }
    } catch(e) { console.warn(`Slash Golf failed: ${e.message}`); }
  }

  // Fallback: ESPN (delayed but free)
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${PGA_ESPN_ID}`,
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga`,
  ];
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        console.log('⚠️  Using ESPN fallback (scores may lag)');
        return normalizeESPN(await r.json());
      }
    } catch(e) { console.warn(`ESPN failed: ${e.message}`); }
  }
  throw new Error('All score sources failed');
}

function normalizeSlashGolf(data) {
  // Slash Golf actual response structure (confirmed from live data):
  // { orgId, year, tournId, status, roundId, leaderboardRows: [...] }
  // Each row: { lastName, firstName, playerId, isAmateur, courseId,
  //             position, total, currentRoundScore, totalStrokes,
  //             currentHole, status, totalStrokes, cutLines }
  const players = data?.leaderboardRows || data?.leaderboard || [];
  const round   = data?.roundId || '1';
  const status  = data?.status  || 'In Progress';

  const leaderboard = players.map(p => {
    const name  = `${p.firstName || ''} ${p.lastName || ''}`.trim();
    // "total" field is like "-4", "E", "+2"
    const toPar = parseScore(p.total || 'E');
    const thru  = p.currentHole ? String(p.currentHole) : '';
    const pStatus = p.status || '';
    return { name, toPar, thru, status: pStatus };
  }).sort((a, b) => a.toPar - b.toPar);

  console.log(`Slash Golf parsed: ${leaderboard.length} players, leader: ${leaderboard[0]?.name} ${leaderboard[0]?.toPar}`);

  return {
    tournament: 'PGA Championship 2026',
    round: `Round ${round}`,
    status,
    leaderboard,
    source: 'slashgolf',
    fetchedAt: new Date().toISOString(),
  };
}
function normalizeESPN(raw) {
  const event = raw?.events?.[0] || {};
  const comp  = event?.competitions?.[0] || {};
  const leaderboard = (comp?.competitors || []).map(c => {
    const disp = c?.score?.displayValue || c?.score || 'E';
    return { name: c?.athlete?.displayName || '', toPar: parseScore(disp), disp, thru: c?.status?.thru || '', status: c?.status?.type?.description || '' };
  }).sort((a, b) => a.toPar - b.toPar);
  return { tournament: event?.name || 'PGA Championship', round: comp?.status?.type?.shortDetail || '', status: comp?.status?.type?.description || 'Scheduled', leaderboard, fetchedAt: new Date().toISOString() };
}
function parseScore(s) { if (!s || s === 'E') return 0; const n = parseInt(s, 10); return isNaN(n) ? 0 : n; }

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ─────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n⛳  Golf Pool 2026 → http://localhost:${PORT}`);
  await initDB();
  startDraftWatcher();
});
