// Local web server: serves the UI, handles uploads, and wires WhatsApp + Campaign.
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { Campaign, DISCONNECT_NOTE, DEFAULT_SETTINGS } from './campaign.js';
import { parseContacts } from './contacts.js';
import { DraftStore, MAX_DRAFTS } from './drafts.js';
import { buildSequence, classify } from './media.js';
import { WhatsAppClient } from './whatsapp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_MB = 64;
const LARGE_CAMPAIGN = 200;
const DIRS = { auth: path.join(ROOT, 'auth'), uploads: path.join(ROOT, 'uploads'), data: path.join(ROOT, 'data') };
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// ---------- uploads registry ----------
const REGISTRY = path.join(DIRS.data, 'uploads.json');
let uploads = {};
try {
  uploads = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
} catch {
  uploads = {};
}
const saveUploads = () => fs.writeFileSync(REGISTRY, JSON.stringify(uploads, null, 2));
const publicUpload = ({ id, originalName, mimetype, size }) => ({ id, originalName, mimetype, size, kind: classify(mimetype) });

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.uploads,
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
});

// ---------- core services ----------
const wa = new WhatsAppClient({ authDir: DIRS.auth });
const campaign = new Campaign({ sender: wa, file: path.join(DIRS.data, 'campaign.json') });
campaign.load();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

wa.on('state', (s) => io.emit('wa:state', s));
wa.on('connected', () => {
  const s = campaign.snapshot();
  if (s.status === 'paused' && s.note === DISCONNECT_NOTE) campaign.resume();
});
campaign.on('update', (s) => {
  io.emit('campaign:update', s);
  // Files removed from the composer while a campaign used them can go once it ends.
  if (s.status === 'done' || s.status === 'stopped') {
    const kept = new Set(Object.values(uploads).map((u) => u.path));
    for (const m of s.messages || []) {
      const p = (m.image || m.video || m.audio || m.document)?.url;
      if (p && !kept.has(p)) fs.rm(p, { force: true }, () => {});
    }
  }
});
io.on('connection', (socket) => {
  socket.emit('wa:state', wa.state());
  socket.emit('campaign:update', campaign.snapshot());
});

