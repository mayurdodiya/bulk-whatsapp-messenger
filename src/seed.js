// Seeder: create the admin account from .env (or reset its password/name if it exists).
// Usage: npm run seed
import { config, subscriptionEndedMessage } from './config.js';
import { Accounts } from './accounts.js';
import { connectDb } from './db.js';

const mongo = await connectDb({ uri: config.mongoUri, dnsFallback: config.dnsFallback });
try {
  const accounts = new Accounts({
    users: mongo.users, sessions: mongo.sessions, timeZone: config.timeZone,
    sessionDays: config.sessionDays, expiredMessage: subscriptionEndedMessage,
  });
  const admin = await accounts.seedAdmin({ email: config.adminEmail, password: config.adminPassword, name: config.adminName });
  console.log(`Admin ready: ${admin.email} (password from ADMIN_PASSWORD in .env)`);
} finally {
  await mongo.client.close();
}
