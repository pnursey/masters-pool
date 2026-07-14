/**
 * Golf Pool 2026 — The Open Championship Edition
 * Royal Birkdale · July 16–19, 2026
 */

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const app     = express();

const PORT             = process.env.PORT || 3000;
const COMMISH_PASSWORD = process.env.COMMISH_PASSWORD || 'commish2026';
const POOL_PASSWORD    = process.env.POOL_PASSWORD    || 'open2026';
const SLASH_GOLF_KEY   = process.env.SLASH_GOLF_KEY   || '';
const SLASH_GOLF_HOST  = 'live-golf-data.p.rapidapi.com';
const OPEN_TOURN_ID    = '100'; // The Open Championship Slash Golf ID
const OPEN_YEAR        = '2026';
const OPEN_ESPN_ID     = '401811957'; // 2026 Open Championship ESPN event ID

let fetchFn;
try { fetchFn = require('node-fetch'); if (fetchFn.default) fetchFn = fetchFn.default; }
catch { fetchFn = fetch; }

const DEFAULT_POOL = {
  poolName: 'The Open Pool 2026',
  draftTime: '2026-07-15T20:00:00',
  picksPerPerson: 5,
  pickSeconds: 90,
  managers: [],
  picks: [],
  draftStarted: false,
  draftComplete: false,
  currentPick: 0,
  pickDeadline: null,
};

let db = null;
let _memPool  = { ...DEFAULT_POOL };
let _memUsers = {};

async function initDB() {
  const url = process.env.TURSO_URL, token = process.env.TURSO_TOKEN;
  if (!url || !token) { console.log('⚠  No Turso config — using in-memory storage'); return; }
  try {
    const { createClient } = require('@libsql/client');
    db = createClient({ url, authToken: token });
    await db.execute(`CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY DEFAULT 1, data TEXT NOT NULL)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY DEFAULT 1, data TEXT NOT NULL)`);
    const pr = await db.execute('SELECT data FROM pool WHERE id=1');
    if (pr.rows.length === 0) await db.execute({ sql: 'INSERT INTO pool (id,data) VALUES (1,?)', args: [JSON.stringify(DEFAULT_POOL)] });
    const ur = await db.execute('SELECT data FROM users WHERE id=1');
    if (ur.rows.length === 0) await db.execute({ sql: 'INSERT INTO users (id,data) VALUES (1,?)', args: ['{}'] });
    console.log('✅  Turso database connected — data will persist restarts');
  } catch(e) { console.error('Turso init failed:', e.message); db = null; }
}

