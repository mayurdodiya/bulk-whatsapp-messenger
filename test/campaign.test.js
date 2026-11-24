import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Campaign } from '../src/campaign.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'camp-')), 'campaign.json');
const instant = async () => {};
const msgs = [{ text: 'hi' }];

function fakeSender(over = {}) {
  const sent = [];
  return {
    sent,
    check: async (n) => `${n}@s.whatsapp.net`,
    typing: async () => {},
    send: async (jid, messages) => { sent.push([jid, messages]); },
    ...over,
  };
}

test('sends to everyone and finishes done', async () => {
  const sender = fakeSender();
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  await c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  const s = c.snapshot();
  assert.equal(s.status, 'done');
  assert.deepEqual(s.rows.map((r) => r.status), ['sent', 'sent']);
  assert.equal(sender.sent.length, 2);
  assert.deepEqual(sender.sent[0][1], msgs);
});

test('not on WhatsApp → skipped', async () => {
  const sender = fakeSender({ check: async (n) => (n === '111111111' ? null : `${n}@s.whatsapp.net`) });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  await c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  assert.deepEqual(c.snapshot().rows.map((r) => r.status), ['skipped', 'sent']);
});

test('send error → failed with reason, continues', async () => {
  const sender = fakeSender({
    send: async (jid) => { if (jid.startsWith('111')) throw new Error('boom'); },
  });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  await c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  const rows = c.snapshot().rows;
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error, 'boom');
  assert.equal(rows[1].status, 'sent');
});

test('NOT_CONNECTED pauses and keeps row pending', async () => {
  const err = Object.assign(new Error('offline'), { code: 'NOT_CONNECTED' });
  const sender = fakeSender({ check: async () => { throw err; } });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  await c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  const s = c.snapshot();
  assert.equal(s.status, 'paused');
  assert.deepEqual(s.rows.map((r) => r.status), ['pending', 'pending']);
});

test('uses random delay between contacts within min..max seconds, none after last', async () => {
  const waits = [];
  const c = new Campaign({ sender: fakeSender(), file: tmpFile(), sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  await c.start({ numbers: ['111111111', '222222222', '333333333'], messages: msgs, settings: { minDelay: 10, maxDelay: 20 } });
  assert.deepEqual(waits, [15000, 15000]);
});

test('min delay floor is 3 seconds', async () => {
  const waits = [];
  const c = new Campaign({ sender: fakeSender(), file: tmpFile(), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
  await c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: { minDelay: 0, maxDelay: 1 } });
  assert.deepEqual(waits, [3000]);
});

test('batch rest after every N contacts', async () => {
  const waits = [];
  const c = new Campaign({ sender: fakeSender(), file: tmpFile(), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
  await c.start({ numbers: ['111111111', '222222222', '333333333'], messages: msgs, settings: { minDelay: 5, maxDelay: 5, batchSize: 2, batchRestMin: 2, batchRestMax: 5 } });
  assert.deepEqual(waits, [5000, 120000]);
});

test('stop during a long delay ends promptly', async () => {
  const sleep = (ms, signal) => new Promise((res) => signal.addEventListener('abort', res));
  const c = new Campaign({ sender: fakeSender(), file: tmpFile(), sleep });
  const run = c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  await new Promise((r) => setTimeout(r, 20));
  c.stop();
  await run;
  const s = c.snapshot();
  assert.equal(s.status, 'stopped');
  assert.deepEqual(s.rows.map((r) => r.status), ['sent', 'pending']);
});

test('pause then resume completes', async () => {
  const sleep = (ms, signal) => new Promise((res) => signal.addEventListener('abort', res));
  const c = new Campaign({ sender: fakeSender(), file: tmpFile(), sleep });
  const run = c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  await new Promise((r) => setTimeout(r, 20));
  c.pause();
  await run;
  assert.equal(c.snapshot().status, 'paused');
  c.sleep = instant;
  await c.resume();
  assert.equal(c.snapshot().status, 'done');
});

test('load() after crash: sending → pending, status paused', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ status: 'running', messages: msgs, settings: {}, rows: [
    { number: '111111111', status: 'sent' }, { number: '222222222', status: 'sending' }, { number: '333333333', status: 'pending' },
  ] }));
  const c = new Campaign({ sender: fakeSender(), file, sleep: instant });
  c.load();
  const s = c.snapshot();
  assert.equal(s.status, 'paused');
  assert.deepEqual(s.rows.map((r) => r.status), ['sent', 'pending', 'pending']);
  await c.resume();
  assert.equal(c.snapshot().status, 'done');
});

