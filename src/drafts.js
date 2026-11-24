// Saved message drafts (text + files + captions, in order).
// Draft *metadata* lives in an index (MongoDB in production, a JSON file in tests);
// each draft owns a copy of its files on disk under <dir>/slot-N/, so removing a file from
// the composer — or deleting the original upload — never breaks a saved draft.
import fs from 'node:fs';
import path from 'node:path';
import { classify } from './media.js';

export const MAX_DRAFTS = 2;

/** Index kept in a JSON file (used by tests and as a simple fallback). */
export class JsonDraftIndex {
  constructor(file) {
    this.file = file;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  async all() {
    return Object.values(this._read());
  }

  async get(slot) {
    return this._read()[slot] || null;
  }

  async put(doc) {
    const all = this._read();
    all[doc.slot] = doc;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
  }

  async remove(slot) {
    const all = this._read();
    delete all[slot];
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
  }
}

/** Index kept in a MongoDB collection, scoped to one user. */
export class MongoDraftIndex {
  constructor(collection, userId) {
    this.col = collection;
    this.userId = userId;
  }

  async all() {
    return this.col.find({ userId: this.userId }, { projection: { _id: 0, userId: 0 } }).toArray();
  }

  async get(slot) {
    return this.col.findOne({ userId: this.userId, slot }, { projection: { _id: 0, userId: 0 } });
  }

  async put(doc) {
    await this.col.replaceOne({ userId: this.userId, slot: doc.slot }, { ...doc, userId: this.userId }, { upsert: true });
  }

  async remove(slot) {
    await this.col.deleteOne({ userId: this.userId, slot });
  }
}

export class DraftStore {
  /** @param {{dir:string, index?:{all:Function,get:Function,put:Function,remove:Function}}} opts */
  constructor({ dir, index }) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.index = index || new JsonDraftIndex(path.join(dir, 'drafts.json'));
  }

  _slot(slot) {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DRAFTS) throw new Error(`Draft slot must be 1–${MAX_DRAFTS}`);
    return n;
  }

  /** Drafts for the UI, without server paths. */
  async list() {
    const docs = await this.index.all();
    return docs
      .sort((a, b) => a.slot - b.slot)
      .map((d) => ({
        slot: d.slot,
        name: d.name,
        savedAt: d.savedAt,
        items: d.items.map((it) => (it.type === 'text'
          ? { type: 'text', text: it.text }
          : { type: 'file', caption: it.caption, originalName: it.originalName, mimetype: it.mimetype, size: it.size, kind: classify(it.mimetype) })),
      }));
  }

  /**
   * Save the composer's items into a slot (overwrites it).
   * @param {(uploadId:string) => ({path:string, originalName:string, mimetype:string, size:number}|undefined)} lookupUpload
   */
  async save(slot, { name, items }, lookupUpload) {
    const n = this._slot(slot);
    const clean = [];
    for (const it of items || []) {
      if (it?.type === 'text') {
        if (String(it.text || '').trim()) clean.push({ type: 'text', text: String(it.text) });
      } else if (it?.type === 'file') {
        const up = lookupUpload(it.uploadId);
        if (!up || !fs.existsSync(up.path)) throw new Error('Some files are missing. Remove them and add them again.');
        clean.push({ type: 'file', up, caption: String(it.caption || '') });
      }
    }
    if (!clean.length) throw new Error('The message is empty — add text or a file before saving a draft.');

    // write the new copy next to the old one, then swap, so a failure never loses the old draft
    const finalDir = path.join(this.dir, `slot-${n}`);
    const tmpDir = path.join(this.dir, `slot-${n}.tmp`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const stored = clean.map((it, i) => {
      if (it.type === 'text') return it;
      const file = `${i + 1}${path.extname(it.up.originalName || it.up.path).toLowerCase()}`;
      fs.copyFileSync(it.up.path, path.join(tmpDir, file));
      return { type: 'file', file, caption: it.caption, originalName: it.up.originalName, mimetype: it.up.mimetype, size: it.up.size };
    });
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);

    await this.index.put({ slot: n, name: String(name || '').trim().slice(0, 60) || `Draft ${n}`, savedAt: new Date().toISOString(), items: stored });
    return (await this.list()).find((d) => d.slot === n);
  }

  async rename(slot, name) {
    const n = this._slot(slot);
    const d = await this.index.get(n);
    if (!d) throw new Error('There is no draft in this slot.');
    await this.index.put({ ...d, name: String(name || '').trim().slice(0, 60) || `Draft ${n}` });
  }

  async remove(slot) {
    const n = this._slot(slot);
    await this.index.remove(n);
    fs.rmSync(path.join(this.dir, `slot-${n}`), { recursive: true, force: true });
  }

  /** Remove every draft (used when a user is deleted). */
  async removeAll() {
    for (const d of await this.index.all()) await this.remove(d.slot);
  }

  /**
   * Turn a draft back into composer items. Files are handed to `importFile`, which must
   * copy them into the uploads area and return the new upload's public info ({id, ...}).
   */
  async materialize(slot, importFile) {
    const n = this._slot(slot);
    const d = await this.index.get(n);
    if (!d) throw new Error('There is no draft in this slot.');
    return d.items.map((it) => {
      if (it.type === 'text') return { type: 'text', text: it.text };
      const src = path.join(this.dir, `slot-${n}`, it.file);
      if (!fs.existsSync(src)) throw new Error(`A file of this draft is missing (${it.originalName}). Save the draft again.`);
      const up = importFile(src, { originalName: it.originalName, mimetype: it.mimetype, size: it.size });
      return { type: 'file', uploadId: up.id, caption: it.caption, originalName: up.originalName, mimetype: up.mimetype, size: up.size, kind: up.kind };
    });
  }
}
