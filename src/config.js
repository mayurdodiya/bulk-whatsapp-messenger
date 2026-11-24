// Settings from the environment (.env in the project root is loaded automatically).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI || '',
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminName: process.env.ADMIN_NAME || 'Admin',
  supportPhone: process.env.SUPPORT_PHONE || '',
  timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionDays: Number(process.env.SESSION_DAYS) || 7,
  dnsFallback: list(process.env.DNS_FALLBACK || '8.8.8.8,1.1.1.1'),
  dataDir: path.join(ROOT, 'data'),
};

export function subscriptionEndedMessage() {
  return `Your subscription has ended. Please contact ${config.supportPhone || 'the administrator'}.`;
}