async function loadPool() {
  if (!db) return JSON.parse(JSON.stringify(_memPool));
  try { const r = await db.execute('SELECT data FROM pool WHERE id=1'); if (r.rows.length) return JSON.parse(r.rows[0].data); } catch {}
  return JSON.parse(JSON.stringify(_memPool));
}
async function savePool(p) {
  _memPool = JSON.parse(JSON.stringify(p));
  if (!db) return;
  try { await db.execute({ sql: 'UPDATE pool SET data=? WHERE id=1', args: [JSON.stringify(p)] }); } catch(e) { console.error('savePool:', e.message); }
}
async function loadUsers() {
  if (!db) return JSON.parse(JSON.stringify(_memUsers));
  try { const r = await db.execute('SELECT data FROM users WHERE id=1'); if (r.rows.length) return JSON.parse(r.rows[0].data); } catch {}
  return {};
}
async function saveUsers(u) {
  _memUsers = JSON.parse(JSON.stringify(u));
  if (!db) return;
  try { await db.execute({ sql: 'UPDATE users SET data=? WHERE id=1', args: [JSON.stringify(u)] }); } catch(e) { console.error('saveUsers:', e.message); }
}

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
    pool.draftComplete = true; pool.pickDeadline = null; console.log('🏁  Draft complete!');
  } else {
    pool.pickDeadline = Date.now() + (pool.pickSeconds || 90) * 1000;
    const mgrName = pool.managers[order[pool.currentPick]?.managerIdx]?.name || 'Unknown';
    console.log(`⏱  Pick #${pool.currentPick + 1} — ${mgrName} on the clock`);
  }
  return pool;
}
function requireCommish(req, res) {
  if (req.body.commishPassword !== COMMISH_PASSWORD) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// Auto-pick watcher
function startDraftWatcher() {
  const OPEN_FIELD = [
    "Scottie Scheffler","Rory McIlroy","Jon Rahm","Matt Fitzpatrick","Tommy Fleetwood",
    "Xander Schauffele","Chris Gotterup","Cameron Young","Ludvig Aberg","Collin Morikawa",
    "Tyrrell Hatton","Robert MacIntyre","Wyndham Clark","Sam Burns","Bryson DeChambeau",
    "Viktor Hovland","Justin Rose","Joaquin Niemann","Brooks Koepka","Justin Thomas",
    "Russell Henley","Patrick Cantlay","Jordan Spieth","Patrick Reed","Tom Kim",
    "Si Woo Kim","Shane Lowry","Min Woo Lee","J.J. Spaun","Hideki Matsuyama",
    "Nicolai Hojgaard","Kurt Kitayama","Ben Griffin","Adam Scott","Aaron Rai",
    "Alex Fitzpatrick","Kristoffer Reitan","Harris English","David Puig","Maverick McNealy",
    "Akshay Bhatia","Rickie Fowler","Alex Noren","Brian Harman","Cameron Smith",
    "Eugenio Chacarra","Corey Conners","Gary Woodland","Jason Day","Keith Mitchell",
    "Max Homa","Jake Knapp","Angel Ayora","Tom McKibbin","Ryan Gerard","Ryan Fox",
    "Sepp Straka","J.T. Poston","Thomas Detry","Ryo Hisatsune","Eric Cole",
    "Harry Hall","Matt Wallace","Marco Penge","Keegan Bradley","Jordan Smith",
    "Haotong Li","Sungjae Im","Sahith Theegala","Alex Smalley","Bud Cauley",
    "Pierceson Coody","Michael Brennan","Jacob Bridgeman","Max Greyserman",
    "Jackson Suber","Rasmus Hojgaard","Daniel Berger","Nick Taylor","Jayden Schaper",
    "Andrew Novak","Lucas Herbert","Rasmus Neergaard-Petersen","Sam Stevens",
    "Jesper Svensson","Sami Valimaki","Bernd Wiesberger","Matt McCarty","Michael Kim",
    "Scott Vincent","Daniel Hillier","Matthew Jordan","Louis Oosthuizen","Hennie du Plessis",
    "Casey Jarvis","Jose Luis Ballester","Keita Nakajima","John Parry","Laurie Canter",
    "Daniel Brown","Billy Horschel","Antoine Rozner","Kota Kaneko","Adrien Saddier",
    "Andy Sullivan","Francesco Laporta","Padraig Harrington","Dan Bradbury","Caleb Surratt",
    "Francesco Molinari","Peter Uihlein","Stewart Cink","Henrik Stenson",
    "Stuart Grehan","Travis Smyth","Kazuki Higa","Fifa Laopakdee","Mason Howell",
    "Nico Echavarria",
  ];
  setInterval(async () => {
    try {
      const pool = await loadPool();
      if (!pool.draftStarted || pool.draftComplete || !pool.pickDeadline) return;
      if (Date.now() < pool.pickDeadline) return;
      const order = getDraftOrder(pool.managers.length, pool.picksPerPerson);
      const current = order[pool.currentPick]; if (!current) return;
      const taken = new Set(pool.picks.map(p => p.golfer));
      const golfer = OPEN_FIELD.find(g => !taken.has(g)); if (!golfer) return;
      const mgrName = pool.managers[current.managerIdx]?.name || 'Unknown';
      pool.picks.push({ round: current.round, pick: pool.currentPick + 1, managerIdx: current.managerIdx, golfer, pickedBy: mgrName, autoPick: true, ts: new Date().toISOString() });
      pool.currentPick++;
      console.log(`🤖  AUTO-PICK: ${mgrName} timed out → "${golfer}" (pick #${pool.currentPick})`);
      advancePick(pool); await savePool(pool);
    } catch(e) { console.error('Watcher error:', e.message); }
  }, 2000);
  console.log('⏱  Draft watcher active');
}

// Auth
app.post('/api/auth/register', async (req, res) => {
  const { email, name, password, poolPassword } = req.body;
  if (!email || !email.includes('@'))    return res.status(400).json({ error: 'Valid email required' });
  if (!name  || !name.trim())            return res.status(400).json({ error: 'Name required' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (poolPassword !== POOL_PASSWORD)    return res.status(401).json({ error: 'Wrong pool password. Ask your commissioner.' });
  const users = await loadUsers(); const key = email.toLowerCase().trim();
  if (users[key]) return res.status(409).json({ error: 'Account already exists. Please sign in instead.' });
  const sessionToken = makeSession();
  users[key] = { email: key, name: name.trim(), passwordHash: hashPassword(password), sessionToken, sessionExpiry: Date.now() + 30*24*60*60*1000, createdAt: new Date().toISOString() };
  await saveUsers(users);
  const pool = await loadPool();
  if (!pool.managers.find(m => m.email === key)) { pool.managers.push({ name: name.trim(), email: key }); await savePool(pool); }
  res.json({ ok: true, sessionToken, name: name.trim(), email: key, pool });
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const users = await loadUsers(); const key = email.toLowerCase().trim(); const user = users[key];
  if (!user) return res.status(401).json({ error: 'No account found. Please register first.' });
  if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Wrong password.' });
  user.sessionToken = makeSession(); user.sessionExpiry = Date.now() + 30*24*60*60*1000;
  await saveUsers(users);
  const pool = await loadPool();
  if (!pool.managers.find(m => m.email === key)) { pool.managers.push({ name: user.name, email: key }); await savePool(pool); }
  res.json({ ok: true, sessionToken: user.sessionToken, name: user.name, email: key, pool });
});
app.post('/api/auth/session', async (req, res) => {
  const { sessionToken, email } = req.body;
  if (!sessionToken || !email) return res.status(401).json({ error: 'No session' });
  const users = await loadUsers(); const user = users[email.toLowerCase()];
  if (!user || user.sessionToken !== sessionToken || Date.now() > user.sessionExpiry) return res.status(401).json({ error: 'Session expired' });
  res.json({ ok: true, name: user.name, email: user.email, pool: await loadPool() });
});
app.post('/api/auth/reset', async (req, res) => {
  const { commishPassword, email, newPassword } = req.body;
  if (commishPassword !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await loadUsers(); const key = email.toLowerCase().trim();
  if (!users[key]) return res.status(404).json({ error: 'User not found' });
  users[key].passwordHash = hashPassword(newPassword); users[key].sessionToken = makeSession(); users[key].sessionExpiry = Date.now() + 30*24*60*60*1000;
  await saveUsers(users); res.json({ ok: true, message: `Password reset for ${users[key].name}` });
});

// Commissioner
app.post('/api/pool/commish', async (req, res) => {
  if (req.body.password !== COMMISH_PASSWORD) return res.status(401).json({ error: 'Wrong commissioner password' });
  res.json({ ok: true, isCommish: true, pool: await loadPool() });
});

// Pool API
app.get('/api/pool', async (req, res) => res.json(await loadPool()));
app.post('/api/pool/managers', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool(); pool.managers = req.body.managers; await savePool(pool); res.json({ ok: true, pool });
});
app.post('/api/pool/settings', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool(); const { poolName, draftTime, picksPerPerson, pickSeconds } = req.body;
  if (poolName) pool.poolName = poolName; if (draftTime) pool.draftTime = draftTime;
  if (picksPerPerson) pool.picksPerPerson = parseInt(picksPerPerson); if (pickSeconds) pool.pickSeconds = parseInt(pickSeconds);
  await savePool(pool); res.json({ ok: true });
});
app.post('/api/pool/start', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool(); pool.draftStarted = true; advancePick(pool); await savePool(pool); res.json({ ok: true, pool });
});
app.post('/api/pool/reset', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool(); pool.picks = []; pool.currentPick = 0; pool.draftStarted = false; pool.draftComplete = false; pool.pickDeadline = null;
  await savePool(pool); res.json({ ok: true, pool });
});
app.post('/api/pool/remove-manager', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool(); pool.managers = pool.managers.filter(m => m.email !== req.body.email); await savePool(pool); res.json({ ok: true, pool });
});
app.post('/api/pool/manual-pick', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const { pickIndex, managerIdx, golfer, round } = req.body; const pool = await loadPool();
  const existing = pool.picks.findIndex(p => p.pick === pickIndex);
  const pickData = { round, pick: pickIndex, managerIdx, golfer, pickedBy: pool.managers[managerIdx]?.name || 'Unknown', manualEntry: true, ts: new Date().toISOString() };
  if (existing >= 0) pool.picks[existing] = pickData; else pool.picks.push(pickData);
  pool.picks.sort((a,b) => a.pick - b.pick); await savePool(pool); res.json({ ok: true, pool });
});
app.post('/api/pool/complete', async (req, res) => {
  if (!requireCommish(req, res)) return;
  const pool = await loadPool(); pool.draftComplete = true; pool.draftStarted = true; pool.pickDeadline = null; pool.currentPick = pool.picks.length;
  await savePool(pool); res.json({ ok: true, pool });
});
app.post('/api/pool/pick', async (req, res) => {
  const { sessionToken, email, golfer } = req.body;
  const users = await loadUsers(); const user = users[email?.toLowerCase()];
  if (!user || user.sessionToken !== sessionToken) return res.status(401).json({ error: 'Not logged in' });
  const pool = await loadPool();
  if (!pool.draftStarted || pool.draftComplete) return res.status(400).json({ error: 'Draft not active' });
  const order = getDraftOrder(pool.managers.length, pool.picksPerPerson); const current = order[pool.currentPick];
  if (!current) return res.status(400).json({ error: 'Draft complete' });
  const managerIdx = pool.managers.findIndex(m => m.email === email.toLowerCase());
  if (managerIdx !== current.managerIdx) return res.status(403).json({ error: "Not your turn" });
  if (pool.picks.find(p => p.golfer === golfer)) return res.status(400).json({ error: 'Already picked' });
  pool.picks.push({ round: current.round, pick: pool.currentPick + 1, managerIdx, golfer, pickedBy: user.name, ts: new Date().toISOString() });
  pool.currentPick++; console.log(`✅  PICK: ${user.name} → "${golfer}" (pick #${pool.currentPick})`);
  advancePick(pool); await savePool(pool); res.json({ ok: true, pool });
});

