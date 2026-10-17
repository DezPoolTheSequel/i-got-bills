// I Got Bills — backend
//
// A deliberately small server: two pieces of data (bills, settings), stored
// as JSON files on disk, served over a tiny HTTP API. No database, no
// accounts — just enough to let multiple devices read/write the same data.
//
// Every request must include a header `x-app-key` matching APP_KEY (set via
// environment variable). Requests without the correct key are rejected.

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const APP_KEY = process.env.APP_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/data';

const BILLS_FILE = path.join(DATA_DIR, 'bills.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Allow generous JSON payloads (bill history can grow) but not unbounded.
app.use(express.json({ limit: '5mb' }));

// CORS: now that the backend is exposed via Tailscale Funnel (public internet),
// restrict allowed origins rather than reflecting any origin. The x-app-key
// requirement is the real access control — CORS here limits which browser
// origins can make requests at all.
//
// Access-Control-Allow-Private-Network is kept for compatibility in case the
// backend is temporarily switched back to Tailscale Serve (private tailnet).
const ALLOWED_ORIGINS = new Set([
  'https://dezpoolthesequel.github.io',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isLocalhost = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isAllowed = !origin || ALLOWED_ORIGINS.has(origin) || isLocalhost;
  res.header('Access-Control-Allow-Origin', isAllowed ? (origin || '*') : '');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-app-key');
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check — registered BEFORE the auth middleware below, so it's
// genuinely public. Useful for confirming the container is up before
// worrying about whether the key is right.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Require the app key on every other /api route.
app.use('/api', (req, res, next) => {
  if (!APP_KEY) {
    return res.status(500).json({ error: 'Server is not configured with an APP_KEY.' });
  }
  const provided = req.headers['x-app-key'];
  if (provided !== APP_KEY) {
    return res.status(401).json({ error: 'Invalid or missing app key.' });
  }
  next();
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDataDir();
  // Write to a temp file then rename, so a crash mid-write can't corrupt
  // the existing good data.
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

app.get('/api/bills', (req, res) => {
  const bills = readJsonFile(BILLS_FILE, []);
  res.json(bills);
});

app.put('/api/bills', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected a JSON array of bills.' });
  }
  writeJsonFile(BILLS_FILE, req.body);
  res.json({ status: 'saved', count: req.body.length });
});

app.get('/api/settings', (req, res) => {
  const settings = readJsonFile(SETTINGS_FILE, null);
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected a JSON object of settings.' });
  }
  writeJsonFile(SETTINGS_FILE, req.body);
  res.json({ status: 'saved' });
});

app.listen(PORT, () => {
  ensureDataDir();
  console.log(`I Got Bills backend listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(APP_KEY ? 'APP_KEY is set.' : 'WARNING: APP_KEY is not set — all requests will be rejected.');
});