app.use(express.json({ limit: '5mb' }));
// no-store: after an update the browser always loads the newest page, never a stale copy
app.use(express.static(path.join(ROOT, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

const fail = (res, status, message) => res.status(status).json({ error: message });

app.get('/api/config', (_req, res) => res.json({ defaults: DEFAULT_SETTINGS, maxFileMb: MAX_FILE_MB, largeCampaign: LARGE_CAMPAIGN }));

app.post('/api/contacts/parse', (req, res) => {
  const { raw = '', countryCode = '' } = req.body || {};
  res.json(parseContacts(raw, countryCode));
});

app.get('/api/uploads', (_req, res) => res.json(Object.values(uploads).map(publicUpload)));

app.post('/api/upload', (req, res) => {
  upload.array('files')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_FILE_MB} MB` : err.message;
      return fail(res, 400, msg);
    }
    const added = (req.files || []).map((f) => {
      const id = path.basename(f.filename, path.extname(f.filename));
      // multer decodes names as latin1; restore UTF-8 so non-English names survive
      const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      uploads[id] = { id, path: f.path, originalName, mimetype: f.mimetype || 'application/octet-stream', size: f.size };
      return publicUpload(uploads[id]);
    });
    saveUploads();
    res.json(added);
  });
});

app.get('/api/upload/:id/file', (req, res) => {
  const item = uploads[req.params.id];
  if (!item || !fs.existsSync(item.path)) return res.status(404).end();
  res.type(item.mimetype).sendFile(item.path);
});

app.delete('/api/upload/:id', (req, res) => {
  const item = uploads[req.params.id];
  if (!item) return fail(res, 404, 'Not found');
  const s = campaign.snapshot();
  const inUse = ['running', 'paused'].includes(s.status) && JSON.stringify(s.messages).includes(JSON.stringify(item.path));
  delete uploads[item.id];
  saveUploads();
  if (!inUse) fs.rm(item.path, { force: true }, () => {});
  res.json({ ok: true });
});

// Resolve the client's ordered items (text blocks + uploaded files with captions).
function resolveItems(items) {
  if (!Array.isArray(items)) return { error: 'Message is empty' };
  const resolved = [];
  for (const it of items) {
    if (it?.type === 'text') resolved.push({ type: 'text', text: String(it.text || '') });
    else if (it?.type === 'file') {
      const file = uploads[it.uploadId];
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

// ---------- drafts (MAX_DRAFTS slots, stored in data/drafts) ----------
const drafts = new DraftStore({ dir: path.join(DIRS.data, 'drafts') });

// copy a draft's file into uploads as a fresh upload the composer can own
function importUpload(srcPath, meta) {
  const id = crypto.randomUUID();
  const dest = path.join(DIRS.uploads, id + path.extname(meta.originalName || srcPath).toLowerCase());
  fs.copyFileSync(srcPath, dest);
  uploads[id] = { id, path: dest, originalName: meta.originalName, mimetype: meta.mimetype, size: meta.size };
  saveUploads();
  return publicUpload(uploads[id]);
}

app.get('/api/drafts', (_req, res) => res.json({ max: MAX_DRAFTS, drafts: drafts.list() }));

app.put('/api/drafts/:slot', (req, res) => {
  try {
    const saved = drafts.save(req.params.slot, { name: req.body?.name, items: req.body?.items }, (id) => uploads[id]);
    res.json(saved);
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.patch('/api/drafts/:slot/name', (req, res) => {
  try {
    drafts.rename(req.params.slot, req.body?.name);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.delete('/api/drafts/:slot', (req, res) => {
  try {
    drafts.remove(req.params.slot);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.post('/api/drafts/:slot/apply', (req, res) => {
  try {
    res.json({ items: drafts.materialize(req.params.slot, importUpload) });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.post('/api/campaign/start', (req, res) => {
  const { raw = '', items = [], settings = {} } = req.body || {};
  if (!wa.isConnected()) return fail(res, 400, 'Connect WhatsApp first (Step 1).');
  const { valid, withoutCode } = parseContacts(raw, '');
  if (!valid.length) return fail(res, 400, 'Add at least one valid contact (Step 2).');
  if (withoutCode) return fail(res, 400, `${withoutCode} number(s) have no country code. Click Apply in Step 2.`);
  const { messages, display, error } = resolveItems(items);
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
  if (!wa.isConnected()) return fail(res, 400, 'Connect WhatsApp first (Step 1).');
  if (campaign.snapshot().status === 'running') return fail(res, 400, 'Wait until the running campaign is paused or finished.');
  const { messages, error } = resolveItems(req.body?.items);
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
  const { action } = req.params;
  if (action === 'pause') campaign.pause('Paused by you.');
  else if (action === 'resume') {
    if (!wa.isConnected()) return fail(res, 400, 'Connect WhatsApp first.');
    campaign.resume().catch((e) => console.error(e));
  } else if (action === 'stop') campaign.stop();
  else return fail(res, 404, 'Unknown action');
  res.json(campaign.snapshot());
});

app.get('/api/campaign/results.csv', (_req, res) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['number', 'status', 'detail', 'time'].join(',')];
  for (const r of campaign.snapshot().rows) lines.push([esc('\t+' + r.number), esc(r.status), esc(r.error), esc(r.at)].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="whatsapp-results-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

app.post('/api/logout', async (_req, res) => {
  campaign.pause('Paused: you logged out of WhatsApp.');
  await wa.logout().catch((e) => console.error(e));
  res.json({ ok: true });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. The app may already be running — open http://localhost:${PORT}\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Bulk WhatsApp Sender running at ${url}\n  Keep this window open while sending. Press Ctrl+C to quit.\n`);
  if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" "${url}"`);
  wa.start().catch((e) => console.error('WhatsApp start failed:', e));
});
