// MongoDB connection + collections/indexes.
import dns from 'node:dns';
import { MongoClient } from 'mongodb';

/**
 * Some Windows setups use a local DNS that refuses SRV lookups, which breaks mongodb+srv:// URIs.
 * If the SRV record can't be resolved with the system DNS, retry with public DNS servers.
 */
async function ensureSrvResolvable(uri, fallback) {
  if (!uri.startsWith('mongodb+srv://') || !fallback?.length) return;
  const host = new URL(uri.replace(/^mongodb\+srv:/, 'https:')).hostname;
  try {
    await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
  } catch {
    dns.setServers(fallback);
  }
}

export async function connectDb({ uri, dnsFallback }) {
  if (!uri) throw new Error('MONGODB_URI is not set. Add it to the .env file.');
  await ensureSrvResolvable(uri, dnsFallback);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000 });
  await client.connect();
  const db = client.db();
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const drafts = db.collection('drafts');
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ userId: 1 }),
    drafts.createIndex({ userId: 1, slot: 1 }, { unique: true }),
  ]);
  return { client, db, users, sessions, drafts };
}
