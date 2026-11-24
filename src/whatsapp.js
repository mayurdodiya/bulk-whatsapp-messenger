// Wraps a Baileys socket: QR login, persistent session, reconnects, and the
// sender interface used by Campaign (check / typing / send).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const notConnected = () => Object.assign(new Error('WhatsApp is not connected'), { code: 'NOT_CONNECTED' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Boom status codes that mean "the link dropped", not "this message is bad".
const CONNECTION_CODES = new Set([408, 428, 440, 503, 515]);
const isConnectionError = (err) => CONNECTION_CODES.has(err?.output?.statusCode) || /connection (closed|lost)/i.test(err?.message || '');

export class WhatsAppClient extends EventEmitter {
  constructor({ authDir = 'auth', logger = pino({ level: 'warn' }) } = {}) {
    super();
    this.authDir = authDir;
    this.logger = logger;
    this.sock = null;
    this._state = { status: 'disconnected' };
    this._retries = 0;
    this._stopped = false;
    this._starting = false;
    this._reconnectTimer = null;
    this._lastSend = new Map();
  }

  state() {
    return { ...this._state };
  }

  isConnected() {
    return this._state.status === 'connected';
  }

  _set(next) {
    this._state = next;
    this.emit('state', this.state());
  }

  async start() {
    if (this._starting || this.sock) return;
    this._starting = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try {
      await this._open();
    } finally {
      this._starting = false;
    }
  }

  async _open() {
    this._stopped = false;
    this._set({ status: 'connecting' });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* offline: let Baileys use its bundled version */
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.logger,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      this._onUpdate(sock, update).catch((e) => this.logger.error(e, 'connection.update failed'));
    });
  }

  async _onUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return; // stale socket
    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      if (sock === this.sock) this._set({ status: 'qr', qr: dataUrl });
    }
    if (connection === 'open') {
      this._retries = 0;
      const me = sock.user?.id?.split(':')[0]?.split('@')[0];
      this._set({ status: 'connected', me, name: sock.user?.name || '' });
      this.emit('connected');
    }
    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    this.sock = null;
    if (this._stopped) return this._set({ status: 'disconnected' });

    if (code === DisconnectReason.forbidden) {
      // 403: WhatsApp has blocked this number. Reconnecting will not help.
      this._stopped = true;
      return this._set({ status: 'disconnected', error: 'WhatsApp refused this number (403). It may be banned or restricted. Check WhatsApp on your phone.' });
    }
    if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
      // Session revoked or corrupt: wipe it and show a fresh QR.
      this._safeWipe();
      this._set({ status: 'disconnected', error: code === DisconnectReason.loggedOut ? 'Logged out from phone. Scan the QR again.' : 'Saved session was damaged. Scan the QR again.' });
      return this.start();
    }
    if (code === DisconnectReason.connectionReplaced) {
      this._stopped = true;
      return this._set({ status: 'disconnected', error: 'This session was opened somewhere else. Restart the app to reconnect.' });
    }
    this._retries++;
    const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 2000 * this._retries);
    this._set({ status: 'connecting', error: `Reconnecting… (code ${code ?? 'unknown'})` });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped) this.start().catch((e) => this.logger.error(e));
    }, wait);
  }

  async logout() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try {
      await this.sock?.logout();
    } catch {
      /* already gone */
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this._safeWipe();
    this._set({ status: 'disconnected' });
    await this.start(); // show a new QR straight away
  }

  /** Stop for good (no reconnect). With `logout`, also unlink this device from the phone. */
  async close({ logout = false } = {}) {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (logout) {
      try {
        await this.sock?.logout();
      } catch {
        /* already gone */
      }
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this._set({ status: 'disconnected' });
  }

  _safeWipe() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      this.logger.error(e, 'could not delete auth folder');
    }
  }

  _require() {
    if (!this.sock || !this.isConnected()) throw notConnected();
    return this.sock;
  }

  // ---- sender interface used by Campaign ----

  /** @returns {Promise<string|null>} WhatsApp JID, or null when the number has no account. */
  async check(number) {
    const sock = this._require();
    try {
      const [res] = (await sock.onWhatsApp(number)) || [];
      return res?.exists ? res.jid : null;
    } catch (err) {
      if (!this.isConnected() || isConnectionError(err)) throw notConnected();
      throw err;
    }
  }

  async typing(jid) {
    const sock = this._require();
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(1000 + Math.random() * 2000);
    await sock.sendPresenceUpdate('paused', jid);
  }

  async send(jid, messages) {
    for (const content of messages) {
      // Space out consecutive parts to the same person like a human would.
      const last = this._lastSend.get(jid);
      if (last && Date.now() - last < 3000) await sleep(800 + Math.random() * 1200);
      const sock = this._require();
      try {
        await sock.sendMessage(jid, content);
      } catch (err) {
        if (!this.isConnected() || isConnectionError(err)) throw notConnected();
        throw err;
      }
      this._lastSend.set(jid, Date.now());
      if (this._lastSend.size > 1000) this._lastSend.clear();
    }
  }
}
