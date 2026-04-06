# ⛳ Masters Pool 2026

Snake draft + live ESPN scoreboard for your Masters golf pool.

## Features

- **Snake Draft** — 10 managers, 5 picks each, 90-second clock
- **Live Scores** — proxied from ESPN Golf API, auto-refreshes every 60 seconds
- **Pool Scoreboard** — ranks managers by best-4-of-5 scores to par
- **Randomize Draft Order** — available up to 1 hour before draft start
- **Mobile-first** — works great on phones
- **Password protected** — pool join requires password

---

## Quick Start (Local)

### 1. Install Node.js
Download from https://nodejs.org (v18 or newer)

### 2. Install dependencies
```bash
cd masters-pool
npm install
```

### 3. Run the server
```bash
npm start
```

### 4. Open the app
```
http://localhost:3000
```

Share your local IP with friends on the same network (e.g. `http://192.168.1.x:3000`)

---

## Deployment (Free — Render.com)

1. Push this folder to a GitHub repo
2. Go to https://render.com → New Web Service
3. Connect your repo
4. Set:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Environment:** Node
5. Deploy — you get a public URL like `https://masters-pool.onrender.com`
6. Share that URL + password with your group

**Free tier note:** Render free tier spins down after 15 min of inactivity.
For always-on during Masters week, use the $7/mo Starter plan.

---

## Deployment (Free — Vercel)

```bash
npm install -g vercel
vercel deploy
```

Vercel works great for static + serverless. The `/api/scores` route
will automatically become a serverless function.

---

## ESPN Score API

The server proxies:
```
GET /api/scores
```
→ fetches from ESPN:
```
https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard
  ?league=pga&event=401580359
```

**Masters 2026 ESPN Event ID:** `401580359`

If the event ID needs updating (ESPN sometimes changes these), find it by:
1. Going to https://www.espn.com/golf/leaderboard during the Masters
2. Looking at the URL: `?tournamentId=XXXXXXX`
3. Update `MASTERS_ESPN_ID` in `server.js`

Scores cache for 60 seconds to avoid hammering ESPN.

---

## Pool State Persistence

Pool state (managers, picks, settings) is saved to `pool-state.json`
via `POST /api/pool`. On reload the app restores from this file.

For multi-device real-time sync, replace the file-based storage with
Firebase Realtime Database — see the commented block in server.js.

---

## Testing the Draft

From the home screen, tap **⚡ Test Draft Mode**:
- Loads 10 demo managers instantly
- Draft starts immediately
- You are "You" and pick first
- Other managers auto-pick every ~2 seconds
- Tap **"Skip to my turn ▶"** in the blue banner to jump to your next pick

---

## File Structure

```
masters-pool/
├── server.js          ← Express server + ESPN proxy
├── package.json
├── pool-state.json    ← auto-created on first save
└── public/
    └── index.html     ← Full app (draft + scoreboard)
```
