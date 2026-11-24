// Saved message drafts (text + files + captions, in order), stored on this computer.
// Each draft owns a copy of its files under <dir>/slot-N/, so removing a file from the
// composer — or deleting the original upload — never breaks a saved draft.
import fs from 'node:fs';
import path from 'node:path';
import { classify } from './media.js';

export const MAX_DRAFTS = 2;

export class DraftStore {
  constructor({ dir }) {
    this.dir = dir;
    this.index = path.join(dir, 'drafts.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.drafts = JSON.parse(fs.readFileSync(this.index, 'utf8'));
    } catch {
      this.drafts = {};
    }
  }

  _slot(slot) {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DRAFTS) throw new Error(`Draft slot must be 1–${MAX_DRAFTS}`);
    return n;
  }

  _persist() {
    fs.writeFileSync(this.index, JSON.stringify(this.drafts, null, 2));
  }

  /** Drafts for the UI, without server paths. */
  list() {
    return Object.values(this.drafts)
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
   * @param {number} slot 1..MAX_DRAFTS
   * @param {{name:string, items:({type:'text',text:string}|{type:'file',uploadId:string,caption?:string})[]}} draft
   * @param {(uploadId:string) => ({path:string, originalName:string, mimetype:string, size:number}|undefined)} lookupUpload
   */
  save(slot, { name, items }, lookupUpload) {
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

    this.drafts[n] = { slot: n, name: String(name || '').trim().slice(0, 60) || `Draft ${n}`, savedAt: new Date().toISOString(), items: stored };
    this._persist();
    return this.list().find((d) => d.slot === n);
  }

  rename(slot, name) {
    const n = this._slot(slot);
    if (!this.drafts[n]) throw new Error('There is no draft in this slot.');
    this.drafts[n].name = String(name || '').trim().slice(0, 60) || `Draft ${n}`;
    this._persist();
  }

  remove(slot) {
    const n = this._slot(slot);
    delete this.drafts[n];
    this._persist();
    fs.rmSync(path.join(this.dir, `slot-${n}`), { recursive: true, force: true });
  }

  /**
   * Turn a draft back into composer items. Files are handed to `importFile`, which must
   * copy them into the uploads area and return the new upload's public info ({id, ...}).
   */
  materialize(slot, importFile) {
    const n = this._slot(slot);
    const d = this.drafts[n];
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
