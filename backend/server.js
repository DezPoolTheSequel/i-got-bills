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
const webpush = require('web-push');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;
const APP_KEY = process.env.APP_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/data';

const BILLS_FILE = path.join(DATA_DIR, 'bills.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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

function isBillPaid(bill) {
  return bill.budgetAmount > 0 && bill.paidAmount >= bill.budgetAmount;
}

function getTomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
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

// Push notification endpoints — require auth like all other /api routes.

app.get('/api/push/vapid-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push notifications not configured on this server.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription object.' });
  const subs = readJsonFile(SUBSCRIPTIONS_FILE, []);
  const filtered = subs.filter(s => s.endpoint !== sub.endpoint);
  writeJsonFile(SUBSCRIPTIONS_FILE, [...filtered, sub]);
  res.json({ status: 'subscribed' });
});

app.delete('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'No endpoint provided.' });
  const subs = readJsonFile(SUBSCRIPTIONS_FILE, []);
  writeJsonFile(SUBSCRIPTIONS_FILE, subs.filter(s => s.endpoint !== endpoint));
  res.json({ status: 'unsubscribed' });
});

// Daily check at 4:30 AM (uses TZ env var for the container's timezone).
async function sendNotifications() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = readJsonFile(SUBSCRIPTIONS_FILE, []);
  if (subs.length === 0) return;

  const settings = readJsonFile(SETTINGS_FILE, {});
  const notifyDayBefore = settings.notifyDayBefore !== false; // default true
  const notifyDayOf = settings.notifyDayOf === true;           // default false

  const bills = readJsonFile(BILLS_FILE, []);
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = getTomorrowISO();

  const toSend = [];

  if (notifyDayBefore) {
    const due = bills.filter(b => b.type !== 'income' && b.dueDate === tomorrow && !isBillPaid(b));
    if (due.length > 0) toSend.push({
      title: due.length === 1 ? `Bill due tomorrow: ${due[0].name}` : `${due.length} bills due tomorrow`,
      body: due.length === 1 ? formatMoney(due[0].budgetAmount) : due.map(b => `${b.name} (${formatMoney(b.budgetAmount)})`).join(', '),
    });
  }

  if (notifyDayOf) {
    const due = bills.filter(b => b.type !== 'income' && b.dueDate === today && !isBillPaid(b));
    if (due.length > 0) toSend.push({
      title: due.length === 1 ? `Bill due today: ${due[0].name}` : `${due.length} bills due today`,
      body: due.length === 1 ? formatMoney(due[0].budgetAmount) : due.map(b => `${b.name} (${formatMoney(b.budgetAmount)})`).join(', '),
    });
  }

  if (toSend.length === 0) return;

  let currentSubs = subs;
  for (const notif of toSend) {
    const results = await Promise.allSettled(
      currentSubs.map(sub => webpush.sendNotification(sub, JSON.stringify(notif)))
    );
    // Clean up subscriptions the push service says are gone (410 = browser unsubscribed).
    currentSubs = currentSubs.filter((_, i) => {
      const r = results[i];
      return r.status === 'fulfilled' || (r.reason && r.reason.statusCode !== 410);
    });
  }
  if (currentSubs.length !== subs.length) writeJsonFile(SUBSCRIPTIONS_FILE, currentSubs);

  console.log(`Push: sent ${toSend.length} notification(s) to ${subs.length} device(s)`);
}

cron.schedule('30 4 * * *', sendNotifications);

app.listen(PORT, () => {
  ensureDataDir();
  console.log(`I Got Bills backend listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(APP_KEY ? 'APP_KEY is set.' : 'WARNING: APP_KEY is not set — all requests will be rejected.');
});
