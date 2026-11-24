// Web server: accounts + subscriptions, and one WhatsApp workspace per user.
import { config, ROOT, subscriptionEndedMessage } from './config.js';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { Accounts } from './accounts.js';
import { LoginLimiter, normalizeEmail } from './auth.js';
import { DEFAULT_SETTINGS } from './campaign.js';
import { parseContacts } from './contacts.js';
import { connectDb } from './db.js';
import { MAX_DRAFTS } from './drafts.js';
import { buildSequence, classify } from './media.js';
import { Workspaces, migrateLegacy, publicUpload } from './workspace.js';

const MAX_FILE_MB = 64;
const LARGE_CAMPAIGN = 200;
const COOKIE = 'bws_session';
const USERS_DIR = path.join(config.dataDir, 'users');
const SUB_ENDED_NOTE = 'Paused: your subscription has ended.';

// ---------- database & accounts ----------
const mongo = await connectDb({ uri: config.mongoUri, dnsFallback: config.dnsFallback });
const accounts = new Accounts({
  users: mongo.users, sessions: mongo.sessions, timeZone: config.timeZone,
  sessionDays: config.sessionDays, expiredMessage: subscriptionEndedMessage,
});

// first start: create the admin from .env if there is none yet
let admin = await accounts.findAdmin();
if (!admin) {
  admin = await accounts.seedAdmin({ email: config.adminEmail, password: config.adminPassword, name: config.adminName });
  console.log(`  Admin account created: ${admin.email}`);
}
// move the old single-user data (from before accounts) into the admin's workspace
if (await migrateLegacy({
  projectRoot: ROOT, dataDir: config.dataDir, adminDir: path.join(USERS_DIR, String(admin._id)),
  draftsCollection: mongo.drafts, adminId: String(admin._id),
})) console.log('  Existing WhatsApp session, uploads, drafts and campaign moved to the admin account.');

// ---------- web server ----------
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const workspaces = new Workspaces({ root: USERS_DIR, draftsCollection: mongo.drafts, io });
const limiter = new LoginLimiter({ max: 10, windowMs: 15 * 60_000 });

const fail = (res, status, message, code) => res.status(status).json({ error: message, ...(code ? { code } : {}) });

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionDays * 86_400_000, path: '/' });
}

/** Pause a running campaign when the subscription is over. */
function stopIfExpired(user) {
  const ws = workspaces.peek(user._id);
  if (ws && ws.campaign.snapshot().status === 'running') ws.campaign.pause(SUB_ENDED_NOTE);
}

/** Resolve the session; 401 when signed out, 403 SUBSCRIPTION_ENDED when expired. */
async function requireUser(req, res, next) {
  try {
    const token = readCookie(req.headers.cookie, COOKIE);
    const user = await accounts.userFromToken(token);
    if (!user) return fail(res, 401, 'Please sign in.', 'AUTH_REQUIRED');
    if (accounts.isExpired(user)) {
      stopIfExpired(user);
      return fail(res, 403, subscriptionEndedMessage(), 'SUBSCRIPTION_ENDED');
    }
    req.user = user;
    req.token = token;
    req.ws = workspaces.get(user._id);
    req.ws.ensureStarted();
    next();
  } catch (e) {
    next(e);
  }
}
const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : fail(res, 403, 'Admins only.'));

app.use(express.json({ limit: '5mb' }));

// health check for the hosting platform (no login needed)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- pages ----------
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const PUBLIC = path.join(ROOT, 'public');
app.get(['/', '/index.html'], async (req, res) => {
  const user = await accounts.userFromToken(readCookie(req.headers.cookie, COOKIE)).catch(() => null);
  noStore(res);
  if (!user) return res.redirect('/login');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});
app.get('/login', (_req, res) => {
  noStore(res);
  res.sendFile(path.join(PUBLIC, 'login.html'));
});
// no-store: after an update the browser always loads the newest files, never a stale copy
app.use(express.static(PUBLIC, { index: false, etag: false, lastModified: false, setHeaders: noStore }));

