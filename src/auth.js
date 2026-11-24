// Accounts & subscriptions: pure helpers (hashing, dates, validation, tokens, rate limit).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

/** "scrypt$<salt hex>$<hash hex>" */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/** Calendar date 'YYYY-MM-DD' in the given IANA timezone. */
export function todayIn(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** End date is inclusive. null = never expires. */
export const isExpired = (endDate, today) => !!endDate && endDate < today;

const dayNumber = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000;

/** @returns {{status:'admin'|'active'|'expiring'|'expired', daysLeft:number|null}} */
export function subscriptionInfo(user, today) {
  if (user.role === 'admin' || !user.endDate) return { status: 'admin', daysLeft: null };
  const daysLeft = dayNumber(user.endDate) - dayNumber(today);
  if (daysLeft < 0) return { status: 'expired', daysLeft };
  return { status: daysLeft <= 7 ? 'expiring' : 'active', daysLeft };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate admin input for creating/editing a user. */
export function validateUserInput(input, { requirePassword }) {
  const name = String(input.name || '').trim().slice(0, 80);
  const email = normalizeEmail(input.email);
  const password = input.password === undefined || input.password === null || input.password === '' ? undefined : String(input.password);
  const endDate = String(input.endDate || '').trim();
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };
  if (requirePassword && !password) return { error: 'Enter a password.' };
  if (password !== undefined && password.length < 6) return { error: 'Password must be at least 6 characters.' };
  if (!DATE_RE.test(endDate) || Number.isNaN(Date.parse(endDate))) return { error: 'Choose a valid end date.' };
  return { value: { name, email, password, endDate } };
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Counts failed logins per key; blocks after `max` failures inside `windowMs`. */
export class LoginLimiter {
  constructor({ max = 10, windowMs = 15 * 60_000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  _entry(key) {
    const e = this.hits.get(key);
    if (e && this.now() - e.start > this.windowMs) {
      this.hits.delete(key);
      return null;
    }
    return e;
  }

  blocked(key) {
    const e = this._entry(key);
    return !!e && e.count >= this.max;
  }

  fail(key) {
    const e = this._entry(key) || { start: this.now(), count: 0 };
    e.count++;
    this.hits.set(key, e);
  }

  success(key) {
    this.hits.delete(key);
  }
}
