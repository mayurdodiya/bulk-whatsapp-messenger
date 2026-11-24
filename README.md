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
