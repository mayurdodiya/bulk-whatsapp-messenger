import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildSequence } from '../src/media.js';

const img = { path: 'u/a.jpg', mimetype: 'image/jpeg', originalName: 'a.jpg' };
const gif = { path: 'u/g.gif', mimetype: 'image/gif', originalName: 'g.gif' };
const pdf = { path: 'u/b.pdf', mimetype: 'application/pdf', originalName: 'Price list.pdf' };
const mp3 = { path: 'u/c.mp3', mimetype: 'audio/mpeg', originalName: 'c.mp3' };
const mp4 = { path: 'u/d.mp4', mimetype: 'video/mp4', originalName: 'd.mp4' };

test('classify', () => {
  assert.equal(classify('image/gif'), 'document');
  assert.equal(classify('image/heic'), 'document');
  assert.equal(classify('image/jpeg'), 'image');
  assert.equal(classify('image/png'), 'image');
  assert.equal(classify('video/mp4'), 'video');
  assert.equal(classify('video/quicktime'), 'document');
  assert.equal(classify('audio/ogg'), 'audio');
  assert.equal(classify('audio/mpeg'), 'audio');
  assert.equal(classify('audio/wav'), 'document');
  assert.equal(classify('application/pdf'), 'document');
  assert.equal(classify(''), 'document');
  assert.equal(classify(undefined), 'document');
});

test('keeps the user order; each file has its own caption', () => {
  const out = buildSequence([
    { type: 'file', file: pdf, caption: 'Our prices' },
    { type: 'text', text: '  Hello!  ' },
    { type: 'file', file: img, caption: 'Photo 1' },
    { type: 'file', file: mp4, caption: '' },
  ]);
  assert.deepEqual(out, [
    { document: { url: 'u/b.pdf' }, mimetype: 'application/pdf', fileName: 'Price list.pdf', caption: 'Our prices' },
    { text: 'Hello!' },
    { image: { url: 'u/a.jpg' }, caption: 'Photo 1' },
    { video: { url: 'u/d.mp4' }, mimetype: 'video/mp4' },
  ]);
});

test('audio cannot carry a caption: caption goes as a text just before it', () => {
  assert.deepEqual(buildSequence([{ type: 'file', file: mp3, caption: 'Listen' }]), [
    { text: 'Listen' },
    { audio: { url: 'u/c.mp3' }, mimetype: 'audio/mpeg' },
  ]);
});

test('gif goes as a document; empty text items are dropped', () => {
  assert.deepEqual(buildSequence([{ type: 'text', text: '   ' }, { type: 'file', file: gif }]), [
    { document: { url: 'u/g.gif' }, mimetype: 'image/gif', fileName: 'g.gif' },
  ]);
});

test('nothing → empty', () => {
  assert.deepEqual(buildSequence([]), []);
  assert.deepEqual(buildSequence(undefined), []);
});
