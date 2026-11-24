# Bulk WhatsApp Sender

A tool that runs on your own PC and sends one message (text plus images, videos, audio, PDFs or documents) to a list of WhatsApp numbers, one at a time.

## Start
1. Install Node.js 20 or newer from https://nodejs.org (one time).
2. Double-click **start.bat**. The first run installs everything. Your browser opens **http://localhost:3000**.
3. Keep the black window open while messages are sending.

## Use
Everything is on one page:

1. **WhatsApp:** scan the QR code once, using WhatsApp → Linked devices → Link a device.
2. **Contacts:**
   - Paste numbers or import a .txt/.csv file.
   - Type the country code (e.g. `91`) and click **Apply to numbers**. Send stays locked until every number has a code.
3. **Message:**
   - Use **+ Text** and **+ Files**, or drag and drop. Every file has its own caption.
   - Drag ⠿, or use ▲ ▼, to set the order.
   - Drop a file on a text card, or click **Add photo / file**, to attach it with the text as its caption.
   - **Saved drafts:** 2 slots. **Save current message here** stores the message (text, files, captions and order) on this computer. Later, **Apply** loads it: add contacts and press Send. **Update**, **Rename** and **Delete** manage a draft.
4. **Send:** check the summary and press **Send**.
   - While sending, the Preview shows the message actually being sent ("Now sending"), and the message editor is locked.
   - Progress shows who is being messaged right now.

Change the sending speed with **⚙ Settings**: Safe, Recommended, Fast or Custom.

Drafts are stored in `data/drafts/`, with their own copy of each file. Back up that folder to keep them.

## Accounts & subscriptions
- Everyone signs in at `/login`. The **admin** creates customer accounts with an email, a password and a **subscription end date** (sidebar → **Users**).
- A customer can use the tool **up to and including** the end date. After that, signing in and every action show *"Your subscription has ended. Please contact +91 8347337661."* A running campaign is paused.
- To give access again, edit the user and move the end date (or click **+1 month**). They can sign in straight away.
- Every customer has their own workspace: their own WhatsApp link, contacts, message, drafts, uploads and report.
- Changing a user's password signs them out everywhere. Deleting a user also unlinks their WhatsApp and removes their files.

### Setup
1. Copy `.env.example` to `.env` and fill it in:
   - `MONGODB_URI`
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`
   - `SUPPORT_PHONE`, `APP_TIMEZONE`
2. Run `npm install`, then `npm run seed`. This creates the admin, or resets the admin password from `.env`. The server also creates the admin on first start if none exists.
3. Run `npm start`.

### Where data is stored
- **MongoDB:** users (passwords hashed with scrypt), sign-in sessions, and draft details.
- **Server disk (`data/users/<userId>/`):** WhatsApp session, uploaded files, draft files and campaign progress. Back up this folder.

### Hosting for customers
- Use a VPS (Linux or Windows) with Node.js 20+. Keep the app running with a process manager such as `pm2 start src/server.js --name bulk-sender`.
- Put it behind HTTPS (for example Nginx or Caddy with a free certificate) and set `COOKIE_SECURE=true` in `.env`.
- Each connected WhatsApp uses roughly 50–100 MB of RAM.
- `.env` holds your database password. It is git-ignored; never commit or share it.

## Safety (avoid bans)
- The default waits are 8–15 seconds between contacts, plus a 2–5 minute break after every 50. Don't make them much faster.
- Send only to people who expect your messages. Many "block" or "report spam" reports get numbers banned.
- New WhatsApp numbers should start with small lists, for example under 50 a day, and grow slowly.
- This tool uses an unofficial WhatsApp Web connection (Baileys). WhatsApp doesn't allow automated bulk messaging, so use it at your own risk.

## Good to know
- Progress is saved after every contact. If the PC or app restarts, open the page and press **Resume**.
- If WhatsApp disconnects while sending, sending pauses and continues on its own after it reconnects.
- Your login is stored in the `auth/` folder. **Log out** in the app, or delete that folder, to unlink.
- Run the tests with `npm test`.
