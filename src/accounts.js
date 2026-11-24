// Users, sessions and subscriptions (MongoDB).
import { ObjectId } from 'mongodb';
import {
  hashPassword, verifyPassword, normalizeEmail, todayIn, isExpired, subscriptionInfo,
  validateUserInput, newToken, tokenHash,
} from './auth.js';

export class Accounts {
  constructor({ users, sessions, timeZone, sessionDays, expiredMessage }) {
    this.users = users;
    this.sessions = sessions;
    this.timeZone = timeZone;
    this.sessionMs = sessionDays * 86_400_000;
    this.expiredMessage = expiredMessage;
  }

  today() {
    return todayIn(this.timeZone);
  }

  isExpired(user) {
    return user.role !== 'admin' && isExpired(user.endDate, this.today());
  }

  publicUser(u) {
    return {
      id: String(u._id), name: u.name || '', email: u.email, role: u.role, endDate: u.endDate ?? null,
      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt ?? null,
      subscription: subscriptionInfo(u, this.today()),
    };
  }

  _id(id) {
    try {
      return new ObjectId(String(id));
    } catch {
      return null;
    }
  }

  findById(id) {
    const _id = this._id(id);
    return _id ? this.users.findOne({ _id }) : null;
  }

  findAdmin() {
    return this.users.findOne({ role: 'admin' }, { sort: { createdAt: 1 } });
  }

  /** Create the admin, or reset its password/name if it already exists. */
  async seedAdmin({ email, password, name }) {
    const e = normalizeEmail(email);
    if (!e || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
    const now = new Date();
    const passwordHash = await hashPassword(password);
    const res = await this.users.findOneAndUpdate(
      { email: e },
      { $set: { email: e, name, role: 'admin', endDate: null, passwordHash, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: 'after' },
    );
    return res;
  }

  // ---------- login & sessions ----------

  /** @returns {Promise<{user?:object, error?:string, code?:string}>} */
  async login(email, password) {
    const user = await this.users.findOne({ email: normalizeEmail(email) });
    if (!user || !(await verifyPassword(password, user.passwordHash))) return { error: 'Incorrect email or password.', code: 'BAD_LOGIN' };
    if (this.isExpired(user)) return { error: this.expiredMessage(), code: 'SUBSCRIPTION_ENDED' };
    await this.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    return { user };
  }

  async createSession(userId) {
    const token = newToken();
    await this.sessions.insertOne({ _id: tokenHash(token), userId: String(userId), createdAt: new Date(), expiresAt: new Date(Date.now() + this.sessionMs) });
    return token;
  }

  /** User for a session token, or null. */
  async userFromToken(token) {
    if (!token) return null;
    const s = await this.sessions.findOne({ _id: tokenHash(token) });
    if (!s || s.expiresAt < new Date()) return null;
    return this.findById(s.userId);
  }

  logout(token) {
    return this.sessions.deleteOne({ _id: tokenHash(token) });
  }

  // ---------- admin ----------

  async list() {
    const all = await this.users.find({}).sort({ role: 1, createdAt: -1 }).toArray();
    return all.map((u) => this.publicUser(u));
  }

  async create(input) {
    const { value, error } = validateUserInput(input, { requirePassword: true });
    if (error) return { error };
    if (await this.users.findOne({ email: value.email })) return { error: 'A user with this email already exists.' };
    const now = new Date();
    const doc = {
      email: value.email, name: value.name, role: 'user', endDate: value.endDate,
      passwordHash: await hashPassword(value.password), createdAt: now, updatedAt: now, lastLoginAt: null,
    };
    const { insertedId } = await this.users.insertOne(doc);
    return { user: this.publicUser({ ...doc, _id: insertedId }) };
  }

  async update(id, input) {
    const user = await this.findById(id);
    if (!user) return { error: 'User not found.' };
    const isAdmin = user.role === 'admin';
    // the admin has no end date; keep validation happy with a placeholder
    const { value, error } = validateUserInput({ ...input, endDate: isAdmin ? '2999-12-31' : input.endDate }, { requirePassword: false });
    if (error) return { error };
    if (value.email !== user.email && await this.users.findOne({ email: value.email })) return { error: 'A user with this email already exists.' };
    const set = { email: value.email, name: value.name, updatedAt: new Date() };
    if (!isAdmin) set.endDate = value.endDate;
    if (value.password) set.passwordHash = await hashPassword(value.password);
    await this.users.updateOne({ _id: user._id }, { $set: set });
    // a password change signs the user out everywhere
    if (value.password) await this.sessions.deleteMany({ userId: String(user._id) });
    return { user: this.publicUser({ ...user, ...set }) };
  }

  async remove(id) {
    const user = await this.findById(id);
    if (!user) return { error: 'User not found.' };
    if (user.role === 'admin') return { error: 'The admin account cannot be deleted.' };
    await this.users.deleteOne({ _id: user._id });
    await this.sessions.deleteMany({ userId: String(user._id) });
    return { ok: true };
  }
}
