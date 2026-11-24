// One workspace per user: their own WhatsApp session, uploads, drafts and campaign.
// Files live on disk under data/users/<userId>/; draft metadata lives in MongoDB.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Campaign, DISCONNECT_NOTE } from './campaign.js';
import { DraftStore, MongoDraftIndex } from './drafts.js';
import { classify } from './media.js';
import { WhatsAppClient } from './whatsapp.js';

export const publicUpload = ({ id, originalName, mimetype, size }) => ({ id, originalName, mimetype, size, kind: classify(mimetype) });

export class Workspace {
  constructor({ userId, dir, draftsCollection }) {
    this.userId = userId;
    this.dir = dir;
    this.dirs = { auth: path.join(dir, 'auth'), uploads: path.join(dir, 'uploads'), drafts: path.join(dir, 'drafts') };
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });

    this.registryFile = path.join(dir, 'uploads.json');
    try {
      this.uploads = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    } catch {
      this.uploads = {};
    }

    this.wa = new WhatsAppClient({ authDir: this.dirs.auth });
    this.campaign = new Campaign({ sender: this.wa, file: path.join(dir, 'campaign.json') });
    this.campaign.load();
    this.drafts = new DraftStore({ dir: this.dirs.drafts, index: new MongoDraftIndex(draftsCollection, userId) });
    this.started = false;

    this.wa.on('connected', () => {
      const s = this.campaign.snapshot();
      if (s.status === 'paused' && s.note === DISCONNECT_NOTE) this.campaign.resume();
    });
    this.campaign.on('update', (s) => {
      // Files removed from the composer while a campaign used them can go once it ends.
      if (s.status === 'done' || s.status === 'stopped') {
        const kept = new Set(Object.values(this.uploads).map((u) => u.path));
        for (const m of s.messages || []) {
          const p = (m.image || m.video || m.audio || m.document)?.url;
          if (p && !kept.has(p) && p.startsWith(this.dirs.uploads)) fs.rm(p, { force: true }, () => {});
        }
      }
    });
  }

  /** Connect WhatsApp the first time the user opens the app. */
  ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.wa.start().catch((e) => console.error(`WhatsApp start failed (${this.userId}):`, e));
  }

  saveUploads() {
    fs.writeFileSync(this.registryFile, JSON.stringify(this.uploads, null, 2));
  }

  addUpload(file) {
    const id = path.basename(file.filename, path.extname(file.filename));
    // multer decodes names as latin1; restore UTF-8 so non-English names survive
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    this.uploads[id] = { id, path: file.path, originalName, mimetype: file.mimetype || 'application/octet-stream', size: file.size };
    return publicUpload(this.uploads[id]);
  }

  removeUpload(id) {
    const item = this.uploads[id];
    if (!item) return false;
    const s = this.campaign.snapshot();
    const inUse = ['running', 'paused'].includes(s.status) && JSON.stringify(s.messages).includes(JSON.stringify(item.path));
    delete this.uploads[id];
    this.saveUploads();
    if (!inUse) fs.rm(item.path, { force: true }, () => {});
    return true;
  }

  /** Copy a draft's file into uploads as a fresh upload the composer can own. */
  importUpload(srcPath, meta) {
    const id = crypto.randomUUID();
    const dest = path.join(this.dirs.uploads, id + path.extname(meta.originalName || srcPath).toLowerCase());
    fs.copyFileSync(srcPath, dest);
    this.uploads[id] = { id, path: dest, originalName: meta.originalName, mimetype: meta.mimetype, size: meta.size };
    this.saveUploads();
    return publicUpload(this.uploads[id]);
  }

  /** Stop everything and delete this user's files (account deleted). */
  async destroy() {
    this.campaign.stop();
    await this.wa.close({ logout: true });
    await this.drafts.removeAll().catch(() => {});
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Creates workspaces on demand and forwards their events to that user's sockets. */
export class Workspaces {
  constructor({ root, draftsCollection, io }) {
    this.root = root;
    this.draftsCollection = draftsCollection;
    this.io = io;
    this.map = new Map();
  }

  room(userId) {
    return `u:${userId}`;
  }

  get(userId) {
    const id = String(userId);
    let ws = this.map.get(id);
    if (!ws) {
      ws = new Workspace({ userId: id, dir: path.join(this.root, id), draftsCollection: this.draftsCollection });
      ws.wa.on('state', (s) => this.io.to(this.room(id)).emit('wa:state', s));
      ws.campaign.on('update', (s) => this.io.to(this.room(id)).emit('campaign:update', s));
      this.map.set(id, ws);
    }
    return ws;
  }

  peek(userId) {
    return this.map.get(String(userId)) || null;
  }

  all() {
    return [...this.map.values()];
  }

  async remove(userId) {
    const id = String(userId);
    const ws = this.map.get(id) || (fs.existsSync(path.join(this.root, id)) ? this.get(id) : null);
    this.map.delete(id);
    if (ws) await ws.destroy();
  }
}

/**
 * One-time move of the old single-user data (before accounts existed) into the admin's workspace:
 * auth/, uploads/, data/uploads.json, data/campaign.json, data/drafts/.
 */
export async function migrateLegacy({ projectRoot, dataDir, adminDir, draftsCollection, adminId }) {
  const marker = path.join(dataDir, '.migrated-to-accounts');
  if (fs.existsSync(marker)) return false;
  const oldAuth = path.join(projectRoot, 'auth');
  const oldUploads = path.join(projectRoot, 'uploads');
  const oldRegistry = path.join(dataDir, 'uploads.json');
  const oldCampaign = path.join(dataDir, 'campaign.json');
  const oldDrafts = path.join(dataDir, 'drafts');
  const anything = [oldAuth, oldUploads, oldRegistry, oldCampaign, oldDrafts].some((p) => fs.existsSync(p));
  if (!anything) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    return false;
  }

  fs.mkdirSync(adminDir, { recursive: true });
  const newUploads = path.join(adminDir, 'uploads');
  const move = (from, to) => {
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    fs.renameSync(from, to);
  };
  move(oldAuth, path.join(adminDir, 'auth'));
  move(oldUploads, newUploads);
  // absolute upload paths inside the JSON files must point to the new folder
  const rewrite = (from, to) => {
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    const text = fs.readFileSync(from, 'utf8');
    const fixed = text.split(JSON.stringify(oldUploads).slice(1, -1)).join(JSON.stringify(newUploads).slice(1, -1));
    fs.writeFileSync(to, fixed);
    fs.rmSync(from);
  };
  rewrite(oldRegistry, path.join(adminDir, 'uploads.json'));
  rewrite(oldCampaign, path.join(adminDir, 'campaign.json'));

  if (fs.existsSync(oldDrafts)) {
    const indexFile = path.join(oldDrafts, 'drafts.json');
    let index = {};
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
      index = {};
    }
    for (const d of Object.values(index)) {
      await draftsCollection.replaceOne({ userId: adminId, slot: d.slot }, { ...d, userId: adminId }, { upsert: true });
    }
    fs.rmSync(indexFile, { force: true });
    move(oldDrafts, path.join(adminDir, 'drafts'));
  }
  fs.writeFileSync(marker, new Date().toISOString());
  return true;
}
