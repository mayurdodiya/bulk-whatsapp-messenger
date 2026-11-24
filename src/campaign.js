// Sequential, throttled, resumable sending queue. The WhatsApp sender is injected.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  minDelay: 8, // seconds between contacts
  maxDelay: 15,
  batchSize: 50, // rest after this many contacts (0 = never)
  batchRestMin: 2, // minutes
  batchRestMax: 5,
});
const MIN_DELAY_FLOOR = 3;
export const DISCONNECT_NOTE = 'WhatsApp disconnected — will resume automatically when reconnected.';

/** Resolves after `ms`, or immediately when `signal` aborts. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });
}

export function normalizeSettings(input = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
  const s = {
    minDelay: num(input.minDelay, DEFAULT_SETTINGS.minDelay),
    maxDelay: num(input.maxDelay, DEFAULT_SETTINGS.maxDelay),
    batchSize: Math.max(0, Math.floor(num(input.batchSize, DEFAULT_SETTINGS.batchSize))),
    batchRestMin: Math.max(0, num(input.batchRestMin, DEFAULT_SETTINGS.batchRestMin)),
    batchRestMax: Math.max(0, num(input.batchRestMax, DEFAULT_SETTINGS.batchRestMax)),
  };
  s.minDelay = Math.max(MIN_DELAY_FLOOR, s.minDelay);
  s.maxDelay = Math.max(s.minDelay, s.maxDelay);
  s.batchRestMax = Math.max(s.batchRestMin, s.batchRestMax);
  return s;
}

export class Campaign extends EventEmitter {
  /**
   * @param {{ sender: {check(n:string):Promise<string|null>, typing(jid:string):Promise<void>, send(jid:string, m:object[]):Promise<void>},
   *           file: string, sleep?: Function, random?: () => number }} opts
   */
  constructor({ sender, file, sleep = abortableSleep, random = Math.random }) {
    super();
    this.sender = sender;
    this.file = file;
    this.sleep = sleep;
    this.random = random;
    this.state = { status: 'idle', rows: [], messages: [], settings: { ...DEFAULT_SETTINGS }, waitingUntil: null, note: null };
    this._loop = null;
    this._loopGen = -1;
    this._gen = 0;
    this._abort = null;
  }

  snapshot() {
    const rows = this.state.rows;
    const count = (st) => rows.filter((r) => r.status === st).length;
    return {
      ...this.state,
      rows: rows.map((r) => ({ ...r })),
      current: rows.find((r) => r.status === 'sending')?.number ?? null,
      counts: { total: rows.length, pending: count('pending'), sent: count('sent'), failed: count('failed'), skipped: count('skipped') },
    };
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const rows = (saved.rows || []).map((r) => (r.status === 'sending' ? { ...r, status: 'pending' } : r));
      let status = saved.status || 'idle';
      if (status === 'running') status = 'paused';
      this.state = { ...this.state, ...saved, rows, status, waitingUntil: null, note: status === 'paused' ? 'Restored after restart — press Resume.' : saved.note ?? null };
    } catch {
      /* corrupt file: start fresh */
    }
  }

  /** display: optional UI-only description of the message (shown while sending). */
  start({ numbers, messages, settings, display = null }) {
    if (this.state.status === 'running') throw new Error('A campaign is already running');
    if (!numbers?.length) throw new Error('No contacts');
    if (!messages?.length) throw new Error('Message is empty');
    this._gen++;
    this._abort?.abort();
    this.state = {
      status: 'running',
      rows: numbers.map((number) => ({ number, status: 'pending' })),
      messages,
      display,
      settings: normalizeSettings(settings),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      waitingUntil: null,
      note: null,
    };
    this._changed();
    return this._ensureLoop();
  }

  pause(note = null) {
    if (this.state.status !== 'running') return;
    this.state.status = 'paused';
    this.state.note = note;
    this._abort?.abort();
    this._changed();
  }

  resume() {
    if (this.state.status !== 'paused') return this._loop ?? Promise.resolve();
    this.state.status = 'running';
    this.state.note = null;
    this._changed();
    return this._ensureLoop();
  }

  stop() {
    if (!['running', 'paused'].includes(this.state.status)) return;
    this.state.status = 'stopped';
    this.state.finishedAt = new Date().toISOString();
    this._abort?.abort();
    this._changed();
  }

  _ensureLoop() {
    // One loop per campaign generation. A new campaign waits for the previous
    // loop to wind down, so an old in-flight row can never use the new message.
    if (this._loop && this._loopGen === this._gen) return this._loop;
    const gen = this._gen;
    const prev = this._loop || Promise.resolve();
    const p = prev.catch(() => {}).then(() => this._run(gen));
    this._loop = p;
    this._loopGen = gen;
    p.finally(() => {
      if (this._loop === p) this._loop = null;
    }).catch(() => {});
    return p;
  }

  async _run(gen) {
    const live = () => this._gen === gen && this.state.status === 'running';
    let processed = 0;
    while (live()) {
      const row = this.state.rows.find((r) => r.status === 'pending');
      if (!row) break;
      const messages = this.state.messages;

      row.status = 'sending';
      this._changed();
      try {
        const jid = await this.sender.check(row.number);
        if (!jid) {
          row.status = 'skipped';
          row.error = 'Not on WhatsApp';
        } else {
          await this.sender.typing(jid).catch(() => {});
          if (!live() && !row.sentParts) {
            // paused/stopped/replaced before anything went out: leave it untouched
            row.status = 'pending';
            this._changed(this._gen === gen);
            break;
          }
          // Send part by part so a reconnect resumes after the last delivered part.
          for (let i = row.sentParts || 0; i < messages.length; i++) {
            await this.sender.send(jid, [messages[i]]);
            row.sentParts = i + 1;
          }
          row.status = 'sent';
          delete row.error;
        }
      } catch (err) {
        if (err?.code === 'NOT_CONNECTED') {
          row.status = 'pending';
          if (this._gen === gen && this.state.status === 'running') this.pause(DISCONNECT_NOTE);
          break;
        }
        row.status = 'failed';
        row.error = err?.message || String(err);
      }
      row.at = new Date().toISOString();
      processed++;
      if (this._gen !== gen) break; // campaign was replaced; its row object is gone
      this._changed();

      if (!this.state.rows.some((r) => r.status === 'pending')) break;
      if (!live()) break;
      await this._wait(this._delayMs(processed));
    }

    if (live() && !this.state.rows.some((r) => r.status === 'pending')) {
      this.state.status = 'done';
      this.state.finishedAt = new Date().toISOString();
      this._changed();
    }
  }

  _delayMs(processed) {
    const s = this.state.settings;
    const pick = (a, b) => a + this.random() * (b - a);
    if (s.batchSize > 0 && processed % s.batchSize === 0) {
      return Math.round(pick(s.batchRestMin, s.batchRestMax) * 60_000);
    }
    return Math.round(pick(s.minDelay, s.maxDelay) * 1000);
  }

  async _wait(ms) {
    this._abort = new AbortController();
    this.state.waitingUntil = Date.now() + ms;
    this._changed(false);
    await this.sleep(ms, this._abort.signal);
    this._abort = null;
    this.state.waitingUntil = null;
  }

  _changed(persist = true) {
    if (persist) this._save();
    this.emit('update', this.snapshot());
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const { waitingUntil, ...rest } = this.state;
      fs.writeFileSync(this.file, JSON.stringify(rest, null, 2));
    } catch (err) {
      this.emit('error-log', err);
    }
  }
}
