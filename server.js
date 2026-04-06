/**
 * Masters Pool 2026 — Server
 * ─────────────────────────────────────────────────────────
 * Serves the frontend and proxies ESPN Golf scores to
 * avoid CORS restrictions.
 *
 * ESPN Golf Leaderboard API (unofficial, public):
 *   https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard
 *   ?league=pga&event=401353232   ← Masters tournament ID
 *
 * The Masters 2026 ESPN event ID: 401580359
 * (falls back to the active PGA event if ID changes)
 *
 * Setup:
 *   npm install express node-fetch cors
 *   node server.js
 *
 * Then open http://localhost:3000
 * ─────────────────────────────────────────────────────────
 */

const express = require('express');
const path    = require('path');
const app     = express();

// ── Try to use node-fetch v2 (CommonJS). Falls back to built-in fetch
// ── (Node 18+) if not installed.
let fetchFn;
try {
  fetchFn = require('node-fetch');
  if (fetchFn.default) fetchFn = fetchFn.default; // handle esm compat
} catch {
  fetchFn = fetch; // Node 18+ global
}

const PORT = process.env.PORT || 3000;

// Masters 2026 ESPN event ID.
// To find it: go to https://www.espn.com/golf/leaderboard and the URL
// contains the event ID, e.g. ?tournamentId=401580359
const MASTERS_ESPN_ID = '401580359';

// ──────────────────────────────────────────────────────────
// Serve static files from /public
// ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '.')));
app.use(express.json());

// ──────────────────────────────────────────────────────────
// Simple in-memory cache (1 minute TTL)
// ──────────────────────────────────────────────────────────
let scoreCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// ──────────────────────────────────────────────────────────
// GET /api/scores  — ESPN Golf leaderboard proxy
// ──────────────────────────────────────────────────────────
app.get('/api/scores', async (req, res) => {
  // Return cached data if fresh
  if (scoreCache.data && Date.now() - scoreCache.ts < CACHE_TTL_MS) {
    return res.json(scoreCache.data);
  }

  try {
    const data = await fetchESPNScores();
    scoreCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('[scores] ESPN fetch failed:', err.message);
    // Return stale cache if available, otherwise 503
    if (scoreCache.data) {
      return res.json({ ...scoreCache.data, _stale: true });
    }
    res.status(503).json({ error: 'Scores unavailable', detail: err.message });
  }
});

async function fetchESPNScores() {
  // ── Strategy 1: Specific Masters event ID ──────────────
  const primaryUrl =
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard` +
    `?league=pga&event=${MASTERS_ESPN_ID}`;

  let resp = await fetchFn(primaryUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  // ── Strategy 2: Active PGA event (fallback) ────────────
  if (!resp.ok) {
    console.warn('[scores] Primary ESPN URL failed, trying fallback…');
    resp = await fetchFn(
      'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
  }

  if (!resp.ok) throw new Error(`ESPN returned HTTP ${resp.status}`);
  const raw = await resp.json();
  return normalizeESPN(raw);
}

/**
 * Normalize the ESPN response into a clean structure for the frontend.
 *
 * ESPN leaderboard JSON shape (simplified):
 * {
 *   events: [{
 *     name: "Masters Tournament",
 *     competitions: [{
 *       status: { type: { description, shortDetail } },
 *       competitors: [{
 *         athlete: { displayName, id },
 *         score: "-8",          ← total score to par
 *         status: { thru, type: { description } },
 *         linescores: [{ value }]  ← per-round scores
 *       }]
 *     }]
 *   }]
 * }
 */
function normalizeESPN(raw) {
  const event      = raw?.events?.[0] || {};
  const comp       = event?.competitions?.[0] || {};
  const status     = comp?.status || {};
  const competitors = comp?.competitors || [];

  const leaderboard = competitors.map(c => {
    const athlete = c?.athlete || {};
    const rounds  = (c?.linescores || []).map(ls => {
      const v = ls?.value;
      return v !== undefined ? Number(v) : null;
    }).filter(v => v !== null);

    return {
      id:     athlete?.id || '',
      name:   athlete?.displayName || '',
      score:  c?.score || 'E',           // total to par string e.g. "-8"
      toPar:  parseScore(c?.score),       // integer
      thru:   c?.status?.thru || '',
      status: c?.status?.type?.description || '',
      pos:    c?.status?.position?.displayText || '',
      rounds,                             // [R1, R2, R3, R4] to par per round
    };
  });

  // Sort by score (ascending = lower is better)
  leaderboard.sort((a, b) => a.toPar - b.toPar);

  return {
    tournament: event?.name || 'Masters Tournament',
    eventId:    event?.id || MASTERS_ESPN_ID,
    round:      status?.type?.shortDetail || '',
    status:     status?.type?.description || 'Scheduled',
    inProgress: status?.type?.state === 'in',
    leaderboard,
    fetchedAt:  new Date().toISOString(),
  };
}

function parseScore(s) {
  if (!s || s === 'E' || s === 'Par') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

// ──────────────────────────────────────────────────────────
// GET /api/pool  — Save/load pool state (simple JSON file)
// ──────────────────────────────────────────────────────────
const fs   = require('fs');
const POOL_FILE = path.join(__dirname, 'pool-state.json');

app.get('/api/pool', (req, res) => {
  try {
    if (!fs.existsSync(POOL_FILE)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')));
  } catch { res.status(500).json({ error: 'Could not read pool state' }); }
});

app.post('/api/pool', (req, res) => {
  try {
    fs.writeFileSync(POOL_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Could not save pool state' }); }
});

// ──────────────────────────────────────────────────────────
// Catch-all: serve index.html for SPA routing
// ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ──────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⛳  Masters Pool 2026 running at http://localhost:${PORT}`);
  console.log(`   ESPN scores endpoint: http://localhost:${PORT}/api/scores`);
  console.log(`   Pool state endpoint:  http://localhost:${PORT}/api/pool\n`);
});
