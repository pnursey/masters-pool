/**
 * Masters Pool 2026 — Server v2
 * Persistent state, commissioner auth, player sessions
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

let fetchFn;
try { fetchFn = require('node-fetch'); if (fetchFn.default) fetchFn = fetchFn.default; }
catch { fetchFn = fetch; }

const PORT = process.env.PORT || 3000;
const MASTERS_ESPN_ID = '401580359';
const POOL_FILE = path.join(__dirname, 'pool-state.json');

const DEFAULT_STATE = {
  poolName: "Masters Pool 2026",
  playerPassword: "masters2026",
  commishPassword: "commish2026",
  draftTime: "2026-04-08T19:00:00",
  picksPerPerson: 5,
  pickSeconds: 90,
  managers: [],
  picks: [],
  draftStarted: false,
  draftComplete: false,
  currentPick: 0,
};

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

function loadPool() {
  try { if (fs.existsSync(POOL_FILE)) return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
  catch(e) { console.error('loadPool:', e.message); }
  return { ...DEFAULT_STATE };
}
function savePool(state) {
  try { fs.writeFileSync(POOL_FILE, JSON.stringify(state, null, 2)); return true; }
  catch(e) { console.error('savePool:', e.message); return false; }
}
function safe(pool) { const { commishPassword, ...s } = pool; return s; }

function getDraftOrder(n, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const seq = r % 2 === 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    seq.forEach(i => order.push({ round: r+1, managerIdx: i }));
  }
  return order;
}

// ── GET pool state (no commish password) ──
app.get('/api/pool', (req, res) => res.json(safe(loadPool())));

// ── Commissioner: create / reset pool ──
app.post('/api/pool/init', (req, res) => {
  const { commishPassword, poolName, playerPassword, newCommishPassword, draftTime, picksPerPerson } = req.body;
  const existing = loadPool();
  // If pool has managers, require correct commish password to overwrite
  if (existing.managers && existing.managers.length > 0) {
    if (commishPassword !== existing.commishPassword) {
      return res.status(401).json({ error: 'Wrong commissioner password' });
    }
  }
  const state = {
    ...DEFAULT_STATE,
    poolName:        poolName        || existing.poolName,
    playerPassword:  playerPassword  || existing.playerPassword,
    commishPassword: newCommishPassword || commishPassword || existing.commishPassword,
    draftTime:       draftTime       || existing.draftTime,
    picksPerPerson:  picksPerPerson  || existing.picksPerPerson,
    managers: existing.managers || [],
    picks: [],
    draftStarted: false,
    draftComplete: false,
    currentPick: 0,
  };
  savePool(state);
  res.json({ ok: true, pool: safe(state) });
});

// ── Commissioner login ──
app.post('/api/pool/commish', (req, res) => {
  const pool = loadPool();
  if (req.body.password !== pool.commishPassword) return res.status(401).json({ error: 'Wrong commissioner password' });
  res.json({ ok: true, isCommish: true, pool: safe(pool) });
});

// ── Player join ──
app.post('/api/pool/join', (req, res) => {
  const { name, password } = req.body;
  const pool = loadPool();
  if (password !== pool.playerPassword) return res.status(401).json({ error: 'Wrong pool password' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const trimmed = name.trim();
  if (!pool.managers.includes(trimmed)) { pool.managers.push(trimmed); savePool(pool); }
  res.json({ ok: true, name: trimmed, pool: safe(pool) });
});

// ── Commissioner: update managers list ──
app.post('/api/pool/managers', (req, res) => {
  const { commishPassword, managers } = req.body;
  const pool = loadPool();
  if (commishPassword !== pool.commishPassword) return res.status(401).json({ error: 'Unauthorized' });
  pool.managers = managers;
  savePool(pool);
  res.json({ ok: true, pool: safe(pool) });
});

// ── Commissioner: update settings ──
app.post('/api/pool/settings', (req, res) => {
  const { commishPassword, poolName, playerPassword, newCommishPassword, draftTime, picksPerPerson } = req.body;
  const pool = loadPool();
  if (commishPassword !== pool.commishPassword) return res.status(401).json({ error: 'Unauthorized' });
  if (poolName)            pool.poolName = poolName;
  if (playerPassword)      pool.playerPassword = playerPassword;
  if (newCommishPassword)  pool.commishPassword = newCommishPassword;
  if (draftTime)           pool.draftTime = draftTime;
  if (picksPerPerson)      pool.picksPerPerson = parseInt(picksPerPerson);
  if (req.body.pickSeconds) pool.pickSeconds = parseInt(req.body.pickSeconds);
  savePool(pool);
  res.json({ ok: true });
});

// ── Commissioner: start draft ──
app.post('/api/pool/start', (req, res) => {
  const pool = loadPool();
  if (req.body.commishPassword !== pool.commishPassword) return res.status(401).json({ error: 'Unauthorized' });
  pool.draftStarted = true;
  savePool(pool);
  res.json({ ok: true, pool: safe(pool) });
});

// ── Commissioner: reset draft (keep managers) ──
app.post('/api/pool/reset', (req, res) => {
  const pool = loadPool();
  if (req.body.commishPassword !== pool.commishPassword) return res.status(401).json({ error: 'Unauthorized' });
  pool.picks = []; pool.currentPick = 0; pool.draftStarted = false; pool.draftComplete = false;
  savePool(pool);
  res.json({ ok: true, pool: safe(pool) });
});

// ── Submit a pick ──
app.post('/api/pool/pick', (req, res) => {
  const { name, password, golfer } = req.body;
  const pool = loadPool();
  if (password !== pool.playerPassword) return res.status(401).json({ error: 'Unauthorized' });
  if (!pool.draftStarted || pool.draftComplete) return res.status(400).json({ error: 'Draft not active' });
  const order = getDraftOrder(pool.managers.length, pool.picksPerPerson);
  const current = order[pool.currentPick];
  if (!current) return res.status(400).json({ error: 'Draft complete' });
  const managerIdx = pool.managers.indexOf(name);
  if (managerIdx !== current.managerIdx) return res.status(403).json({ error: "Not your turn" });
  if (pool.picks.find(p => p.golfer === golfer)) return res.status(400).json({ error: 'Already picked' });
  pool.picks.push({ round: current.round, pick: pool.currentPick+1, managerIdx, golfer, pickedBy: name, ts: new Date().toISOString() });
  pool.currentPick++;
  if (pool.currentPick >= order.length) pool.draftComplete = true;
  savePool(pool);
  res.json({ ok: true, pool: safe(pool) });
});

// ── ESPN scores proxy ──
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
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga`
  ];
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) return normalizeESPN(await r.json());
    } catch {}
  }
  throw new Error('All ESPN URLs failed');
}

function normalizeESPN(raw) {
  const event = raw?.events?.[0] || {};
  const comp  = event?.competitions?.[0] || {};
  const leaderboard = (comp?.competitors || []).map(c => ({
    name:   c?.athlete?.displayName || '',
    toPar:  parseScore(c?.score),
    thru:   c?.status?.thru || '',
    status: c?.status?.type?.description || '',
    rounds: (c?.linescores || []).map(ls => Number(ls?.value) || 0),
  })).sort((a,b) => a.toPar - b.toPar);
  return { tournament: event?.name || 'Masters Tournament', round: comp?.status?.type?.shortDetail || '', status: comp?.status?.type?.description || 'Scheduled', leaderboard, fetchedAt: new Date().toISOString() };
}
function parseScore(s) { if (!s || s === 'E') return 0; const n = parseInt(s,10); return isNaN(n) ? 0 : n; }

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`\n⛳  Masters Pool 2026 → http://localhost:${PORT}\n`));