// ---------- auth ----------
app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const key = `${email}|${req.ip}`;
  if (limiter.blocked(key)) return fail(res, 429, 'Too many attempts. Please wait 15 minutes and try again.');
  const r = await accounts.login(email, String(req.body?.password || ''));
  if (r.error) {
    if (r.code === 'BAD_LOGIN') limiter.fail(key);
    return fail(res, r.code === 'SUBSCRIPTION_ENDED' ? 403 : 401, r.error, r.code);
  }
  limiter.success(key);
  setSessionCookie(res, await accounts.createSession(r.user._id));
  res.json({ user: accounts.publicUser(r.user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = readCookie(req.headers.cookie, COOKIE);
  if (token) await accounts.logout(token);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json({ user: accounts.publicUser(req.user), supportPhone: config.supportPhone }));

// ---------- admin: users ----------
app.get('/api/admin/users', requireUser, requireAdmin, async (_req, res) => res.json({ users: await accounts.list() }));

app.post('/api/admin/users', requireUser, requireAdmin, async (req, res) => {
  const r = await accounts.create(req.body || {});
  if (r.error) return fail(res, 400, r.error);
  res.json(r);
});

app.patch('/api/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  const r = await accounts.update(req.params.id, req.body || {});
  if (r.error) return fail(res, 400, r.error);
  res.json(r);
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  if (String(req.user._id) === req.params.id) return fail(res, 400, 'You cannot delete your own account.');
  const r = await accounts.remove(req.params.id);
  if (r.error) return fail(res, 400, r.error);
  await workspaces.remove(req.params.id).catch((e) => console.error('workspace delete failed:', e));
  io.to(workspaces.room(req.params.id)).disconnectSockets(true);
  res.json({ ok: true });
});

// ---------- the sender (all scoped to the signed-in user's workspace) ----------
app.use('/api', requireUser);

app.get('/api/config', (_req, res) => res.json({ defaults: DEFAULT_SETTINGS, maxFileMb: MAX_FILE_MB, largeCampaign: LARGE_CAMPAIGN }));

app.post('/api/contacts/parse', (req, res) => {
  const { raw = '', countryCode = '' } = req.body || {};
  res.json(parseContacts(raw, countryCode));
});

app.get('/api/uploads', (req, res) => res.json(Object.values(req.ws.uploads).map(publicUpload)));

app.post('/api/upload', (req, res) => {
  const upload = multer({
    storage: multer.diskStorage({
      destination: req.ws.dirs.uploads,
      filename: (_r, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
  });
  upload.array('files')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_FILE_MB} MB` : err.message;
      return fail(res, 400, msg);
    }
    const added = (req.files || []).map((f) => req.ws.addUpload(f));
    req.ws.saveUploads();
    res.json(added);
  });
});

app.get('/api/upload/:id/file', (req, res) => {
  const item = req.ws.uploads[req.params.id];
  if (!item || !fs.existsSync(item.path)) return res.status(404).end();
  res.type(item.mimetype).sendFile(item.path);
});

app.delete('/api/upload/:id', (req, res) => {
  if (!req.ws.removeUpload(req.params.id)) return fail(res, 404, 'Not found');
  res.json({ ok: true });
});

// Resolve the client's ordered items (text blocks + uploaded files with captions).
function resolveItems(ws, items) {
  if (!Array.isArray(items)) return { error: 'Message is empty' };
  const resolved = [];
  for (const it of items) {
    if (it?.type === 'text') resolved.push({ type: 'text', text: String(it.text || '') });
    else if (it?.type === 'file') {
      const file = ws.uploads[it.uploadId];
      if (!file || !fs.existsSync(file.path)) return { error: 'Some files are missing. Remove them and add them again.' };
      resolved.push({ type: 'file', file, caption: String(it.caption || '') });
    }
  }
  const messages = buildSequence(resolved);
  if (!messages.length) return { error: 'Write a message or add a file (Step 3).' };
  // what the UI shows as "Now sending" — taken from the server's own records
  const display = resolved.map((r) => (r.type === 'text'
    ? { type: 'text', text: r.text }
    : { type: 'file', uploadId: r.file.id, caption: r.caption, originalName: r.file.originalName, mimetype: r.file.mimetype, size: r.file.size, kind: classify(r.file.mimetype) }));
  return { messages, display };
}

// ---------- drafts (MAX_DRAFTS slots; files on disk, details in MongoDB) ----------
const draftRoute = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, 400, e.message);
  }
};
app.get('/api/drafts', draftRoute(async (req) => ({ max: MAX_DRAFTS, drafts: await req.ws.drafts.list() })));
app.put('/api/drafts/:slot', draftRoute((req) => req.ws.drafts.save(req.params.slot, { name: req.body?.name, items: req.body?.items }, (id) => req.ws.uploads[id])));
app.patch('/api/drafts/:slot/name', draftRoute(async (req) => {
  await req.ws.drafts.rename(req.params.slot, req.body?.name);
  return { ok: true };
}));
app.delete('/api/drafts/:slot', draftRoute(async (req) => {
  await req.ws.drafts.remove(req.params.slot);
  return { ok: true };
}));
app.post('/api/drafts/:slot/apply', draftRoute(async (req) => ({ items: await req.ws.drafts.materialize(req.params.slot, (src, meta) => req.ws.importUpload(src, meta)) })));

// ---------- campaign ----------
app.post('/api/campaign/start', (req, res) => {
  const { wa, campaign } = req.ws;
  const { raw = '', items = [], settings = {} } = req.body || {};
  if (!wa.isConnected()) return fail(res, 400, 'Connect WhatsApp first (Step 1).');
  const { valid, withoutCode } = parseContacts(raw, '');
  if (!valid.length) return fail(res, 400, 'Add at least one valid contact (Step 2).');
  if (withoutCode) return fail(res, 400, `${withoutCode} number(s) have no country code. Click Apply in Step 2.`);
  const { messages, display, error } = resolveItems(req.ws, items);
  if (error) return fail(res, 400, error);
  try {
    campaign.start({ numbers: valid, messages, settings, display }).catch((e) => console.error(e));
    res.json({ ok: true, total: valid.length });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

// Send the composed message to the connected account itself, to preview it on the phone.
app.post('/api/test-send', async (req, res) => {
  const { wa, campaign } = req.ws;
  if (!wa.isConnected()) return fail(res, 400, 'Connect WhatsApp first (Step 1).');
  if (campaign.snapshot().status === 'running') return fail(res, 400, 'Wait until the running campaign is paused or finished.');
  const { messages, error } = resolveItems(req.ws, req.body?.items);
  if (error) return fail(res, 400, error);
  try {
    const jid = await wa.check(wa.state().me);
    if (!jid) return fail(res, 400, 'Could not find your own number on WhatsApp.');
    await wa.send(jid, messages);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post('/api/campaign/:action', (req, res) => {
  const { wa, campaign } = req.ws;
  const { action } = req.params;
  if (action === 'pause') campaign.pause('Paused by you.');
  else if (action === 'resume') {
    if (!wa.isConnected()) return fail(res, 400, 'Connect WhatsApp first.');
    campaign.resume().catch((e) => console.error(e));
  } else if (action === 'stop') campaign.stop();
  else return fail(res, 404, 'Unknown action');
  res.json(campaign.snapshot());
});

app.get('/api/campaign/results.csv', (req, res) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['number', 'status', 'detail', 'time'].join(',')];
  for (const r of req.ws.campaign.snapshot().rows) lines.push([esc('\t+' + r.number), esc(r.status), esc(r.error), esc(r.at)].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="whatsapp-results-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// unlink WhatsApp (not the account sign-out)
app.post('/api/logout', async (req, res) => {
  req.ws.campaign.pause('Paused: you logged out of WhatsApp.');
  await req.ws.wa.logout().catch((e) => console.error(e));
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  fail(res, 500, 'Something went wrong. Please try again.');
});

// ---------- live updates: each socket only joins its own user's room ----------
io.use(async (socket, next) => {
  try {
    const user = await accounts.userFromToken(readCookie(socket.handshake.headers.cookie, COOKIE));
    if (!user) return next(new Error('AUTH_REQUIRED'));
    if (accounts.isExpired(user)) return next(new Error('SUBSCRIPTION_ENDED'));
    socket.data.userId = String(user._id);
    next();
  } catch (e) {
    next(e);
  }
});
io.on('connection', (socket) => {
  const ws = workspaces.get(socket.data.userId);
  ws.ensureStarted();
  socket.join(workspaces.room(socket.data.userId));
  socket.emit('wa:state', ws.wa.state());
  socket.emit('campaign:update', ws.campaign.snapshot());
});

// a campaign left running must not continue past the end date
setInterval(async () => {
  for (const ws of workspaces.all()) {
    if (ws.campaign.snapshot().status !== 'running') continue;
    const user = await accounts.findById(ws.userId).catch(() => null);
    if (!user || accounts.isExpired(user)) {
      ws.campaign.pause(SUB_ENDED_NOTE);
      io.to(workspaces.room(ws.userId)).emit('subscription:ended', { message: subscriptionEndedMessage() });
    }
  }
}, 5 * 60_000).unref();

// graceful stop (deploys/restarts): campaign progress is already saved after every contact
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n  ${sig} received, shutting down…`);
    server.close();
    mongo.client.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use. The app may already be running — open http://localhost:${config.port}\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, '0.0.0.0', () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n  Bulk WhatsApp Sender running at ${url}\n  Keep this window open while sending. Press Ctrl+C to quit.\n`);
  if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" "${url}"`);
});