test('start while running throws', async () => {
  const sleep = (ms, signal) => new Promise((res) => signal.addEventListener('abort', res));
  const c = new Campaign({ sender: fakeSender(), file: tmpFile(), sleep });
  const run = c.start({ numbers: ['111111111', '222222222'], messages: msgs, settings: {} });
  assert.throws(() => c.start({ numbers: ['1'], messages: msgs, settings: {} }), /already/i);
  c.stop();
  await run;
});

test('partial send then disconnect: resume continues from the unsent part (no duplicates)', async () => {
  const calls = [];
  let failOnce = true;
  const sender = fakeSender({
    send: async (jid, m) => {
      if (m[0].text === 'two' && failOnce) { failOnce = false; throw Object.assign(new Error('x'), { code: 'NOT_CONNECTED' }); }
      calls.push(m[0].text);
    },
  });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  await c.start({ numbers: ['111111111'], messages: [{ text: 'one' }, { text: 'two' }], settings: {} });
  assert.equal(c.snapshot().status, 'paused');
  await c.resume();
  assert.deepEqual(calls, ['one', 'two']);
  assert.equal(c.snapshot().status, 'done');
});

function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }

test('stop while typing: contact is not sent the message', async () => {
  const g = gate();
  const sender = fakeSender({ typing: () => g.p });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  const run = c.start({ numbers: ['111111111'], messages: msgs, settings: {} });
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  g.open();
  await run;
  assert.equal(sender.sent.length, 0);
  assert.equal(c.snapshot().rows[0].status, 'pending');
});

test('new campaign started while old one is mid-row: old contact gets nothing, new one runs', async () => {
  const g = gate();
  let first = true;
  const sender = fakeSender({ typing: () => (first ? ((first = false), g.p) : Promise.resolve()) });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  c.start({ numbers: ['111111111'], messages: [{ text: 'old' }], settings: {} });
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const run2 = c.start({ numbers: ['222222222'], messages: [{ text: 'new' }], settings: {} });
  g.open();
  await run2;
  assert.deepEqual(sender.sent.map(([j, m]) => [j, m[0].text]), [['222222222@s.whatsapp.net', 'new']]);
  assert.equal(c.snapshot().status, 'done');
});

test('keeps a display copy of what is being sent, also after reload', async () => {
  const file = tmpFile();
  const display = [{ type: 'text', text: 'hi' }, { type: 'file', uploadId: 'u1', caption: 'pic', originalName: 'a.jpg', kind: 'image' }];
  const c = new Campaign({ sender: fakeSender(), file, sleep: instant });
  await c.start({ numbers: ['111111111'], messages: msgs, settings: {}, display });
  assert.deepEqual(c.snapshot().display, display);
  const c2 = new Campaign({ sender: fakeSender(), file, sleep: instant });
  c2.load();
  assert.deepEqual(c2.snapshot().display, display);
});

test('snapshot reports which number is being sent right now', async () => {
  const g = gate();
  const sender = fakeSender({ typing: () => g.p });
  const c = new Campaign({ sender, file: tmpFile(), sleep: instant });
  const run = c.start({ numbers: ['111111111'], messages: msgs, settings: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.snapshot().current, '111111111');
  g.open();
  await run;
  assert.equal(c.snapshot().current, null);
});
