# Accounts, Subscriptions & Admin Panel — Design

Date: 2026-11-24

## Intent
Sell the tool to other businesses as a hosted service. The owner (admin) creates customer accounts (email, password, end date). Customers log in and use the sender until their end date. After it, login (and any further use) is refused with
"Your subscription has ended. Please contact +91 8347337661." Extending the date restores access immediately. The UI moves to an admin-panel layout with a sidebar.

## Goals
- Email + password login; secure sessions; logout.
- Admin: add / edit (name, email, password reset, end date) / delete users; seeded admin account.
- Subscription check on login, on every API call and on the live socket.
- **Per-customer workspaces**: each user has their own WhatsApp session, contacts, uploads, drafts, campaign and report.
- Sidebar layout; every existing flow keeps working unchanged.

## Non-goals
- Self sign-up, payments, invoices, password-reset email, multiple admins UI, roles beyond admin/user.

## Constraints
- MongoDB (given Atlas URI) for data; files (draft files, uploads, WhatsApp session) on the server's disk.
- Secrets (Mongo URI, admin seed credentials) only in a git-ignored `.env`; repo is on GitHub.
- On this Windows machine Node's DNS (127.0.0.1) refuses SRV lookups → fall back to public DNS for `mongodb+srv`.

## Approaches
- **A. One app, one workspace per customer (chosen).** One Node process; a lazily created Workspace (WhatsApp client + Campaign + uploads + drafts) per user. Simple to host/back up.
- B. One process per customer behind a gateway — stronger isolation, much more complexity.
- C. Full SaaS (DB-only + cloud storage) — overkill now.

## Data
MongoDB collections:
- `users` { email (unique, lowercase), name, passwordHash (scrypt), role 'admin'|'user', endDate 'YYYY-MM-DD'|null (admin: null = never), createdAt, updatedAt, lastLoginAt }
- `sessions` { _id: sha256(token), userId, expiresAt } — TTL index, 7 days
- `drafts` { userId, slot 1|2, name, savedAt, items[] } — unique (userId, slot); draft **files** on disk.

Server disk, per user `data/users/<userId>/`: `auth/` (WhatsApp), `uploads/` + `uploads.json`, `drafts/slot-N/`, `campaign.json` (written after every contact — stays a local file, as today).

## Behaviour (Claude's calls)
- End date is inclusive, compared as a calendar date in `APP_TIMEZONE` (default Asia/Kolkata).
- Expired while logged in: next request/socket gets `403 SUBSCRIPTION_ENDED`; UI shows a full-screen notice; a running campaign is paused.
- Deleting a user: logs out its sessions, unlinks its WhatsApp, deletes its folder and drafts.
- Admin also has a workspace and can send. Admin cannot delete or demote themselves.
- Login: 10 failed attempts per email+IP per 15 min → temporary lock. Cookie httpOnly, SameSite=Lax, Secure when `COOKIE_SECURE=true` (behind HTTPS).
- One-time migration: the existing single-user data (WhatsApp session, uploads, campaign, drafts) moves into the admin's workspace.
- Seeder: `npm run seed` upserts the admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`; the server also seeds automatically when no admin exists.

## UI
Sidebar: brand · **Workspace**: Connect & contacts, Message & send · **Admin** (admin only): Users · bottom: Settings, account card (name, plan "Active until …"/"Admin"), Log out. Mobile: off-canvas sidebar. Separate login page. Users page: search, table (name, email, end date, status Active/Expiring/Expired, last login), Add/Edit modal, Delete.

## Left to the builder
Exact styles, copy, file layout.
