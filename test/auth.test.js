import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, normalizeEmail, todayIn, isExpired, subscriptionInfo,
  validateUserInput, newToken, tokenHash, LoginLimiter,
} from '../src/auth.js';

test('password hashing: verifies the right password only, salted', async () => {
  const h = await hashPassword('mayur@123');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('mayur@123'));
  assert.equal(await verifyPassword('mayur@123', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.notEqual(await hashPassword('mayur@123'), h);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Mayur@Gmail.COM '), 'mayur@gmail.com');
});

test('todayIn gives the calendar date in a timezone', () => {
  // 2026-11-24 20:00 UTC is already 25 Nov in India
  const d = new Date('2026-11-24T20:00:00Z');
  assert.equal(todayIn('Asia/Kolkata', d), '2026-11-25');
  assert.equal(todayIn('UTC', d), '2026-11-24');
});

test('end date is inclusive; admin (null) never expires', () => {
  assert.equal(isExpired('2026-11-24', '2026-11-24'), false);
  assert.equal(isExpired('2026-11-24', '2026-11-25'), true);
  assert.equal(isExpired(null, '2099-01-01'), false);
});

test('subscriptionInfo states', () => {
  assert.deepEqual(subscriptionInfo({ role: 'admin', endDate: null }, '2026-11-24'), { status: 'admin', daysLeft: null });
  assert.deepEqual(subscriptionInfo({ role: 'user', endDate: '2026-11-30' }, '2026-11-24'), { status: 'expiring', daysLeft: 6 });
  assert.deepEqual(subscriptionInfo({ role: 'user', endDate: '2026-12-31' }, '2026-11-24'), { status: 'active', daysLeft: 37 });
  assert.deepEqual(subscriptionInfo({ role: 'user', endDate: '2026-11-23' }, '2026-11-24'), { status: 'expired', daysLeft: -1 });
});

test('validateUserInput', () => {
  const ok = validateUserInput({ name: ' Shop ', email: 'A@b.com', password: 'secret12', endDate: '2026-12-31' }, { requirePassword: true });
  assert.deepEqual(ok, { value: { name: 'Shop', email: 'a@b.com', password: 'secret12', endDate: '2026-12-31' } });
  assert.match(validateUserInput({ email: 'bad', password: 'secret12', endDate: '2026-12-31' }, { requirePassword: true }).error, /email/i);
  assert.match(validateUserInput({ email: 'a@b.com', password: '123', endDate: '2026-12-31' }, { requirePassword: true }).error, /6 characters/);
  assert.match(validateUserInput({ email: 'a@b.com', password: 'secret12', endDate: '31-12-2026' }, { requirePassword: true }).error, /end date/i);
  assert.match(validateUserInput({ email: 'a@b.com', endDate: '2026-12-31' }, { requirePassword: true }).error, /password/i);
  // editing: password optional
  assert.deepEqual(validateUserInput({ email: 'a@b.com', endDate: '2026-12-31' }, { requirePassword: false }).value.password, undefined);
});

test('tokens are random and stored hashed', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.equal(tokenHash(a), tokenHash(a));
  assert.notEqual(tokenHash(a), a);
});

test('LoginLimiter locks after too many failures and resets on success', () => {
  let now = 0;
  const lim = new LoginLimiter({ max: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) lim.fail('k');
  assert.equal(lim.blocked('k'), true);
  now = 1500;
  assert.equal(lim.blocked('k'), false);
  lim.fail('k');
  lim.success('k');
  assert.equal(lim.blocked('k'), false);
});
