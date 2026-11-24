/* global io */
(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();

  const PRESETS = {
    safe: { minDelay: 12, maxDelay: 25, batchSize: 30, batchRestMin: 3, batchRestMax: 6 },
    normal: { minDelay: 8, maxDelay: 15, batchSize: 50, batchRestMin: 2, batchRestMax: 5 },
    fast: { minDelay: 5, maxDelay: 10, batchSize: 75, batchRestMin: 1, batchRestMax: 3 },
  };
  const PRESET_NAME = { safe: 'Safe', normal: 'Recommended', fast: 'Fast', custom: 'Custom' };
  const SETTING_KEYS = ['minDelay', 'maxDelay', 'batchSize', 'batchRestMin', 'batchRestMax'];
  const SPLIT = /[\n\r,;\t]+/;

  const state = {
    wa: { status: 'connecting' },
    contacts: { valid: [], invalid: [], duplicates: 0, withoutCode: 0 },
    items: [], // {id, type:'text', text} | {id, type:'file', uploadId, caption, originalName, mimetype, size, kind, preview?, uploading?}
    campaign: null,
    filter: 'all',
    search: '',
    config: { maxFileMb: 64, largeCampaign: 200 },
    preset: 'normal',
    settings: { ...PRESETS.normal },
  };

  // ================= helpers =================
  // Browser storage is scoped per signed-in user (set once /api/me answers), so two accounts
  // on the same browser never see each other's contacts or message. The theme stays global.
  let storePrefix = 'bws:';
  const store = {
    get(k, d) { try { const v = localStorage.getItem((k === 'theme' ? 'bws:' : storePrefix) + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem((k === 'theme' ? 'bws:' : storePrefix) + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const uid = () => Math.random().toString(36).slice(2, 10);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // WhatsApp-style formatting for the preview
  const fmtWa = (s) => esc(s)
    .replace(/```([\s\S]+?)```/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>');

  let toastTimer;
  function toast(msg, isErr = false) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
  }

  /** Confirm dialog. With `input` (initial text) it asks for a value and resolves to the text, or null on cancel. */
  function ask(title, body, okLabel = 'OK', danger = false, input = null) {
    const dlg = $('dialog');
    const field = $('dlgInput');
    $('dlgTitle').textContent = title;
    $('dlgBody').textContent = body;
    $('dlgOk').textContent = okLabel;
    $('dlgOk').className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    field.classList.toggle('hidden', input === null);
    field.value = input ?? '';
    field.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } };
    dlg.returnValue = '';
    dlg.showModal();
    if (input !== null) { field.focus(); field.select(); }
    return new Promise((resolve) => dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(input === null ? ok : ok ? field.value.trim() : null);
    }, { once: true }));
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.code === 'AUTH_REQUIRED') { location.href = '/login'; throw new Error('Please sign in.'); }
    if (data.code === 'SUBSCRIPTION_ENDED') { showExpired(data.error); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function showExpired(message) {
    $('expiredMsg').textContent = message || 'Your subscription has ended.';
    const phone = (state.supportPhone || (message || '').match(/\+?[\d\s]{8,}/)?.[0] || '').trim();
    $('expiredCall').classList.toggle('hidden', !phone);
    $('expiredCall').href = 'tel:' + phone.replace(/\s/g, '');
    $('expiredCall').textContent = phone ? `Call ${phone}` : 'Call support';
    $('expiredScreen').classList.remove('hidden');
  }
  async function signOut() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.href = '/login';
  }

  // ================= two steps =================
  // Step 1: connect WhatsApp + contacts. Step 2: message + send (+ live progress).
  let step = 1;
  const TITLES = { 1: ['Campaign', 'Connect & contacts'], 2: ['Campaign', 'Message & send'], admin: ['Administration', 'Users'] };
  function showStep(n, scroll = true) {
    if (n === 'admin' && state.me?.role !== 'admin') n = 1;
    if (n !== 'admin') n = Number(n) === 2 ? 2 : 1;
    step = n;
    store.set('step', n);
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== String(n)));
    document.querySelectorAll('.actionbar').forEach((b) => b.classList.toggle('hidden', b.dataset.bar !== String(n)));
    document.body.classList.toggle('no-bar', n === 'admin');
    $('crumb').textContent = TITLES[n][0];
    $('topTitle').textContent = TITLES[n][1];
    openSidebar(false);
    if (n === 'admin') loadUsers();
    renderStepper();
    renderReview();
    document.querySelectorAll('#itemList textarea').forEach(autoGrow);
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // targets used by "Fix" links: 1 = WhatsApp, 2 = contacts, 3 = message
  const SECTION = { 1: 'secConnect', 2: 'secContacts', 3: 'secMessage' };
  function go(n) {
    showStep(n <= 2 ? 1 : 2, false);
    const el = $(SECTION[n]);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.animate?.([{ boxShadow: '0 0 0 3px var(--accent)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1200 });
  }
  document.querySelectorAll('.step-tab').forEach((b) => (b.onclick = () => showStep(b.dataset.step)));
  function openSidebar(open) {
    $('sidebar').classList.toggle('open', open);
    $('sideBackdrop').classList.toggle('hidden', !open);
  }
  $('menuBtn').onclick = () => openSidebar(true);
  $('sideBackdrop').onclick = () => openSidebar(false);
  $('signOut').onclick = signOut;
  $('expiredSignOut').onclick = signOut;
  $('toStep2').onclick = () => showStep(2);
  $('toStep1').onclick = () => showStep(1);
  const isActive = () => ['running', 'paused'].includes(state.campaign?.status);

  const contactsReady = () => state.contacts.valid.length > 0 && state.contacts.withoutCode === 0;
  const messageReady = () => sequence().length > 0 && !state.items.some((i) => i.uploading);
  function renderStepper() {
    const connected = state.wa.status === 'connected';
    const n = state.contacts.valid.length;
    const parts = sequence().length;
    document.querySelectorAll('.step-tab').forEach((b) => {
      const s = b.dataset.step;
      b.classList.toggle('active', s === String(step));
      b.classList.toggle('done', s === '1' ? connected && contactsReady() : s === '2' ? messageReady() : false);
    });
    $('tab1Sub').textContent = connected || n ? `${connected ? 'Connected' : 'Not connected'} · ${plural(n, 'number')}` : 'Link WhatsApp, add numbers';
    $('tab2Sub').textContent = parts ? `${plural(parts, 'message')} ready` : 'Compose and publish';

    // step 1 bottom bar
    const chip = (ok, text) => `<span class="check-chip ${ok ? 'ok' : 'no'}"><span class="ic">${ok ? '✓' : '!'}</span>${esc(text)}</span>`;
    const need = state.contacts.withoutCode;
    $('step1Info').innerHTML = [
      chip(connected, connected ? `WhatsApp connected${state.wa.me ? ' (+' + state.wa.me + ')' : ''}` : 'WhatsApp not connected'),
      chip(n > 0, n > 0 ? `${plural(n, 'number')} ready` : 'No numbers added'),
      need ? chip(false, `${plural(need, 'number')} without country code — click Apply`) : '',
    ].join('');
  }

  // ================= step 1: connection =================
  function renderWa() {
    const s = state.wa;
    $('connQr').classList.toggle('hidden', s.status !== 'qr');
    $('connOk').classList.toggle('hidden', s.status !== 'connected');
    $('connWait').classList.toggle('hidden', !['connecting', 'disconnected'].includes(s.status));
    $('connWaitText').textContent = s.status === 'disconnected' ? 'Disconnected.' : 'Connecting to WhatsApp…';
    document.querySelector('#connWait .spinner').classList.toggle('hidden', s.status === 'disconnected');
    if (s.status === 'qr') $('qrImg').src = s.qr;
    if (s.status === 'connected') {
      $('meName').textContent = s.name || 'WhatsApp account';
      $('meNumber').textContent = s.me ? '+' + s.me : '';
      $('avatar').textContent = (s.name || '?').trim().charAt(0).toUpperCase() || '✓';
    }
    $('connError').classList.toggle('hidden', !s.error || s.status === 'connected');
    $('connError').textContent = s.error || '';
    const map = { connected: ['pill-on', 'Connected'], qr: ['pill-wait', 'Scan QR code'], connecting: ['pill-wait', 'Connecting…'], disconnected: ['pill-off', 'Not connected'] };
    const [cls, label] = map[s.status] || map.disconnected;
    $('connPill').className = 'pill ' + cls;
    $('connPillText').textContent = label;
    renderStepper();
    renderReview();
  }
  let waSeen = false;
  socket.on('wa:state', (s) => {
    const wasConnected = !waSeen || state.wa.status === 'connected';
    waSeen = true;
    state.wa = s;
    renderWa();
    if (!wasConnected && s.status === 'connected') toast('WhatsApp connected');
  });
  socket.on('connect_error', (err) => {
    if (err?.message === 'AUTH_REQUIRED') location.href = '/login';
    else if (err?.message === 'SUBSCRIPTION_ENDED') api('/api/me').catch(() => {});
  });
  socket.on('subscription:ended', (d) => showExpired(d?.message));
  socket.on('disconnect', () => { state.wa = { status: 'disconnected', error: 'Lost connection to the app. Is the black server window still open?' }; renderWa(); });
  $('connPill').onclick = () => go(1);
  $('logoutBtn').onclick = async () => {
    if (!(await ask('Log out?', 'This unlinks WhatsApp from this tool. You will need to scan the QR code again.', 'Log out', true))) return;
    await api('/api/logout', { method: 'POST' }).catch((e) => toast(e.message, true));
  };

  // ================= step 2: contacts =================
  // Same key the server uses for a number typed without country code
  function entryKey(entry) {
    const t = entry.trim();
    let d = t.replace(/\D/g, '');
    if (t.startsWith('+')) return d;
    if (d.startsWith('00')) return d.slice(2);
    return d.replace(/^0+/, '');
  }
  const hasCode = (entry) => /^\s*(\+|00)/.test(entry);

  async function refreshContacts() {
    const raw = $('contactsRaw').value;
    store.set('contacts', raw);
    try {
      state.contacts = await api('/api/contacts/parse', { method: 'POST', body: JSON.stringify({ raw, countryCode: '' }) });
    } catch (e) { toast(e.message, true); }
    renderContacts();
  }
  const refreshContactsSoon = debounce(refreshContacts, 250);

  function renderContacts() {
    const c = state.contacts;
    $('validCount').textContent = c.valid.length;
    $('needCodeCount').textContent = c.withoutCode;
    $('invalidCount').textContent = c.invalid.length;
    $('dupCount').textContent = c.duplicates;

    const need = $('needCodeAlert');
    need.classList.toggle('hidden', !c.withoutCode);
    need.textContent = `${plural(c.withoutCode, 'number')} ${c.withoutCode === 1 ? 'has' : 'have'} no country code. Type the code above and click "Apply to numbers".`;

    $('invalidBlock').classList.toggle('hidden', !c.invalid.length);
    $('invalidList').innerHTML = c.invalid.slice(0, 300).map((n) => `<span>${esc(n)}</span>`).join('');

    const noCode = new Set($('contactsRaw').value.split(SPLIT).filter((e) => e.trim() && !hasCode(e)).map(entryKey));
    const q = state.search.replace(/\D/g, '');
    const list = c.valid.map((n, i) => ({ n, i })).filter(({ n }) => !q || n.includes(q));
    const shown = list.slice(0, 500);
    $('numberList').innerHTML = shown.map(({ n, i }) => `
      <li><span class="idx">${i + 1}</span>${noCode.has(n) ? esc(n) + ' <span class="no-code">no code</span>' : '+' + esc(n)}
        <button class="x" data-del="${esc(n)}" title="Remove" aria-label="Remove ${esc(n)}">✕</button></li>`).join('')
      + (list.length > shown.length ? `<li class="more">…and ${list.length - shown.length} more</li>` : '');
    $('numberList').classList.toggle('hidden', !list.length);
    $('numbersEmpty').classList.toggle('hidden', !!list.length);
    $('numbersEmpty').textContent = c.valid.length ? 'No numbers match your search.' : 'No numbers yet. Paste them on the left.';
    renderStepper();
  }

  $('contactsRaw').addEventListener('input', refreshContactsSoon);
  $('searchNumbers').addEventListener('input', (e) => { state.search = e.target.value; renderContacts(); });
  $('countryCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); store.set('cc', e.target.value); });
  $('countryCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('applyCode').click(); });

  $('applyCode').onclick = async () => {
    const raw = $('contactsRaw').value;
    if (!raw.trim()) return toast('Paste some numbers first.', true);
    const cc = $('countryCode').value.trim();
    const before = state.contacts.withoutCode;
    if (!cc) {
      const ok = await ask('No country code entered', 'Use all numbers exactly as typed? They must already include the country code (e.g. 919876543210).', 'Use as typed');
      if (!ok) return $('countryCode').focus();
    }
    try {
      const r = await api('/api/contacts/parse', { method: 'POST', body: JSON.stringify({ raw, countryCode: cc }) });
      $('contactsRaw').value = r.valid.map((n) => '+' + n).join('\n') + (r.invalid.length ? '\n' + r.invalid.join('\n') : '');
      await refreshContacts();
      toast(cc ? `+${cc} added to ${plural(before, 'number')}. List cleaned up.` : 'Numbers marked as already including the country code.');
    } catch (e) { toast(e.message, true); }
  };

  $('numberList').addEventListener('click', (e) => {
    const n = e.target.closest('[data-del]')?.dataset.del;
    if (!n) return;
    const entries = $('contactsRaw').value.split(SPLIT).filter((x) => x.trim() && entryKey(x) !== n);
    $('contactsRaw').value = entries.map((x) => x.trim()).join('\n');
    refreshContacts();
  });
  $('removeInvalid').onclick = () => {
    const bad = new Set(state.contacts.invalid);
    $('contactsRaw').value = $('contactsRaw').value.split(SPLIT).filter((x) => x.trim() && !bad.has(x.trim())).map((x) => x.trim()).join('\n');
    refreshContacts();
  };
  $('clearContacts').onclick = async () => {
    if (!$('contactsRaw').value.trim()) return;
    if (!(await ask('Clear all numbers?', 'This removes every number from the list.', 'Clear', true))) return;
    $('contactsRaw').value = '';
    refreshContacts();
  };
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const box = $('contactsRaw');
    box.value = (box.value.trim() ? box.value.trim() + '\n' : '') + text.trim();
    e.target.value = '';
    await refreshContacts();
    toast(`Imported ${file.name}`);
  });

  // ================= step 3: message sequence =================
  const kindOf = (m = '') => {
    const t = m.toLowerCase();
    if (['image/jpeg', 'image/jpg', 'image/png'].includes(t)) return 'image';
    if (['video/mp4', 'video/3gpp'].includes(t)) return 'video';
    if (['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/x-m4a'].includes(t)) return 'audio';
    return 'document';
  };
  const fileUrl = (it) => it.preview || (it.uploadId ? `/api/upload/${encodeURIComponent(it.uploadId)}/file` : '');
  const saveItems = () => store.set('items', state.items.filter((i) => !i.uploading).map(({ preview, uploading, ...rest }) => rest));

  // What will actually be sent, in order (mirrors server buildSequence)
  function sequence(items = state.items) {
    const out = [];
    for (const it of items) {
      if (it.type === 'text') { if (it.text.trim()) out.push({ kind: 'text', text: it.text.trim() }); continue; }
      if (it.uploading) continue;
      const cap = (it.caption || '').trim();
      if (cap && it.kind === 'audio') out.push({ kind: 'text', text: cap });
      out.push({ kind: it.kind, item: it, caption: it.kind === 'audio' ? '' : cap });
    }
    return out;
  }

  function addTextItem(focus = true) {
    if (isActive()) return;
    const it = { id: uid(), type: 'text', text: '' };
    state.items.push(it);
    saveItems();
    renderItems();
    if (focus) document.querySelector(`[data-id="${it.id}"] textarea`)?.focus();
  }
  $('addText').onclick = () => addTextItem();
  // `fileTarget` remembers which card the file picker was opened for
  let fileTarget = null;
  $('addFiles').onclick = () => { fileTarget = null; $('fileInput').click(); };
  $('fileInput').addEventListener('change', (e) => {
    addFiles(e.target.files, fileTarget ? { attachTo: fileTarget } : {});
    fileTarget = null;
    e.target.value = '';
  });

  /**
   * Upload files and place them in the sequence.
   * opts.attachTo: id of a text card — the first file joins that card and the text becomes its caption.
   * opts.after:    id of a card — files are inserted right after it (default: at the end).
   */
  async function addFiles(fileList, opts = {}) {
    if (isActive()) return toast('Editing is locked while sending. Stop the campaign to change the message.', true);
    const max = state.config.maxFileMb * 1024 * 1024;
    const files = [...fileList].filter((f) => {
      if (f.size > max) { toast(`${f.name} is larger than ${state.config.maxFileMb} MB`, true); return false; }
      if (!f.size) { toast(`${f.name} is empty`, true); return false; }
      return true;
    });
    if (!files.length) return;
    const fileFields = (f) => ({
      type: 'file', uploadId: null, originalName: f.name, mimetype: f.type, size: f.size,
      kind: kindOf(f.type), preview: /^(image|video)\//.test(f.type) ? URL.createObjectURL(f) : null, uploading: true,
    });

    let insertAt = state.items.length;
    const anchorId = opts.attachTo || opts.after;
    const anchorIdx = anchorId ? state.items.findIndex((x) => x.id === anchorId) : -1;
    if (anchorIdx >= 0) insertAt = anchorIdx + 1;

    const pending = [];
    files.forEach((f, n) => {
      const target = n === 0 && opts.attachTo ? state.items[anchorIdx] : null;
      if (target && target.type === 'text') {
        // turn the text card into a file card; keep the text as the caption
        const restore = { type: 'text', text: target.text };
        Object.assign(target, fileFields(f), { caption: target.text });
        delete target.text;
        pending.push([target, f, restore]);
      } else {
        const it = { id: uid(), caption: '', ...fileFields(f) };
        state.items.splice(insertAt++, 0, it);
        pending.push([it, f, null]);
      }
    });
    renderItems();

    for (const [it, f, restore] of pending) {
      const fd = new FormData();
      fd.append('files', f);
      try {
        const [saved] = await api('/api/upload', { method: 'POST', body: fd });
        Object.assign(it, { uploadId: saved.id, mimetype: saved.mimetype, kind: saved.kind, uploading: false });
      } catch (e) {
        if (restore) {
          for (const k of Object.keys(it)) if (k !== 'id') delete it[k];
          Object.assign(it, restore);
        } else state.items = state.items.filter((x) => x !== it);
        toast(`${f.name}: ${e.message}`, true);
      }
      saveItems();
      renderItems();
    }
    toast(opts.attachTo ? `Attached ${plural(pending.length, 'file')}` : `${plural(pending.length, 'file')} added`);
  }

  const LABEL = { image: 'Photo', video: 'Video', audio: 'Audio', document: 'File' };
  function thumbHtml(it) {
    const url = fileUrl(it);
    if (url && it.kind === 'image') return `<img class="thumb" src="${esc(url)}" alt="">`;
    if (url && it.kind === 'video') return `<video class="thumb" src="${esc(url)}" muted preload="metadata"></video>`;
    if (url && /^image\/(gif|webp)$/.test(it.mimetype)) return `<img class="thumb" src="${esc(url)}" alt="">`;
    const ext = (it.originalName.split('.').pop() || '').slice(0, 4).toUpperCase();
    return `<span class="thumb">${esc(ext || 'FILE')}</span>`;
  }
  function noteFor(it) {
    if (it.kind === 'document' && /^(image|video|audio)\//.test(it.mimetype)) return '<span class="tag note">Sent as a file (format not supported inline)</span>';
    return '';
  }

  const ICON = {
    up: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>',
    clip: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg>',
    unlink: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M17 7h-4v2h4a3 3 0 0 1 0 6h-4v2h4a5 5 0 0 0 0-10zm-6 8H7a3 3 0 0 1 0-6h4V7H7a5 5 0 0 0 0 10h4zm-3-4h2v2H8zM2.1 3.5l1.4-1.4 18.4 18.4-1.4 1.4z"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18 19a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>',
  };

  // grow caption/text boxes with their content
  // (skipped while the step is hidden — it is re-measured when the step is shown)
  const autoGrow = (ta) => {
    if (!ta.offsetParent) { ta.style.height = ''; return; }
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  };

  function renderItems() {
    const list = $('itemList');
    const items = liveItems() || state.items;
    const ro = isActive() ? 'readonly' : '';
    const n = items.length;
    list.innerHTML = items.map((it, i) => {
      const actions = `
        <div class="item-actions">
          <button class="ibtn" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">${ICON.up}</button>
          <button class="ibtn" data-act="down" ${i === n - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down">${ICON.down}</button>
          <button class="ibtn del" data-act="del" title="Remove" aria-label="Remove">${ICON.del}</button>
        </div>`;
      const grip = `<button class="handle" title="Drag to reorder" aria-label="Drag to reorder">${ICON.grip}</button>`;
      const order = `<span class="order">${i + 1}</span>`;
      if (it.type === 'text') {
        return `<li class="item item-text" data-id="${it.id}">${grip}
          <div class="item-body">
            <div class="item-top">${order}<span class="item-kind">Text</span>${actions}</div>
            <div class="composer">
              <textarea rows="3" data-field="text" placeholder="Write your message…" ${ro}>${esc(it.text)}</textarea>
              <div class="composer-bar">
                <div class="fmt">
                  <button data-fmt="*" title="Bold"><b>B</b></button>
                  <button data-fmt="_" title="Italic"><i>I</i></button>
                  <button data-fmt="~" title="Strikethrough"><s>S</s></button>
                </div>
                <button class="attach" data-act="attach" title="Attach a photo or file to this text — the text becomes its caption">${ICON.clip}Attach</button>
              </div>
            </div>
          </div></li>`;
      }
      const capPh = it.kind === 'audio' ? 'Text to send before this audio (optional)' : 'Add a caption (optional)';
      return `<li class="item item-media ${it.uploading ? 'uploading' : ''}" data-id="${it.id}">${grip}
        <div class="item-body">
          <div class="item-top">${order}
            <div class="media-row">${thumbHtml(it)}
              <div class="grow">
                <div class="file-name" title="${esc(it.originalName)}">${esc(it.originalName)}</div>
                <div class="file-meta">${LABEL[it.kind]} · ${fmtSize(it.size)}${it.uploading ? ' · uploading…' : ''} ${noteFor(it)}</div>
              </div>
            </div>
            ${it.uploading ? actions : actions.replace('<div class="item-actions">', `<div class="item-actions"><button class="ibtn" data-act="detach" title="Remove file, keep text" aria-label="Remove file, keep text">${ICON.unlink}</button>`)}
          </div>
          <textarea class="caption" rows="1" data-field="caption" placeholder="${capPh}" ${it.uploading ? 'disabled' : ''} ${ro}>${esc(it.caption)}</textarea>
        </div></li>`;
    }).join('');
    list.querySelectorAll('textarea').forEach(autoGrow);
    $('dropZone').classList.toggle('compact', n > 0);
    renderPreview();
    renderStepper();
  }

  // editing text/captions without re-rendering (keeps cursor)
  $('itemList').addEventListener('input', (e) => {
    if (isActive()) return;
    const field = e.target.dataset.field;
    if (!field) return;
    const it = state.items.find((x) => x.id === e.target.closest('.item').dataset.id);
    it[field] = e.target.value;
    autoGrow(e.target);
    saveItems();
    renderPreview();
    renderStepper();
  });
  $('itemList').addEventListener('click', async (e) => {
    if (isActive()) return;
    const li = e.target.closest('.item');
    if (!li) return;
    const idx = state.items.findIndex((x) => x.id === li.dataset.id);
    const fmt = e.target.closest('[data-fmt]')?.dataset.fmt;
    if (fmt) {
      const ta = li.querySelector('textarea');
      const { selectionStart: a, selectionEnd: b, value } = ta;
      const sel = value.slice(a, b) || 'text';
      ta.value = value.slice(0, a) + fmt + sel + fmt + value.slice(b);
      ta.focus();
      ta.setSelectionRange(a + 1, a + 1 + sel.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'attach') {
      fileTarget = li.dataset.id;
      $('fileInput').click();
      return;
    }
    if (act === 'detach') {
      // drop the file, keep its caption as a plain text message (or remove the card if no caption)
      const it = state.items[idx];
      if (it.uploadId) api('/api/upload/' + encodeURIComponent(it.uploadId), { method: 'DELETE' }).catch(() => {});
      if ((it.caption || '').trim()) state.items[idx] = { id: it.id, type: 'text', text: it.caption };
      else state.items.splice(idx, 1);
    }
    if (act === 'up' && idx > 0) [state.items[idx - 1], state.items[idx]] = [state.items[idx], state.items[idx - 1]];
    if (act === 'down' && idx < state.items.length - 1) [state.items[idx + 1], state.items[idx]] = [state.items[idx], state.items[idx + 1]];
    if (act === 'del') {
      const [it] = state.items.splice(idx, 1);
      if (it.type === 'file' && it.uploadId) api('/api/upload/' + encodeURIComponent(it.uploadId), { method: 'DELETE' }).catch(() => {});
    }
    saveItems();
    renderItems();
  });

  // ---- drag to reorder (handle only) + drop files ----
  let dragId = null;
  const list = $('itemList');
  const clearMarks = () => list.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('.handle')?.closest('.item'); if (li) li.draggable = true; });
  list.addEventListener('mouseup', () => list.querySelectorAll('[draggable="true"]').forEach((x) => (x.draggable = false)));
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.item');
    if (!li || !li.draggable) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragend', (e) => {
    e.target.closest?.('.item')?.classList.remove('dragging');
    list.querySelectorAll('[draggable="true"]').forEach((x) => (x.draggable = false));
    clearMarks();
    dragId = null;
  });
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const li = e.target.closest('.item');
    clearMarks();
    if (!li || li.dataset.id === dragId) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const li = e.target.closest('.item');
    const from = state.items.findIndex((x) => x.id === dragId);
    if (li && li.dataset.id !== dragId && from >= 0) {
      const after = li.classList.contains('drop-after');
      const [moved] = state.items.splice(from, 1);
      let to = state.items.findIndex((x) => x.id === li.dataset.id);
      if (after) to++;
      state.items.splice(to, 0, moved);
      saveItems();
    }
    dragId = null;
    renderItems();
  });

  const view3 = $('secMessage');
  const dz = $('dropZone');
  dz.onclick = () => { fileTarget = null; $('fileInput').click(); };
  dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileTarget = null; $('fileInput').click(); } };
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const clearFileOver = () => list.querySelectorAll('.file-over,.file-after').forEach((x) => x.classList.remove('file-over', 'file-after'));
  // Files dragged from the computer: onto a text card = attach to it; onto a file card = insert after it; elsewhere = add at the end.
  view3.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const li = e.target.closest('.item');
    clearFileOver();
    if (li) {
      const it = state.items.find((x) => x.id === li.dataset.id);
      li.classList.add(it?.type === 'text' ? 'file-over' : 'file-after');
      dz.classList.remove('over');
    } else dz.classList.add('over');
  });
  view3.addEventListener('dragleave', (e) => {
    if (!view3.contains(e.relatedTarget)) { dz.classList.remove('over'); clearFileOver(); }
  });
  view3.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dz.classList.remove('over');
    clearFileOver();
    const li = e.target.closest('.item');
    const it = li && state.items.find((x) => x.id === li.dataset.id);
    if (it?.type === 'text') addFiles(e.dataTransfer.files, { attachTo: it.id });
    else if (it) addFiles(e.dataTransfer.files, { after: it.id });
    else addFiles(e.dataTransfer.files);
  });
  // never let the browser open a dropped file
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ---- lock while a campaign is active: show what is actually being sent ----
  const liveItems = () => (isActive() && Array.isArray(state.campaign.display)
    ? state.campaign.display.map((d, i) => ({ ...d, id: 'live-' + i }))
    : null);
  let lockedShown = null;
  function renderLock() {
    const locked = isActive();
    $('secMessage').classList.toggle('locked', locked);
    $('lockNote').classList.toggle('hidden', !locked);
    if (locked !== lockedShown) { lockedShown = locked; renderItems(); }
  }

  // ---- chat preview ----
  let previewKey = '';
  function renderPreview() {
    const live = liveItems();
    const seq = sequence(live || state.items);
    $('previewBadge').classList.toggle('hidden', !live);
    $('testSend').classList.toggle('hidden', !!live);
    $('phName').textContent = live && state.campaign.current ? '+' + state.campaign.current : live ? 'Each contact' : 'Contact';
    $('phSub').textContent = live ? (state.campaign.status === 'paused' ? 'paused' : 'receiving this message') : 'online';
    const key = JSON.stringify(seq.map((m) => [m.kind, m.text, m.caption, m.item?.uploadId, m.item?.preview]));
    if (key === previewKey) return; // avoid reloading images on every progress tick
    previewKey = key;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const t = `<div class="time">${time} ✓✓</div>`;
    $('chat').innerHTML = seq.length ? seq.map((m) => {
      const cap = m.caption ? `<div class="cap">${fmtWa(m.caption)}</div>` : '';
      const url = m.item ? fileUrl(m.item) : '';
      if (m.kind === 'text') return `<div class="bubble">${fmtWa(m.text)}${t}</div>`;
      if (m.kind === 'image') return `<div class="bubble"><img src="${esc(url)}" alt="">${cap}${t}</div>`;
      if (m.kind === 'video') return `<div class="bubble"><video src="${esc(url)}" muted preload="metadata"></video>${cap}${t}</div>`;
      if (m.kind === 'audio') return `<div class="bubble"><div class="aud"><span class="play">▶</span><span class="wave"></span></div>${t}</div>`;
      const ext = (m.item.originalName.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      return `<div class="bubble"><div class="doc"><span class="ico">${esc(ext)}</span><div style="min-width:0"><div class="dn">${esc(m.item.originalName)}</div><div class="small" style="opacity:.7">${fmtSize(m.item.size)}</div></div></div>${cap}${t}</div>`;
    }).join('') : '<div class="placeholder">Your message preview appears here</div>';
  }

  const payloadItems = () => state.items.filter((i) => !i.uploading).map((i) => (i.type === 'text' ? { type: 'text', text: i.text } : { type: 'file', uploadId: i.uploadId, caption: i.caption }));

  $('testSend').onclick = async () => {
    if (state.wa.status !== 'connected') return toast('Connect WhatsApp first.', true);
    if (!messageReady()) return toast('Add a message or file first.', true);
    const btn = $('testSend');
    btn.disabled = true;
    btn.textContent = 'Sending test…';
    try {
      await api('/api/test-send', { method: 'POST', body: JSON.stringify({ items: payloadItems() }) });
      toast('Test sent — check "Message yourself" on your phone.');
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = 'Send test to myself';
  };

  // ================= drafts (saved on the server, 2 slots) =================
  state.drafts = [];
  state.maxDrafts = 2;
  const KIND_WORD = { image: 'photo', video: 'video', audio: 'audio', document: 'file' };
  function draftSummary(items) {
    const counts = {};
    for (const it of items) {
      const k = it.type === 'text' ? 'text' : KIND_WORD[it.kind] || 'file';
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts).map(([k, n]) => plural(n, k)).join(' · ');
  }
  const draftSnippet = (items) => {
    const t = items.find((i) => i.type === 'text')?.text || items.find((i) => i.caption)?.caption || '';
    return t.replace(/\s+/g, ' ').trim();
  };
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? 'today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };

  async function loadDrafts() {
    try {
      const r = await api('/api/drafts');
      state.drafts = r.drafts;
      state.maxDrafts = r.max;
    } catch (e) { toast(e.message, true); }
    renderDrafts();
  }

  function renderDrafts() {
    const box = $('drafts');
    const slots = [];
    for (let slot = 1; slot <= state.maxDrafts; slot++) {
      const d = state.drafts.find((x) => x.slot === slot);
      if (!d) {
        slots.push(`<button class="draft empty-slot" data-draft="save" data-slot="${slot}" title="Save the message you are editing into slot ${slot}">
          <span class="plus">＋</span><span><b>Save current message</b><small>Slot ${slot} is empty</small></span>
        </button>`);
        continue;
      }
      const snip = draftSnippet(d.items);
      slots.push(`<div class="draft" title="${esc(snip ? '“' + snip + '”' : d.name)}">
        <span class="draft-slot">${slot}</span>
        <div class="draft-info">
          <span class="draft-name">${esc(d.name)}</span>
          <span class="draft-meta">${esc(draftSummary(d.items))} · ${esc(fmtWhen(d.savedAt))}</span>
        </div>
        <button class="btn btn-primary btn-xs" data-draft="apply" data-slot="${slot}">Apply</button>
        <details class="menu">
          <summary class="ibtn" title="More" aria-label="More actions">⋯</summary>
          <div class="menu-pop">
            <button data-draft="update" data-slot="${slot}">Update with current message</button>
            <button data-draft="rename" data-slot="${slot}">Rename</button>
            <button class="danger" data-draft="delete" data-slot="${slot}">Delete</button>
          </div>
        </details>
      </div>`);
    }
    box.innerHTML = slots.join('');
  }

  // close an open ⋯ menu when clicking anywhere else
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((m) => { if (!m.contains(e.target)) m.removeAttribute('open'); });
  });

  async function saveDraft(slot, name) {
    await api('/api/drafts/' + slot, { method: 'PUT', body: JSON.stringify({ name, items: payloadItems() }) });
    await loadDrafts();
  }

  $('drafts').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-draft]');
    if (!btn) return;
    btn.closest('details')?.removeAttribute('open'); // close the ⋯ menu
    const slot = Number(btn.dataset.slot);
    const act = btn.dataset.draft;
    const d = state.drafts.find((x) => x.slot === slot);
    if (isActive() && act !== 'delete' && act !== 'rename') return toast('Drafts can be applied or saved after the current campaign is stopped or finished.', true);
    try {
      if (act === 'save' || act === 'update') {
        if (state.items.some((i) => i.uploading)) return toast('Wait for the files to finish uploading.', true);
        if (!sequence().length) return toast('The message is empty — add text or a file first.', true);
        if (act === 'update' && !(await ask(`Update “${d.name}”?`, 'The draft will be replaced with the message you have now.', 'Update draft'))) return;
        const suggested = act === 'update' ? d.name : (draftSnippet(state.items).slice(0, 30) || `Draft ${slot}`);
        const name = act === 'update' ? d.name : await ask('Save as draft', 'Give this draft a name so you can find it later.', 'Save draft', false, suggested);
        if (name === null) return;
        await saveDraft(slot, name);
        toast(act === 'update' ? `Draft “${d.name}” updated` : 'Draft saved');
      } else if (act === 'rename') {
        const name = await ask('Rename draft', '', 'Rename', false, d.name);
        if (!name) return;
        await api(`/api/drafts/${slot}/name`, { method: 'PATCH', body: JSON.stringify({ name }) });
        await loadDrafts();
      } else if (act === 'delete') {
        if (!(await ask(`Delete “${d.name}”?`, 'The saved draft and its files will be removed. Your current message is not affected.', 'Delete', true))) return;
        await api('/api/drafts/' + slot, { method: 'DELETE' });
        await loadDrafts();
        toast('Draft deleted');
      } else if (act === 'apply') {
        if (sequence().length && !(await ask(`Apply “${d.name}”?`, 'This replaces the message you are editing now.', 'Apply draft'))) return;
        const { items } = await api(`/api/drafts/${slot}/apply`, { method: 'POST' });
        const old = state.items;
        state.items = items.map((i) => ({ ...i, id: uid() }));
        // the previous composer files are no longer used
        for (const i of old) if (i.type === 'file' && i.uploadId) api('/api/upload/' + encodeURIComponent(i.uploadId), { method: 'DELETE' }).catch(() => {});
        saveItems();
        renderItems();
        toast(`Draft “${d.name}” applied — add contacts and press Send`);
      }
    } catch (err) { toast(err.message, true); }
  });

  // ================= theme =================
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    store.set('theme', t);
    document.querySelectorAll('input[name="theme"]').forEach((r) => (r.checked = r.value === t));
  }
  applyTheme(store.get('theme', 'light'));
  $('themeSeg').addEventListener('change', (e) => applyTheme(e.target.value));

  // ================= settings drawer =================
  function openDrawer(open) {
    $('drawer').classList.toggle('open', open);
    $('drawer').setAttribute('aria-hidden', String(!open));
    $('drawerBackdrop').classList.toggle('hidden', !open);
  }
  $('openSettings').onclick = () => openDrawer(true);
  $('closeSettings').onclick = () => openDrawer(false);
  $('drawerBackdrop').onclick = () => openDrawer(false);
  $('changeSpeed').onclick = () => openDrawer(true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openDrawer(false); });

  function writeSettingInputs() {
    for (const k of SETTING_KEYS) $(k).value = state.settings[k];
    document.querySelectorAll('input[name="preset"]').forEach((r) => (r.checked = r.value === state.preset));
  }
  function saveSettings() {
    store.set('settings', { preset: state.preset, values: state.settings });
    renderReview();
  }
  $('presets').addEventListener('change', (e) => {
    state.preset = e.target.value;
    if (PRESETS[state.preset]) state.settings = { ...PRESETS[state.preset] };
    writeSettingInputs();
    saveSettings();
  });
  SETTING_KEYS.forEach((k) => $(k).addEventListener('input', () => {
    const v = $(k).value.trim();
    state.settings[k] = v === '' ? null : Number(v);
    state.preset = 'custom';
    document.querySelectorAll('input[name="preset"]').forEach((r) => (r.checked = r.value === 'custom'));
    saveSettings();
  }));
  // what the server will actually use (same rules as normalizeSettings)
  function effective() {
    const d = PRESETS.normal;
    const v = (k) => (state.settings[k] === null || Number.isNaN(state.settings[k]) ? d[k] : state.settings[k]);
    const minDelay = Math.max(3, v('minDelay'));
    const maxDelay = Math.max(minDelay, v('maxDelay'));
    const batchSize = Math.max(0, Math.floor(v('batchSize')));
    const batchRestMin = Math.max(0, v('batchRestMin'));
    const batchRestMax = Math.max(batchRestMin, v('batchRestMax'));
    return { minDelay, maxDelay, batchSize, batchRestMin, batchRestMax };
  }

  // ================= step 4: review & send =================
  function fmtDuration(sec) {
    if (sec < 60) return `~${Math.max(1, Math.round(sec))} sec`;
    const m = Math.round(sec / 60);
    if (m < 60) return `~${m} min`;
    return `~${Math.floor(m / 60)} h ${m % 60} min`;
  }
  function estimate(n, parts) {
    if (!n) return 0;
    const s = effective();
    const avgDelay = (s.minDelay + s.maxDelay) / 2;
    const perContact = 2 + parts * 1.5;
    const rests = s.batchSize > 0 ? Math.floor((n - 1) / s.batchSize) : 0;
    return n * perContact + (n - 1 - rests) * avgDelay + rests * ((s.batchRestMin + s.batchRestMax) / 2) * 60;
  }

  function renderReview() {
    const live = liveItems();
    const active = isActive();
    const n = active ? state.campaign.counts.total : state.contacts.valid.length;
    const parts = sequence(live || state.items).length;
    $('checklist').classList.toggle('hidden', active);
    const s = effective();
    $('sumRecipients').textContent = n;
    $('sumParts').textContent = parts;
    $('sumPartsWord').textContent = parts === 1 ? 'message' : 'messages';
    $('sumRecipientsWord').textContent = n === 1 ? 'recipient' : 'recipients';
    $('sumSpeed').textContent = PRESET_NAME[state.preset] || 'Custom';
    $('sumSpeed').title = `${s.minDelay}–${s.maxDelay}s apart, break every ${s.batchSize || '∞'}`;
    $('sumTime').textContent = n && parts ? fmtDuration(estimate(n, parts)) : '—';

    // readiness of the draft (what the next Send would use)
    const uploading = state.items.some((i) => i.uploading);
    const dn = state.contacts.valid.length;
    const dp = sequence().length;
    const checks = [
      [state.wa.status === 'connected', state.wa.status === 'connected' ? `WhatsApp connected${state.wa.me ? ' (+' + state.wa.me + ')' : ''}` : 'WhatsApp is not connected', 1],
      [dn > 0, dn > 0 ? `${plural(dn, 'contact')} ready` : 'No contacts added', 2],
      [state.contacts.withoutCode === 0, state.contacts.withoutCode ? `${plural(state.contacts.withoutCode, 'number')} without country code` : 'All numbers have a country code', 2],
      [dp > 0 && !uploading, uploading ? 'Files are still uploading…' : dp ? `${plural(dp, 'message')} per contact` : 'Message is empty', 3],
    ];
    // bottom bar: only what still needs fixing, each with a link to the right place
    const issues = checks.filter(([ok]) => !ok);
    $('checklist').innerHTML = issues.length
      ? issues.map(([, label, target]) => `<span class="issue">⚠ ${esc(label)} <button data-goto="${target}">Fix</button></span>`).join('')
      : '<span class="ready-line">✓ Ready to send</span>';

    const running = state.campaign?.status === 'running';
    const ready = !issues.length && !running;
    const btn = $('sendBtn');
    btn.disabled = !ready;
    btn.textContent = running ? 'Sending…'
      : state.campaign?.status === 'paused' ? `Start new (${plural(dn, 'contact')})`
      : `Send to ${plural(dn, 'contact')}`;

    const warn = $('sendWarn');
    const msgs = [];
    if (n > state.config.largeCampaign) msgs.push(`Large list (${n}). Sending to many people who haven't saved your number raises the ban risk — consider splitting it over several days.`);
    if (state.preset === 'fast') msgs.push('Fast speed is selected. This raises the risk of your number being banned.');
    warn.classList.toggle('hidden', !msgs.length);
    warn.textContent = msgs.join(' ');
  }
  $('checklist').addEventListener('click', (e) => { const n = e.target.closest('[data-goto]')?.dataset.goto; if (n) go(Number(n)); });

  $('sendBtn').onclick = async () => {
    const n = state.contacts.valid.length;
    const active = ['running', 'paused'].includes(state.campaign?.status);
    if (active && !(await ask('Replace paused campaign?', 'A paused campaign still has contacts left. Starting a new one will replace it.', 'Replace', true))) return;
    const parts = sequence().length;
    if (!(await ask(`Send to ${plural(n, 'contact')}?`, `Each contact gets ${plural(parts, 'message')}.\nEstimated time: ${fmtDuration(estimate(n, parts))}.\nKeep the server window open until it finishes.`, 'Start sending'))) return;
    try {
      await api('/api/campaign/start', {
        method: 'POST',
        body: JSON.stringify({ raw: $('contactsRaw').value, items: payloadItems(), settings: effective() }),
      });
      toast('Sending started — watch the progress on the right');
      $('progressCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { toast(e.message, true); }
  };

  // ================= progress =================
  const STATUS_LABEL = { pending: 'Pending', sending: 'Sending…', sent: 'Sent', failed: 'Failed', skipped: 'Not on WhatsApp' };
  const CAMP_LABEL = { running: 'Sending', paused: 'Paused', stopped: 'Stopped', done: 'Finished', idle: 'Idle' };
  function renderCampaign() {
    const c = state.campaign;
    const has = !!c?.rows?.length;
    $('campIdle').classList.toggle('hidden', has);
    $('progressCard').classList.toggle('hidden', !has); // shown once there is a campaign
    $('campBody').classList.toggle('hidden', !has);
    $('campStatus').textContent = has ? CAMP_LABEL[c.status] || c.status : '—';
    $('campStatus').className = 'badge ' + (has ? c.status : '');
    const active = has && ['running', 'paused'].includes(c.status);
    $('headStatus').classList.toggle('hidden', !active);
    renderLock();
    renderPreview();
    renderStepper();
    renderReview();
    if (!has) return;

    const { counts } = c;
    const doneN = counts.sent + counts.failed + counts.skipped;
    const pct = counts.total ? Math.floor((doneN / counts.total) * 100) : 0;
    $('pct').textContent = pct + '%';
    $('bar').style.width = pct + '%';
    $('headStatusBar').style.width = pct + '%';
    $('headStatusText').textContent = `${c.status === 'paused' ? 'Paused' : 'Sending'} · ${doneN} of ${counts.total}`;
    const now = $('nowSending');
    now.classList.toggle('hidden', !(c.status === 'running' && c.current));
    if (c.current) now.innerHTML = `<span class="spinner"></span>Now sending to <b>+${esc(c.current)}</b>`;
    $('doneOf').textContent = `${doneN} of ${counts.total} processed`;
    $('cSent').textContent = counts.sent;
    $('cFailed').textContent = counts.failed;
    $('cSkipped').textContent = counts.skipped;
    $('cPending').textContent = counts.pending;
    $('campNote').classList.toggle('hidden', !c.note);
    $('campNote').textContent = c.note || '';
    $('pauseBtn').classList.toggle('hidden', c.status !== 'running');
    $('resumeBtn').classList.toggle('hidden', c.status !== 'paused');
    $('stopBtn').classList.toggle('hidden', !active);

    const rows = c.rows.map((r, i) => ({ ...r, i: i + 1 }))
      .filter((r) => state.filter === 'all' || r.status === state.filter || (state.filter === 'pending' && r.status === 'sending'));
    const shown = rows.slice(0, 1000);
    $('rows').innerHTML = shown.map((r) => `<tr class="${r.status === 'sending' ? 'current' : ''}"><td>${r.i}</td><td class="mono">+${esc(r.number)}</td><td class="st ${r.status}">${STATUS_LABEL[r.status] || r.status}</td><td class="detail">${esc(r.error || (r.at ? new Date(r.at).toLocaleTimeString() : ''))}</td></tr>`).join('')
      + (rows.length > shown.length ? `<tr><td colspan="4" class="muted">…${rows.length - shown.length} more — download the CSV for all</td></tr>` : '')
      + (!rows.length ? '<tr><td colspan="4" class="muted">Nothing here.</td></tr>' : '');
    renderCountdown();
  }
  function renderCountdown() {
    const c = state.campaign;
    const el = $('campCountdown');
    if (!c || c.status !== 'running') { el.textContent = c?.status === 'done' ? 'All done 🎉' : ''; return; }
    if (c.waitingUntil) {
      const sec = Math.max(0, Math.round((c.waitingUntil - Date.now()) / 1000));
      el.textContent = sec >= 60 ? `Taking a break · next in ${Math.floor(sec / 60)}m ${sec % 60}s` : `Next contact in ${sec}s`;
    } else el.textContent = 'Sending now…';
  }
  setInterval(renderCountdown, 1000);
  socket.on('campaign:update', (c) => {
    const prev = state.campaign?.status;
    if (!['running', 'paused'].includes(prev) && c.status === 'running' && step !== 2) showStep(2, false);
    state.campaign = c;
    renderCampaign();
    if (prev === 'running' && c.status === 'done') toast(`Finished: ${c.counts.sent} sent, ${c.counts.failed} failed, ${c.counts.skipped} not on WhatsApp`);
  });
  document.querySelector('.filters').addEventListener('click', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    state.filter = f;
    document.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('active', b.dataset.f === f));
    renderCampaign();
  });
  const action = (name) => async () => {
    if (name === 'stop' && !(await ask('Stop sending?', 'Contacts that have not been messaged yet will not receive it.', 'Stop', true))) return;
    await api('/api/campaign/' + name, { method: 'POST' }).catch((e) => toast(e.message, true));
  };
  $('pauseBtn').onclick = action('pause');
  $('resumeBtn').onclick = action('resume');
  $('stopBtn').onclick = action('stop');
  $('headStatus').onclick = () => { showStep(2, false); $('progressCard').scrollIntoView({ behavior: 'smooth' }); };

  // ================= account card =================
  const fmtDate = (ymd) => (ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  function planText(u) {
    const sub = u.subscription;
    if (sub.status === 'admin') return { cls: 'admin', text: 'Administrator' };
    if (sub.status === 'expired') return { cls: 'bad', text: 'Subscription ended' };
    if (sub.status === 'expiring') return { cls: 'warn', text: sub.daysLeft === 0 ? 'Ends today' : `Ends in ${plural(sub.daysLeft, 'day')}` };
    return { cls: 'ok', text: `Active until ${fmtDate(u.endDate)}` };
  }
  function renderAccount() {
    const u = state.me;
    $('accName').textContent = u.name || u.email.split('@')[0];
    $('accEmail').textContent = u.email;
    $('accAvatar').textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
    const p = planText(u);
    $('planBadge').className = 'plan ' + p.cls;
    $('planBadge').textContent = p.text;
    $('navAdmin').classList.toggle('hidden', u.role !== 'admin');
  }

  // ================= admin: users =================
  state.users = [];
  let userFilter = 'all';
  let editingUser = null;
  const STATUS_TEXT = { active: 'Active', expiring: 'Expiring soon', expired: 'Expired', admin: 'Admin' };
  const fmtWhenLong = (d) => (d ? new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never');

  async function loadUsers() {
    if (state.me?.role !== 'admin') return;
    try {
      state.users = (await api('/api/admin/users')).users;
    } catch (e) { return toast(e.message, true); }
    renderUsers();
  }

  function renderUsers() {
    const customers = state.users.filter((u) => u.role !== 'admin');
    const count = (st) => customers.filter((u) => u.subscription.status === st).length;
    $('stTotal').textContent = customers.length;
    $('stActive').textContent = count('active');
    $('stExpiring').textContent = count('expiring');
    $('stExpired').textContent = count('expired');
    $('tabAdminSub').textContent = customers.length ? `${plural(customers.length, 'customer')}${count('expired') ? ' · ' + count('expired') + ' expired' : ''}` : 'Accounts & subscriptions';

    const q = $('userSearch').value.trim().toLowerCase();
    const rows = state.users.filter((u) => (userFilter === 'all' || u.subscription.status === userFilter)
      && (!q || u.email.includes(q) || (u.name || '').toLowerCase().includes(q)));
    $('userRows').innerHTML = rows.map((u) => {
      const sub = u.subscription;
      const days = sub.status === 'expiring' ? ` · ${sub.daysLeft === 0 ? 'today' : plural(sub.daysLeft, 'day') + ' left'}` : sub.status === 'expired' ? ` · ${plural(-sub.daysLeft, 'day')} ago` : '';
      const isSelf = u.id === state.me.id;
      return `<tr data-uid="${esc(u.id)}">
        <td><div class="u-cell"><span class="u-av">${esc((u.name || u.email).charAt(0).toUpperCase())}</span>
          <div><div class="u-name">${esc(u.name || '—')}${isSelf ? ' <span class="you">You</span>' : ''}</div><div class="u-mail">${esc(u.email)}</div></div></div></td>
        <td>${u.role === 'admin' ? '<span class="muted">Never</span>' : esc(fmtDate(u.endDate)) + '<span class="muted small">' + esc(days) + '</span>'}</td>
        <td><span class="status s-${sub.status}">${STATUS_TEXT[sub.status]}</span></td>
        <td class="muted">${esc(fmtWhenLong(u.lastLoginAt))}</td>
        <td class="right nowrap">
          ${u.role === 'admin' ? '' : '<button class="btn btn-ghost btn-xs" data-ua="extend" title="Add one month to the end date">+1 month</button>'}
          <button class="btn btn-ghost btn-xs" data-ua="edit">Edit</button>
          ${isSelf || u.role === 'admin' ? '' : '<button class="ibtn del" data-ua="delete" title="Delete user" aria-label="Delete user">' + ICON.del + '</button>'}
        </td>
      </tr>`;
    }).join('');
    $('usersEmpty').classList.toggle('hidden', state.users.length > 1 || rows.length > 0);
  }
  $('userSearch').addEventListener('input', renderUsers);
  $('userFilters').addEventListener('click', (e) => {
    const f = e.target.dataset.uf;
    if (!f) return;
    userFilter = f;
    $('userFilters').querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('active', b.dataset.uf === f));
    renderUsers();
  });

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function addMonths(fromYmd, months) {
    const today = new Date();
    const base = fromYmd && new Date(fromYmd + 'T00:00:00') > today ? new Date(fromYmd + 'T00:00:00') : today;
    const d = new Date(base);
    d.setMonth(d.getMonth() + months);
    return ymd(d);
  }

  function openUserDialog(user) {
    editingUser = user || null;
    const isAdminUser = user?.role === 'admin';
    $('userDlgTitle').textContent = user ? 'Edit user' : 'Add user';
    $('userDlgSub').textContent = user ? 'Change details or extend the subscription. Leave the password empty to keep it.' : 'The customer signs in with this email and password.';
    $('uName').value = user?.name || '';
    $('uEmail').value = user?.email || '';
    $('uPassword').value = '';
    $('uPassLabel').textContent = user ? 'New password (optional)' : 'Password';
    $('uEnd').value = user?.endDate || addMonths(null, 1);
    $('uEndField').classList.toggle('hidden', isAdminUser);
    $('quickDates').classList.toggle('hidden', isAdminUser);
    $('userDlgError').classList.add('hidden');
    $('userDialog').showModal();
    $(user ? 'uEnd' : 'uName').focus();
  }
  $('addUserBtn').onclick = () => openUserDialog(null);
  $('quickDates').addEventListener('click', (e) => {
    const m = Number(e.target.dataset.add);
    if (m) $('uEnd').value = addMonths(editingUser?.endDate || null, m);
  });
  $('userForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return; // Cancel closes normally
    e.preventDefault();
    const body = { name: $('uName').value, email: $('uEmail').value, endDate: $('uEnd').value, password: $('uPassword').value };
    const btn = $('userSave');
    btn.disabled = true;
    try {
      if (editingUser) await api('/api/admin/users/' + encodeURIComponent(editingUser.id), { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      $('userDialog').close();
      toast(editingUser ? 'User updated' : 'User created — share the email and password with your customer');
      if (editingUser?.id === state.me.id) { state.me = (await api('/api/me')).user; renderAccount(); }
      await loadUsers();
    } catch (err) {
      $('userDlgError').textContent = err.message;
      $('userDlgError').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
  $('userRows').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-ua]')?.dataset.ua;
    if (!act) return;
    const u = state.users.find((x) => x.id === e.target.closest('tr').dataset.uid);
    if (!u) return;
    try {
      if (act === 'edit') return openUserDialog(u);
      if (act === 'extend') {
        const endDate = addMonths(u.endDate, 1);
        await api('/api/admin/users/' + encodeURIComponent(u.id), { method: 'PATCH', body: JSON.stringify({ name: u.name, email: u.email, endDate }) });
        toast(`${u.name || u.email}: now active until ${fmtDate(endDate)}`);
      }
      if (act === 'delete') {
        if (!(await ask(`Delete ${u.name || u.email}?`, 'Their account, WhatsApp link, drafts and files will be removed. This cannot be undone.', 'Delete user', true))) return;
        await api('/api/admin/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
        toast('User deleted');
      }
      await loadUsers();
    } catch (err) { toast(err.message, true); }
  });

  // ================= init =================
  (async () => {
    try {
      const me = await api('/api/me');
      state.me = me.user;
      state.supportPhone = me.supportPhone;
      storePrefix = `bws:${me.user.id}:`;
      // carry the admin's pre-accounts browser data (contacts, composer, step, speed) over once
      if (me.user.role === 'admin') {
        try {
          for (const k of ['contacts', 'cc', 'items', 'step', 'settings']) {
            const old = localStorage.getItem('bws:' + k);
            if (old !== null && localStorage.getItem(storePrefix + k) === null) localStorage.setItem(storePrefix + k, old);
          }
        } catch { /* storage unavailable */ }
      }
      renderAccount();
    } catch { return; /* redirected to sign in, or subscription screen shown */ }
    try { state.config = { ...state.config, ...(await api('/api/config')) }; } catch { /* defaults */ }
    $('maxMb').textContent = state.config.maxFileMb;

    const saved = store.get('settings', null);
    if (saved?.preset) { state.preset = saved.preset; state.settings = { ...PRESETS.normal, ...saved.values }; }
    writeSettingInputs();

    $('contactsRaw').value = store.get('contacts', '');
    $('countryCode').value = store.get('cc', '');

    // restore message items (and migrate the old single-text format)
    let items = store.get('items', null);
    if (!items) {
      items = [];
      const oldText = store.get('text', '');
      if (oldText) items.push({ id: uid(), type: 'text', text: oldText });
      for (const a of store.get('attachments', [])) items.push({ id: uid(), type: 'file', uploadId: a.id, caption: '', originalName: a.originalName, mimetype: a.mimetype, size: a.size, kind: a.kind });
    }
    try {
      const onServer = new Map((await api('/api/uploads')).map((u) => [u.id, u]));
      state.items = items.filter((i) => i.type === 'text' || onServer.has(i.uploadId)).map((i) => (i.type === 'file' ? { ...i, kind: onServer.get(i.uploadId).kind } : i));
    } catch { state.items = items.filter((i) => i.type === 'text'); }
    if (!state.items.length) state.items.push({ id: uid(), type: 'text', text: '' });
    saveItems();
    renderItems();
    await refreshContacts();
    loadDrafts();
    showStep(isActive() ? 2 : store.get('step', 1), false);
    renderWa();
  })();
})();
