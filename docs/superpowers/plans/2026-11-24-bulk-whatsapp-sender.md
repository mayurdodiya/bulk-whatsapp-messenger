# Bulk WhatsApp Sender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local web app that links WhatsApp by QR and sends one text+media message to a pasted list of numbers, one by one, with throttling and live progress.

**Architecture:** Node ESM server (Express + Socket.IO) wraps a Baileys socket (`src/whatsapp.js`) and a pure, injectable campaign runner (`src/campaign.js`). Pure helpers (`contacts.js`, `media.js`) are unit-tested. Static single-page UI in `public/`.

**Tech Stack:** Node 24, `baileys@7.0.0-rc14`, express, socket.io, multer, qrcode, pino, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-24-bulk-whatsapp-sender-design.md`

## Global Constraints
- `"type": "module"`; `npm start` runs `node src/server.js`; `npm test` runs `node --test test/`.
- Port 3000; opens browser on start. Folders: `auth/`, `uploads/`, `data/` (created at runtime, git-ignored).
- Delay defaults 8–15 s, floor 3 s; batch rest every 50 contacts for 2–5 min; warning > 200 contacts.
- Upload limit 64 MB per file. Valid number = 8–15 digits.
- Not a git repo: commit steps are skipped.

## Review Focus
1. Numbers pasted with spaces/dashes/brackets inside (`+91 98765-43210`, `(022) 1234 5678`) → one clean number, not split. Test in Task 1.
2. Number already containing the country code (`919876543210` with code `91`) → not doubled. Test in Task 1.
3. Connection drops mid-campaign → campaign pauses, does not mark remaining contacts failed. Test in Task 3 (sender throws `NOT_CONNECTED`).
4. Server restart mid-campaign → state reloaded with `sending` rows reset to `pending`, status `paused`. Test in Task 3.
5. Stop during a long delay → stops promptly (sleep is abortable). Test in Task 3.

---

### Task 1: Project scaffold + contact parsing
**Files:** Create `package.json`, `.gitignore`, `start.bat`, `src/contacts.js`, `test/contacts.test.js`
**Produces:** `parseContacts(raw: string, countryCode: string) -> { valid: string[], invalid: string[], duplicates: number }` (valid = digit strings, no `+`).
- [ ] Tests: `'+91 98765-43210'` code `''` → valid `['919876543210']`; `'9876543210'` code `'+91'` → `['919876543210']`; `'09876543210'` code `91` → `['919876543210']`; `'919876543210'` code `91` → not doubled; `'0044 7911 123456'` → `['447911123456']`; split on `\n , ; \t`; `'123'` → invalid; duplicates counted; blank lines ignored.
- [ ] Implement per spec rules; run `npm test` → PASS.

### Task 2: Media classification + message building
**Files:** Create `src/media.js`, `test/media.test.js`
**Produces:** `classify(mimetype) -> 'image'|'video'|'audio'|'document'`; `buildMessages(text, attachments: {path, mimetype, originalName}[]) -> object[]` (Baileys content objects using `{url: path}`).
- [ ] Tests: `image/gif`→image, `application/pdf`→document, `''`→document; text only → `[{text}]`; text+image+pdf → `[{image, caption:text}, {document, mimetype, fileName}]`; text+audio first → `[{text}, {audio, mimetype}]`; empty text + nothing → `[]`.
- [ ] Implement; `npm test` → PASS.

### Task 3: Campaign runner
**Files:** Create `src/campaign.js`, `test/campaign.test.js`
**Consumes:** nothing external (sender injected).
**Produces:** `class Campaign extends EventEmitter` — `constructor({ sender, file, sleep? , random? })`; `sender = { check(number) -> Promise<jid|null>, send(jid, messages) -> Promise<void>, typing(jid) -> Promise<void> }`; `load()`, `start({ numbers, messages, settings })`, `pause()`, `resume()`, `stop()`, `snapshot()`; emits `'update'` with snapshot. Row = `{ number, status: 'pending'|'sending'|'sent'|'failed'|'skipped', error?, at? }`; snapshot status `'idle'|'running'|'paused'|'done'|'stopped'`. Error with `code === 'NOT_CONNECTED'` pauses and keeps row pending.
- [ ] Tests (fake sender, instant sleep): all sent; `check` null → skipped; send throws → failed with message, continues; NOT_CONNECTED → paused, row pending; stop during sleep resolves quickly; load() of file with `sending` row → pending + paused.
- [ ] Implement; `npm test` → PASS.

### Task 4: WhatsApp client
**Files:** Create `src/whatsapp.js`
**Produces:** `class WhatsAppClient extends EventEmitter` — `start()`, `logout()`, `state() -> { status: 'disconnected'|'qr'|'connecting'|'connected', qr?: dataURL, me?: string }`, plus `check/send/typing` matching the sender interface (throw `NOT_CONNECTED` when not connected); emits `'state'`, `'connected'`.
- [ ] Implement with `useMultiFileAuthState('auth')`, `fetchLatestBaileysVersion`, reconnect unless `loggedOut` (then wipe `auth/` and restart for new QR).

### Task 5: Server + UI
**Files:** Create `src/server.js`, `public/index.html`, `public/style.css`, `public/app.js`
- [ ] Routes: `POST /api/contacts/parse`, `POST /api/upload` (multer, 64 MB), `DELETE /api/upload/:id`, `POST /api/campaign/start|pause|resume|stop`, `GET /api/campaign/results.csv`, `POST /api/logout`. Socket events `wa:state`, `campaign:update`.
- [ ] UI: 3 steps (Connect / Contacts / Message & Send), drop zone, settings, progress table.
- [ ] Verify: `npm start`, page loads, QR appears; manual send to own number.