// Scores
function extractVal(v) { if (v === null || v === undefined) return null; if (typeof v === 'object') return v.$numberInt || v.$numberDouble || v.value || null; return v; }

let scoreCache = { data: null, ts: 0 };
app.get('/api/scores', async (req, res) => {
  if (scoreCache.data && Date.now() - scoreCache.ts < 600000) return res.json(scoreCache.data);
  try {
    const data = await Promise.race([fetchScores(), new Promise((_,reject) => setTimeout(() => reject(new Error('timeout')), 8000))]);
    scoreCache = { data, ts: Date.now() }; res.json(data);
  } catch(err) {
    console.warn('Score fetch failed:', err.message);
    if (scoreCache.data) return res.json({ ...scoreCache.data, _stale: true });
    res.json({ leaderboard: [], tournament: 'The Open Championship 2026', status: 'Loading...', round: '', fetchedAt: new Date().toISOString() });
  }
});

async function fetchScores() {
  if (SLASH_GOLF_KEY) {
    try {
      const r = await fetchFn(`https://${SLASH_GOLF_HOST}/leaderboard?orgId=1&tournId=${OPEN_TOURN_ID}&year=${OPEN_YEAR}`,
        { headers: { 'x-rapidapi-key': SLASH_GOLF_KEY, 'x-rapidapi-host': SLASH_GOLF_HOST, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(7000) });
      if (r.ok) {
        const data = await r.json();
        const normalized = normalizeSlashGolf(data);
        if (normalized.leaderboard.length > 0) { console.log(`✅ Slash Golf: ${normalized.leaderboard.length} players`); return normalized; }
      }
    } catch(e) { console.warn('Slash Golf failed:', e.message); }
  }
  for (const url of [`https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${OPEN_ESPN_ID}`, `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga`]) {
    try {
      const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
      if (r.ok) { console.log('⚠️  Using ESPN fallback'); return normalizeESPN(await r.json()); }
    } catch {}
  }
  throw new Error('All score sources failed');
}

function normalizeSlashGolf(data) {
  const players = data?.leaderboardRows || data?.leaderboard || [];
  const round = data?.roundId || '1'; const status = data?.status || 'In Progress';
  const leaderboard = players.map(p => {
    const name = `${p.firstName || ''} ${p.lastName || ''}`.trim();
    const totalRaw = typeof p.total === 'object' ? (p.total.$numberInt || p.total.value || 'E') : (p.total || 'E');
    const toPar = parseScore(String(totalRaw));
    const holeRaw = extractVal(p.currentHole); const thru = holeRaw !== null ? String(holeRaw) : '';
    const pStatus = p.status || ''; const isCut = ['cut','wd','dq','withdrawn'].includes(pStatus.toLowerCase());
    return { name, toPar, thru, status: pStatus, cut: isCut };
  }).sort((a, b) => a.toPar - b.toPar);
  return { tournament: 'The Open Championship 2026', round: `Round ${round}`, status, leaderboard, source: 'slashgolf', fetchedAt: new Date().toISOString() };
}
function normalizeESPN(raw) {
  const event = raw?.events?.[0] || {}; const comp = event?.competitions?.[0] || {};
  const leaderboard = (comp?.competitors || []).map(c => {
    const disp = c?.score?.displayValue || c?.score || 'E';
    return { name: c?.athlete?.displayName || '', toPar: parseScore(disp), thru: c?.status?.thru || '', status: c?.status?.type?.description || '' };
  }).sort((a, b) => a.toPar - b.toPar);
  return { tournament: event?.name || 'The Open Championship 2026', round: comp?.status?.type?.shortDetail || '', status: comp?.status?.type?.description || 'Scheduled', leaderboard, fetchedAt: new Date().toISOString() };
}
function parseScore(s) { if (!s || s === 'E' || s === 'Par') return 0; const n = parseInt(s, 10); return isNaN(n) ? 0 : n; }

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, async () => {
  console.log(`\n⛳  The Open Pool 2026 → http://localhost:${PORT}`);
  console.log(`   Pool password: ${POOL_PASSWORD}`);
  await initDB(); loadPool(); loadUsers(); startDraftWatcher();
});
