import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DraftStore, MAX_DRAFTS } from '../src/drafts.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-'));
  const src = path.join(root, 'src.png');
  fs.writeFileSync(src, 'PNGDATA');
  const uploads = { u1: { id: 'u1', path: src, originalName: 'banner.png', mimetype: 'image/png', size: 7 } };
  const store = new DraftStore({ dir: path.join(root, 'drafts') });
  return { root, src, uploads, store, lookup: (id) => uploads[id] };
}
const items = [
  { type: 'text', text: 'Hello' },
  { type: 'file', uploadId: 'u1', caption: 'Our banner' },
];

test('only 2 draft slots', async () => {
  assert.equal(MAX_DRAFTS, 2);
  const { store, lookup } = setup();
  await assert.rejects(() => store.save(3, { name: 'x', items }, lookup), /slot/i);
  await assert.rejects(() => store.save(0, { name: 'x', items }, lookup), /slot/i);
});

test('save + list returns a summary without server paths', async () => {
  const { store, lookup } = setup();
  await store.save(1, { name: '  Diwali offer ', items }, lookup);
  const [d] = await store.list();
  assert.equal(d.slot, 1);
  assert.equal(d.name, 'Diwali offer');
  assert.ok(d.savedAt);
  assert.deepEqual(d.items, [
    { type: 'text', text: 'Hello' },
    { type: 'file', caption: 'Our banner', originalName: 'banner.png', mimetype: 'image/png', size: 7, kind: 'image' },
  ]);
  assert.ok(!JSON.stringify(d).includes(path.sep + 'src.png'));
});

test('draft keeps its own copy of files (survives deleting the upload)', async () => {
  const { store, lookup, src } = setup();
  await store.save(1, { name: 'A', items }, lookup);
  fs.rmSync(src);
  const imported = [];
  const out = await store.materialize(1, (filePath, meta) => {
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'PNGDATA');
    imported.push(meta.originalName);
    return { id: 'new1', originalName: meta.originalName, mimetype: meta.mimetype, size: meta.size, kind: 'image' };
  });
  assert.deepEqual(imported, ['banner.png']);
  assert.deepEqual(out, [
    { type: 'text', text: 'Hello' },
    { type: 'file', uploadId: 'new1', caption: 'Our banner', originalName: 'banner.png', mimetype: 'image/png', size: 7, kind: 'image' },
  ]);
});

test('overwriting a slot replaces old files; delete removes it', async () => {
  const { store, lookup } = setup();
  await store.save(2, { name: 'A', items }, lookup);
  await store.save(2, { name: 'B', items: [{ type: 'text', text: 'only text' }] }, lookup);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.list())[0].name, 'B');
  assert.deepEqual(fs.readdirSync(path.join(store.dir, 'slot-2')), []);
  await store.remove(2);
  assert.deepEqual((await store.list()), []);
  assert.ok(!fs.existsSync(path.join(store.dir, 'slot-2')));
});

test('persists across instances', async () => {
  const { store, lookup } = setup();
  await store.save(1, { name: 'A', items }, lookup);
  const again = new DraftStore({ dir: store.dir });
  assert.equal((await again.list())[0].name, 'A');
});

test('rejects empty drafts, missing files, and unnamed drafts get a default name', async () => {
  const { store, lookup } = setup();
  await assert.rejects(() => store.save(1, { name: 'x', items: [{ type: 'text', text: '  ' }] }, lookup), /empty/i);
  await assert.rejects(() => store.save(1, { name: 'x', items: [{ type: 'file', uploadId: 'nope' }] }, lookup), /missing/i);
  await store.save(1, { name: '', items }, lookup);
  assert.equal((await store.list())[0].name, 'Draft 1');
});

test('applying a missing slot throws', async () => {
  const { store } = setup();
  await assert.rejects(() => store.materialize(1, () => ({})), /no draft/i);
});

test('rename keeps content and files', async () => {
  const { store, lookup } = setup();
  await store.save(1, { name: 'A', items }, lookup);
  await store.rename(1, '  New name  ');
  const [d] = await store.list();
  assert.equal(d.name, 'New name');
  assert.equal(d.items.length, 2);
  await assert.rejects(() => store.rename(2, 'x'), /no draft/i);
});

test('removeAll deletes every draft and its files', async () => {
  const { store, lookup } = setup();
  await store.save(1, { name: 'A', items }, lookup);
  await store.save(2, { name: 'B', items }, lookup);
  await store.removeAll();
  assert.deepEqual(await store.list(), []);
  assert.ok(!fs.existsSync(path.join(store.dir, 'slot-1')));
});
