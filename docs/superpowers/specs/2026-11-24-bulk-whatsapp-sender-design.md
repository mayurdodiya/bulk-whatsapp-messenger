# Bulk WhatsApp Sender — Design

Date: 2026-11-24

## Intent
A personal tool, run on the owner's own Windows PC, for sending one message (text and/or files) to a pasted list of phone numbers, one contact at a time, with a single click. WhatsApp is linked by scanning a QR code, like WhatsApp Web.

## Goals
- Link WhatsApp by QR; session persists so the QR is scanned once.
- Paste a bulk list of numbers; apply one country code to all; dedupe; show invalid ones.
- Compose a message: text plus any number of attachments (image, video, audio, PDF, any document) via drag-and-drop or file picker.
- One click sends to every contact sequentially, with live per-contact status and overall progress.
- Pause / Resume / Stop. Export results as CSV.

## Non-goals
- Multi-user accounts, login, hosting, billing.
- Per-contact personalisation ({name}), scheduling, reply inbox, chatbots.
- Official WhatsApp Business Cloud API.

## Anti-goals (failure even if it "works")
- Blasting messages with no delay, getting the owner's number banned.
- Losing campaign progress when the app/connection drops mid-send.

## Constraints
- Uses an unofficial WhatsApp Web protocol library: automated bulk sending is against WhatsApp terms and carries ban risk. Mitigated by throttling (below); cannot be eliminated.
- Node.js 24 on Windows; must run with `npm install` + `npm start` (plus a double-click `start.bat`).

## Approaches
- **A. Local web app + Baileys (chosen).** Node server on localhost, browser UI, Baileys speaks WhatsApp's protocol directly. Lightweight, full media support. Risk: occasional library updates needed.
- B. Local web app + whatsapp-web.js. Drives hidden Chrome; heavier (~300 MB), slower, breaks when the Web UI changes.
- C. Electron desktop app around A. Nicer launch, much more packaging work, no new capability.

Owner said "do whatever is best"; A was my pick.

## Design (builder's calls, made by Claude)
**Stack:** Node 24, Express, Socket.IO, `@whiskeysockets/baileys`, `multer` (uploads), `qrcode`, `pino`. Frontend: single static page (HTML/CSS/vanilla JS), no build step. Port 3000; auto-open browser on start.

**Connection:** auth state stored in `./auth`. UI shows status (disconnected / QR / connecting / connected as +number). QR rendered as image, refreshed live. Auto-reconnect on transient drops; "Log out" clears `./auth`. If connection drops mid-campaign, campaign auto-pauses and resumes when reconnected.

**Contacts:** textarea paste (and .txt/.csv import). Split on newlines, commas, semicolons, tabs. For each entry, strip everything except digits and a leading `+`.
- Starts with `+` or `00` → already international, keep (strip `+`/`00`).
- Otherwise strip leading zeros; if a country code is set and the number does not already start with it at ≥ 11 digits, prepend it.
- Valid if 8–15 digits (E.164). Duplicates removed. UI shows valid / invalid / duplicate counts and the list.
- Before sending each, check `onWhatsApp`; non-registered numbers are marked "Not on WhatsApp" and skipped.

**Message & media:** text box + drop zone listing attachments (name, size, type, remove). Uploads stored in `./uploads`. Per-file limit 64 MB. Type by mimetype: `image/*` → image, `video/*` → video, `audio/*` → audio, anything else → document (keeps filename). Text is sent as the caption of the first image/video/document; if there are no attachments (or the first is audio), text is sent as its own message first. Remaining attachments follow in order.

**Sending engine (server-side queue):** one contact at a time. Shows "typing…" presence briefly before each send. Random delay between contacts, default 8–15 s (configurable, floor 3 s). Batch rest: every N contacts (default 50) pause a random 2–5 min. Warning shown when a campaign exceeds 200 contacts. Statuses: pending → sending → sent | failed (reason) | skipped. Campaign state saved to `./data/campaign.json` after every contact so a restart can resume. Pause / Resume / Stop controls; progress pushed over Socket.IO. Results downloadable as CSV.

**Testing:** `node:test` unit tests for number parsing and media classification, queue logic tested with a fake sender. Real sending verified manually by the owner with their phone (requires a QR scan).

## Left to the builder
Exact UI styling (clean, single page, three steps: Connect → Contacts → Message & Send), file layout, error message wording.
