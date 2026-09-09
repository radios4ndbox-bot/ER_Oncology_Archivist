'use strict';

/* ══════════════════════════════════════════════════════════════════
   ER Oncology Archivist — logica applicativa (processo renderer)

   Differenze sostanziali rispetto alla versione monofile precedente:

   1. Lo stato globale è dichiarato (nella versione precedente mancava
      del tutto: currentStep, DB, saveTimer… → ReferenceError).
   2. Nessun HTML costruito con dati del paziente non sanificati:
      tutto passa da esc(). Nessun gestore inline: la CSP può quindi
      vietare 'unsafe-inline'.
   3. Salvataggio con merge (leggi → unisci → scrivi → verifica): due
      postazioni non si sovrascrivono più a vicenda.
   4. Un file dati illeggibile mette l'app in sola lettura invece di
      azzerare l'archivio in memoria e riscriverlo vuoto.
   ══════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════════════
//  COSTANTI
// ══════════════════════════════════════════════════════════════════
const DATA_FILE = 'ps_onco_data.json';
const LOCK_FILE = 'ps_onco.lock';
const LOCK_TTL = 15000;
const LOCK_HEARTBEAT = 8000;
const REMOTE_POLL = 20000;
const SCHEMA = 2;
const TOMBSTONE_TTL = 180 * 24 * 60 * 60 * 1000; // 6 mesi
const MAX_FIELD = 20000;
const STEP_LABELS = ['Anagrafica', 'Esame PS', 'Diagnosi', 'Anat. Pat.'];
const DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MESI = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

const API = window.psApi || null;
const IS_ELECTRON = !!API;
const SESSION_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

// ══════════════════════════════════════════════════════════════════
//  STATO GLOBALE
// ══════════════════════════════════════════════════════════════════
let DB = [];                 // record normalizzati
let deletedIds = {};         // id → timestamp cancellazione (tombstone)
let filtered = [];
let selected = new Set();
let sortKey = 'data';
let sortDir = -1;

let currentStep = 1;
let editingId = null;
let fuItems = [];
let fuTargetId = null;
let detailId = null;

let wOnco = null;
let wPrimo = false;
let wSottocat = null;
let wMetastasi = null;

let dataFolder = null;
let storageReady = false;    // true → persistenza su file attiva
let readOnly = false;        // file dati presente ma illeggibile
let saveTimer = null;
let lockInterval = null;
let pollInterval = null;
let saveChain = Promise.resolve();
let appInfo = {};

// ══════════════════════════════════════════════════════════════════
//  UTILITÀ
// ══════════════════════════════════════════════════════════════════
const el = (id) => document.getElementById(id);
const val = (id) => {
  const e = el(id);
  if (!e) return '';
  // i campi data mostrano gg/mm/aaaa ma conservano l'ISO in data-iso
  if (e.hasAttribute('data-date')) return e.getAttribute('data-iso') || '';
  return String(e.value || '').trim();
};
const rawVal = (id) => { const e = el(id); return e ? String(e.value || '') : ''; };

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Unico punto di inserimento di dati utente nell'HTML. */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function str(value, max) {
  if (value == null) return '';
  return String(value).slice(0, max || MAX_FIELD);
}

function num(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

function oneOf(value, allowed, fallback) {
  return allowed.indexOf(value) !== -1 ? value : fallback;
}

/** Accetta solo date ISO yyyy-mm-dd plausibili. */
function dateStr(value) {
  const s = String(value == null ? '' : value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : s;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function calcAge(dob) {
  if (!dob) return null;
  const b = new Date(dob + 'T00:00:00');
  if (isNaN(b.getTime())) return null;
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  if (a < 0 || a > 130) return null;
  return a;
}

function fmtDate(d) {
  if (!d) return '—';
  const p = String(d).split('-');
  if (p.length === 3 && p[0].length === 4) return p[2] + '/' + p[1] + '/' + p[0];
  return String(d);
}

function fmtMese(m) {
  const p = String(m).split('-');
  const idx = parseInt(p[1], 10) - 1;
  return (MESI[idx] || '?') + ' ' + p[0];
}

function fmtMeseBreve(m) {
  const p = String(m).split('-');
  const idx = parseInt(p[1], 10) - 1;
  return (MESI[idx] || '?') + " '" + String(p[0]).slice(2);
}

function pct(n, d, dec) {
  if (!d) return '—';
  const v = n / d * 100;
  return (dec ? v.toFixed(dec) : String(Math.round(v))) + '%';
}

function notify(msg) {
  const n = el('notif');
  if (!n) return;
  n.textContent = String(msg);
  n.classList.add('show');
  setTimeout(() => n.classList.remove('show'), 3200);
}

function setStatus(cls, txt) {
  const e = el('saveStatus');
  if (!e) return;
  e.className = 'save-status ' + cls;
  e.textContent = txt;
}

function closeOverlay(id) {
  const e = el(id);
  if (e) e.classList.remove('open');
}

// ══════════════════════════════════════════════════════════════════
//  RILEVAMENTO SESSO DAL NOME
//  Rispetto alla versione precedente: la normalizzazione non scarta
//  più le lettere fuori dal Latin-1 (i nomi slavi/baltici del database
//  erano irraggiungibili) e il nome di battesimo ha la precedenza sul
//  cognome (Rossi Rosa non diventa più "F" per via del cognome).
// ══════════════════════════════════════════════════════════════════
function nameTokens(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{M}]+/u)
    .filter((t) => t.length > 1);
}

function lookupSex(tokens) {
  const m = window.NAMES_M, f = window.NAMES_F;
  if (!m || !f) return null;
  for (let i = 0; i < tokens.length; i++) {
    if (m.has(tokens[i])) return 'M';
    if (f.has(tokens[i])) return 'F';
  }
  return null;
}

function detectSesso(nome, cognome) {
  return lookupSex(nameTokens(nome)) || lookupSex(nameTokens(cognome)) || 'U';
}

// ══════════════════════════════════════════════════════════════════
//  MODELLO DATI — normalizzazione e merge
//  Il file vive su una condivisione di rete scritta da più postazioni:
//  è input non fidato e va validato ad ogni lettura.
// ══════════════════════════════════════════════════════════════════
function normalizeFollowup(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).map((f) => ({
    date: dateStr(f && f.date),
    type: str(f && f.type, 200),
    text: str(f && f.text, MAX_FIELD)
  }));
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const created = num(raw.createdAt) || Date.now();
  const rec = {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id.slice(0, 64) : uid(),
    cognome: str(raw.cognome, 120),
    nome: str(raw.nome, 120),
    sesso: oneOf(raw.sesso, ['M', 'F', 'U'], 'U'),
    dob: dateStr(raw.dob),
    prima_onco: oneOf(raw.prima_onco, ['si', 'no', 'ignoto'], ''),
    data: dateStr(raw.data),
    tipo_esame: str(raw.tipo_esame, 200),
    richiesta: str(raw.richiesta),
    onco: oneOf(raw.onco, ['si', 'sospetto'], ''),
    diagnosi: str(raw.diagnosi),
    sede: str(raw.sede, 200),
    dim: str(raw.dim, 100),
    primo_riscontro: !!raw.primo_riscontro,
    sottocat: oneOf(raw.sottocat, ['unica', 'associata'], null),
    pat_assoc: str(raw.pat_assoc),
    metastasi: oneOf(raw.metastasi, ['si', 'no'], null),
    meta_sede: str(raw.meta_sede, 200),
    meta_primitivo: str(raw.meta_primitivo, 200),
    anat: str(raw.anat),
    note: str(raw.note),
    followup: normalizeFollowup(raw.followup),
    createdAt: created,
    updatedAt: num(raw.updatedAt) || created
  };
  rec.eta = calcAge(rec.dob);
  return rec;
}

/** Notepad e PowerShell 5.1 scrivono UTF-8 con BOM: senza questo, un file
 *  dati toccato a mano manderebbe l'app in sola lettura. */
function stripBom(text) {
  return (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF) ? text.slice(1) : text;
}

function parseStore(input) {
  const text = stripBom(input);
  if (text == null || !String(text).trim()) return { records: [], deleted: {} };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('Il file ' + DATA_FILE + ' non contiene JSON valido.');
  }
  let list = [];
  const deleted = {};
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    list = Array.isArray(raw.records) ? raw.records : [];
    if (raw.deleted && typeof raw.deleted === 'object') {
      Object.keys(raw.deleted).forEach((k) => {
        const t = Number(raw.deleted[k]);
        if (isFinite(t) && t > 0) deleted[String(k).slice(0, 64)] = t;
      });
    }
  } else {
    throw new Error('Struttura del file ' + DATA_FILE + ' non riconosciuta.');
  }
  const records = [];
  list.forEach((r) => {
    const rec = normalizeRecord(r);
    if (rec) records.push(rec);
  });
  return { records: records, deleted: deleted };
}

function serializeStore(store) {
  return JSON.stringify({
    schema: SCHEMA,
    savedAt: new Date().toISOString(),
    records: store.records,
    deleted: store.deleted
  }, null, 2);
}

/** Unione last-write-wins per id, con tombstone per le cancellazioni. */
function mergeStores(a, b) {
  const deleted = {};
  [a.deleted, b.deleted].forEach((src) => {
    Object.keys(src || {}).forEach((id) => {
      deleted[id] = Math.max(deleted[id] || 0, src[id]);
    });
  });

  const byId = new Map();
  a.records.concat(b.records).forEach((r) => {
    const prev = byId.get(r.id);
    if (!prev || r.updatedAt > prev.updatedAt) byId.set(r.id, r);
  });

  // I tombstone si applicano PRIMA della potatura: potare per primi
  // farebbe riapparire un record cancellato al superamento della TTL.
  const records = [];
  byId.forEach((r) => {
    const tomb = deleted[r.id];
    if (!(tomb && tomb >= r.updatedAt)) records.push(r);
  });

  const cutoff = Date.now() - TOMBSTONE_TTL;
  Object.keys(deleted).forEach((id) => { if (deleted[id] < cutoff) delete deleted[id]; });

  return { records: records, deleted: deleted };
}

function storeSignature(store) {
  return store.records
    .map((r) => r.id + ':' + r.updatedAt)
    .sort()
    .join('|');
}

/** true se `check` contiene tutto ciò che avevamo scritto. */
function storeContains(check, expected) {
  const map = new Map();
  check.records.forEach((r) => map.set(r.id, r.updatedAt));
  for (let i = 0; i < expected.records.length; i++) {
    const r = expected.records[i];
    const got = map.get(r.id);
    if (got === undefined || got < r.updatedAt) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════
//  STORAGE
// ══════════════════════════════════════════════════════════════════
async function checkServer() {
  setStatus('offline', '● avvio...');
  if (!IS_ELECTRON) {
    renderBanners('browser');
    setStatus('offline', '● sessione temporanea');
    refreshViews();
    return;
  }
  try {
    appInfo = await API.info();
  } catch (_) { appInfo = {}; }
  try {
    dataFolder = await API.getDataFolder();
  } catch (e) {
    dataFolder = null;
  }
  refreshSettingsInfo();
  if (dataFolder) {
    await activateFolder();
  } else {
    showWelcomeModal();
  }
}

async function activateFolder() {
  storageReady = true;
  refreshSettingsInfo();
  readOnly = false;
  renderBanners('file');
  await loadFromFile();
  if (storageReady) {
    startLock();
    startPolling();
  }
}

function showWelcomeModal() {
  const p = el('examplePath');
  if (p) p.textContent = '\\\\SERVER\\PSOnco';
  const o = el('welcomeOverlay');
  if (o) o.style.display = 'flex';
}

async function welcomeSelectFolder() {
  const o = el('welcomeOverlay');
  if (o) o.style.display = 'none';
  await selectFolder();
  if (!storageReady) showWelcomeModal();
}

async function selectFolder() {
  if (!IS_ELECTRON) return;
  try {
    const folder = await API.selectDataFolder();
    if (!folder) return;
    dataFolder = folder;
    await activateFolder();
  } catch (e) {
    notify('Errore selezione cartella: ' + e.message);
  }
}

async function loadFromFile() {
  let text;
  try {
    text = await API.readText(DATA_FILE);
  } catch (e) {
    // Rete non disponibile: NON si azzera l'archivio e NON si scrive.
    enterReadOnly('Cartella dati non raggiungibile: ' + e.message);
    return;
  }
  try {
    const store = parseStore(text);
    DB = store.records;
    deletedIds = store.deleted;
    setStatus('saved', '● file locale');
  } catch (e) {
    enterReadOnly(e.message + ' Archivio aperto in sola lettura: nessuna scrittura verrà eseguita.');
    return;
  }
  refreshViews();
}

/** Modalità protettiva: si può consultare ma mai sovrascrivere il file. */
function enterReadOnly(message) {
  storageReady = false;
  readOnly = true;
  stopLock();
  stopPolling();
  setStatus('offline', '● sola lettura');
  renderBanners('readonly');
  notify(message);
  refreshViews();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistDB(); }, 400);
}

function persistDB() {
  saveChain = saveChain.then(doPersist, doPersist);
  return saveChain;
}

async function doPersist() {
  if (!IS_ELECTRON || !storageReady) {
    // Modalità browser / sola lettura: i dati restano solo in memoria.
    refreshViews();
    return;
  }
  setStatus('saving', '● salvataggio...');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = parseStore(await API.readText(DATA_FILE));
      const merged = mergeStores(remote, { records: DB, deleted: deletedIds });
      await API.writeText(DATA_FILE, serializeStore(merged));

      const check = parseStore(await API.readText(DATA_FILE));
      DB = merged.records;
      deletedIds = merged.deleted;
      if (storeContains(check, merged)) {
        setStatus('saved', '● salvato');
        refreshViews();
        return;
      }
    }
    setStatus('offline', '● conflitto');
    notify('Scrittura contesa con l’altra postazione: dati non confermati, riprovare.');
  } catch (e) {
    setStatus('offline', '● errore');
    notify('Errore salvataggio: ' + e.message);
  }
}

/** Recupera le modifiche fatte dall'altra postazione senza scrivere. */
async function refreshFromRemote() {
  if (!IS_ELECTRON || !storageReady) return;
  try {
    const remote = parseStore(await API.readText(DATA_FILE));
    const before = storeSignature({ records: DB, deleted: deletedIds });
    const merged = mergeStores(remote, { records: DB, deleted: deletedIds });
    const after = storeSignature(merged);
    if (before === after) return;
    DB = merged.records;
    deletedIds = merged.deleted;
    refreshViews();
    notify('Archivio aggiornato con le modifiche dell’altra postazione.');
  } catch (e) { /* transitorio: si riprova al giro successivo */ }
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(refreshFromRemote, REMOTE_POLL);
  window.addEventListener('focus', refreshFromRemote);
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}

function renderBanners(mode) {
  let msg, cls;
  if (mode === 'file') {
    msg = '<div class="mode-dot"></div> Dati in <strong>' + esc(DATA_FILE) + '</strong>' +
      (dataFolder ? ' — <span class="mono-path">' + esc(dataFolder) + '</span>' : '') +
      ' &nbsp;<button type="button" class="banner-btn" data-act="select-folder">Cambia cartella</button>' +
      ' <button type="button" class="banner-btn" data-act="reload">Ricarica</button>';
    cls = 'local';
  } else if (mode === 'readonly') {
    msg = '<div class="mode-dot"></div> <strong>Sola lettura</strong> — il file dati non è leggibile. ' +
      'Nessuna modifica verrà salvata. &nbsp;' +
      '<button type="button" class="banner-btn" data-act="reload">Riprova</button>' +
      ' <button type="button" class="banner-btn" data-act="select-folder">Cambia cartella</button>';
    cls = 'browser';
  } else {
    msg = '<div class="mode-dot"></div> Modalità browser: <strong>i dati non vengono salvati</strong>. ' +
      'Avviare <strong>ER Oncology Archivist.exe</strong> per lavorare sull’archivio.';
    cls = 'browser';
  }
  ['modeBanner', 'dbModeBanner', 'statsModeBanner'].forEach((id) => {
    const e = el(id);
    if (e) e.innerHTML = '<div class="mode-banner ' + cls + '">' + msg + '</div>';
  });
}

// ══════════════════════════════════════════════════════════════════
//  LOCK FILE (informativo: la sicurezza dei dati è garantita dal merge)
// ══════════════════════════════════════════════════════════════════
async function lockTick() {
  if (!IS_ELECTRON || !storageReady) return;
  let info = null;
  try {
    const raw = await API.readText(LOCK_FILE);
    if (raw) {
      try { info = JSON.parse(raw); } catch (_) { info = null; }
    }
  } catch (_) { return; }

  const ts = info ? Number(info.ts) : 0;
  const fresh = isFinite(ts) && (Date.now() - ts) < LOCK_TTL;
  const mine = info && info.owner === SESSION_ID;

  if (fresh && !mine) {
    showLockBanner(info);
    return;                       // non si ruba il lock a una sessione viva
  }
  hideLockBanner();
  try {
    await API.writeText(LOCK_FILE, JSON.stringify({
      owner: SESSION_ID,
      ts: Date.now(),
      opened: new Date().toLocaleTimeString('it-IT')
    }));
  } catch (_) { /* il lock è solo informativo */ }
}

function startLock() {
  stopLock();
  lockTick();
  lockInterval = setInterval(lockTick, LOCK_HEARTBEAT);
}

function stopLock() {
  if (lockInterval) clearInterval(lockInterval);
  lockInterval = null;
}

function showLockBanner(info) {
  const b = el('lockBanner');
  if (!b) return;
  b.classList.add('show');
  const d = el('lockDetail');
  if (d) d.textContent = info && info.opened ? 'aperto alle ' + str(info.opened, 30) : '';
}

function hideLockBanner() {
  const b = el('lockBanner');
  if (b) b.classList.remove('show');
}

async function releaseLock() {
  stopLock();
  stopPolling();
  if (!IS_ELECTRON || !storageReady) return;
  try {
    const raw = await API.readText(LOCK_FILE);
    if (!raw) return;
    const info = JSON.parse(raw);
    if (info && info.owner === SESSION_ID) await API.deleteFile(LOCK_FILE);
  } catch (_) { /* niente da fare in chiusura */ }
}

// ══════════════════════════════════════════════════════════════════
//  BADGE / ETICHETTE
// ══════════════════════════════════════════════════════════════════
function primaLabel(v) {
  if (v === 'si') return '<span class="badge badge-onco">Prima diagnosi</span>';
  if (v === 'no') return '<span class="badge badge-no">Già nota</span>';
  return '<span class="badge badge-u">Non noto</span>';
}

function oncoLabel(v) {
  if (v === 'si') return '<span class="badge badge-onco">Oncologico</span>';
  if (v === 'sospetto') return '<span class="badge badge-sosp">Sospetto</span>';
  return '<span class="badge badge-u">—</span>';
}

function classTumoreLabel(r) {
  if (!r.primo_riscontro) return '<span class="badge badge-u">—</span>';
  if (r.sottocat === 'unica') return '<span class="badge badge-onco">Primo · unica pat.</span>';
  if (r.sottocat === 'associata') return '<span class="badge badge-sosp">Primo · pat. associate</span>';
  return '<span class="badge badge-onco">Primo riscontro</span>';
}

function metaLabel(r) {
  if (r.metastasi === 'si') {
    let t = '<span class="badge badge-meta">Metastasi</span>';
    if (r.meta_sede) t += ' <span class="badge-note">' + esc(r.meta_sede) + '</span>';
    return t;
  }
  if (r.metastasi === 'no') return '<span class="badge badge-no">Primitivo</span>';
  return '<span class="badge badge-u">—</span>';
}

// ══════════════════════════════════════════════════════════════════
//  VISTE
// ══════════════════════════════════════════════════════════════════
function refreshViews() {
  updateSuggests();
  applyFilters();
  renderStats();
}

const VIEW_ORDER = ['wizard', 'db', 'stats'];
let currentView = 'wizard';

function showView(name) {
  if (VIEW_ORDER.indexOf(name) === -1 || name === currentView) return;
  currentView = name;
  applyViewState();
  window.scrollTo(0, 0);
  if (name === 'stats') renderStats();
  if (name === 'db') applyFilters();
  popSections(name);
}

/** Sposta il binario e allinea schede, aria e highlight. */
function applyViewState() {
  const idx = VIEW_ORDER.indexOf(currentView);
  const track = el('viewsTrack');
  if (track) track.style.transform = 'translateX(' + (-idx * 100) + '%)';

  VIEW_ORDER.forEach((v, i) => {
    const view = el('view-' + v);
    if (!view) return;
    if (i === idx) {
      view.classList.add('active');
      view.removeAttribute('aria-hidden');
    } else {
      view.classList.remove('active');
      // le viste fuori campo non devono essere raggiungibili da tastiera
      view.setAttribute('aria-hidden', 'true');
    }
  });

  document.querySelectorAll('.nav-tab').forEach((t) => {
    const suo = t.getAttribute('data-view') === currentView;
    t.classList.toggle('active', suo);
    t.setAttribute('aria-selected', suo ? 'true' : 'false');
  });

  moveTabHighlight();
}

/** Il pannello luminoso scivola sotto la scheda attiva. */
function moveTabHighlight() {
  const hl = el('navTabHighlight');
  const active = document.querySelector('.nav-tab.active');
  if (!hl || !active || !hl.parentElement) return;
  hl.style.height = active.offsetHeight + 'px';
  hl.style.top = active.offsetTop + 'px';
  // offsetLeft/offsetWidth ignorano le transform: se l'elemento attivo
  // e' ingrandito dal puntatore, il fondino non deve seguirlo.
  if (!active.offsetWidth) return;
  hl.style.width = active.offsetWidth + 'px';
  hl.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  hl.classList.add('ready');
}

// ══════════════════════════════════════════════════════════════════
//  WIZARD
// ══════════════════════════════════════════════════════════════════
function buildProgress() {
  const wrap = el('wizProgress');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let i = 1; i <= 4; i++) {
    const step = document.createElement('div');
    step.className = 'wp-step';
    const dot = document.createElement('div');
    dot.className = 'wp-dot ' + (i < currentStep ? 'done' : i === currentStep ? 'active' : 'todo');
    dot.textContent = i < currentStep ? '✓' : String(i);
    const lbl = document.createElement('div');
    lbl.className = 'wp-label' + (i === currentStep ? ' active' : '');
    lbl.textContent = STEP_LABELS[i - 1];
    step.appendChild(dot);
    step.appendChild(lbl);
    wrap.appendChild(step);
    if (i < 4) {
      const line = document.createElement('div');
      line.className = 'wp-line' + (i < currentStep ? ' done' : '');
      wrap.appendChild(line);
    }
  }
}

function onNomeInput() {
  const nome = val('w_nome');
  const cognome = val('w_cognome');
  const override = val('w_sesso_override');
  const sesso = override || detectSesso(nome, cognome);
  const box = el('sessoDetected');
  if (box) {
    if (nome || cognome) {
      box.style.display = 'inline-flex';
      if (sesso === 'M') { box.className = 'sesso-detected m'; box.textContent = 'Rilevato: Maschio'; }
      else if (sesso === 'F') { box.className = 'sesso-detected f'; box.textContent = 'Rilevato: Femmina'; }
      else { box.className = 'sesso-detected unknown'; box.textContent = 'Sesso non determinabile'; }
    } else {
      box.style.display = 'none';
    }
  }
  liveValidate1();
}

function updateAge() {
  const age = calcAge(val('w_dob'));
  const box = el('ageBox');
  if (box) {
    if (age !== null) { box.style.display = 'inline-flex'; el('ageVal').textContent = String(age); }
    else box.style.display = 'none';
  }
  liveValidate1();
}

function liveValidate1() {
  const ok = !!(val('w_cognome') && val('w_nome') && val('w_dob'));
  const btn = el('btn1next');
  if (btn) btn.disabled = !ok;
}

function liveValidate2() {
  const dp = val('w_data');
  const ok = !!(dp && val('w_tipo_esame') && val('w_richiesta'));
  const btn = el('btn2next');
  if (btn) btn.disabled = !ok;
  const box = el('examDayBox');
  if (!box) return;
  if (dp) {
    const d = new Date(dp + 'T00:00:00');
    box.style.display = 'inline-flex';
    el('examDayVal').textContent = (isNaN(d.getTime()) ? '' : DAYS[d.getDay()] + ' ') + fmtDate(dp);
  } else {
    box.style.display = 'none';
  }
}

function setOnco(v) {
  wOnco = v;
  toggleClass('tog_onco_si', 'toggle-item', v === 'si' ? ' active-yes' : '');
  toggleClass('tog_onco_sospetto', 'toggle-item', v === 'sospetto' ? ' active-inc' : '');
  toggleClass('pill_onco_si', 'toggle-pill', v === 'si' ? ' on-onco' : '');
  toggleClass('pill_onco_sospetto', 'toggle-pill', v === 'sospetto' ? ' on-amber' : '');
  const sec = el('oncoSection');
  if (sec) sec.style.display = (v === 'si' || v === 'sospetto') ? 'block' : 'none';
  if (!v) { setClassTumore(null); setMetastasi(null); }
}

function setClassTumore(v) {
  wPrimo = (v === 'primo');
  toggleClass('tog_primo', 'toggle-item', wPrimo ? ' active-yes' : '');
  toggleClass('pill_primo', 'toggle-pill', wPrimo ? ' on-onco' : '');
  const sec = el('sottoCategSection');
  if (sec) sec.style.display = wPrimo ? 'block' : 'none';
  if (!wPrimo) setSottocat(null);
}

function setSottocat(v) {
  wSottocat = v;
  ['unica', 'associata'].forEach((k) => {
    toggleClass('tog_' + k, 'toggle-item', v === k ? ' active-yes' : '');
    toggleClass('pill_' + k, 'toggle-pill', v === k ? ' on-onco' : '');
  });
  const paf = el('patAssocField');
  if (paf) paf.style.display = (v === 'associata') ? 'block' : 'none';
}

function setMetastasi(v) {
  wMetastasi = v;
  toggleClass('tog_meta_si', 'toggle-item', v === 'si' ? ' active-yes' : '');
  toggleClass('tog_meta_no', 'toggle-item', v === 'no' ? ' active-no' : '');
  toggleClass('pill_meta_si', 'toggle-pill', v === 'si' ? ' on' : '');
  toggleClass('pill_meta_no', 'toggle-pill', v === 'no' ? ' on-green' : '');
  const ms = el('metaSection');
  if (ms) ms.style.display = (v === 'si') ? 'block' : 'none';
}

function toggleClass(id, base, extra) {
  const e = el(id);
  if (e) e.className = base + extra;
}

function goStep(n) {
  if (n > currentStep) {
    if (n >= 2 && !validateStep1()) return;
    if (n >= 3 && !validateStep2()) return;
  }
  if (n === 4) buildReview();
  document.querySelectorAll('.wstep').forEach((e) => e.classList.remove('active'));
  const target = el('ws-' + n);
  if (target) target.classList.add('active');
  currentStep = n;
  buildProgress();
  popSections('wizard');
}

function validateStep1() {
  if (!val('w_cognome') || !val('w_nome') || !val('w_dob')) {
    notify('Compilare cognome, nome e data di nascita.');
    return false;
  }
  return true;
}

function validateStep2() {
  if (!val('w_data') || !val('w_tipo_esame') || !val('w_richiesta')) {
    notify('Compilare data esame, tipo di esame e richiesta del PS.');
    return false;
  }
  return true;
}

function renderFUList() {
  const wrap = el('fuList');
  if (!wrap) return;
  if (!fuItems.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = fuItems.map((f, i) =>
    '<div class="fu-item">' +
      '<div class="fu-num">' + (i + 1) + '</div>' +
      '<div class="fu-item-body">' +
        '<div class="fu-date">' + esc(fmtDate(f.date)) + (f.type ? ' — ' + esc(f.type) : '') + '</div>' +
        '<div class="fu-text">' + esc(f.text || '—') + '</div>' +
      '</div>' +
      '<button type="button" class="fu-del" data-act="del-fu" data-idx="' + i + '">×</button>' +
    '</div>'
  ).join('');
}

function addFU() {
  const date = dateStr(val('fuDate'));
  const text = val('fuText');
  const type = val('fuType');
  if (!date && !text) { notify('Inserire almeno data o referto.'); return; }
  fuItems.push({ date: date, type: str(type, 200), text: str(text) });
  ['fuDate', 'fuText', 'fuType'].forEach((id) => setFieldValue(el(id), ''));
  renderFUList();
}

function removeFU(i) {
  if (i >= 0 && i < fuItems.length) fuItems.splice(i, 1);
  renderFUList();
}

function buildReview() {
  const nome = val('w_nome');
  const cognome = val('w_cognome');
  const sesso = val('w_sesso_override') || detectSesso(nome, cognome);
  const dob = val('w_dob');
  const age = calcAge(dob);

  el('rv_paz').textContent = (cognome + ' ' + nome).trim() || '—';
  el('rv_sesso').innerHTML = sesso === 'M'
    ? '<span class="badge badge-m">M — Maschio</span>'
    : sesso === 'F'
      ? '<span class="badge badge-f">F — Femmina</span>'
      : '<span class="badge badge-u">N.D.</span>';
  el('rv_eta').textContent = fmtDate(dob) + (age !== null ? ' (' + age + ' anni)' : '');
  el('rv_prima').innerHTML = primaLabel(val('w_prima_onco'));
  el('rv_data').textContent = fmtDate(val('w_data'));
  el('rv_tipo').textContent = val('w_tipo_esame') || '—';
  el('rv_rich').textContent = val('w_richiesta') || '—';
  el('rv_onco').innerHTML = oncoLabel(wOnco);
  el('rv_sede').textContent = [val('w_sede'), val('w_dim')].filter(Boolean).join(' / ') || '—';

  let classTxt = '—';
  if (wPrimo) {
    classTxt = 'Primo riscontro';
    if (wSottocat === 'unica') classTxt += ' — unica patologia';
    else if (wSottocat === 'associata') classTxt += ' — con patologie associate';
  }
  el('rv_classtumore').textContent = classTxt;

  let metaTxt = '—';
  if (wMetastasi === 'si') {
    metaTxt = 'Sì';
    if (val('w_meta_sede')) metaTxt += ' — sede: ' + val('w_meta_sede');
    if (val('w_meta_primitivo')) metaTxt += ' (primitivo: ' + val('w_meta_primitivo') + ')';
  } else if (wMetastasi === 'no') {
    metaTxt = 'No — tumore primitivo';
  }
  el('rv_meta').textContent = metaTxt;
}

function saveWizard() {
  if (!validateStep1() || !validateStep2()) return;
  const nome = val('w_nome');
  const cognome = val('w_cognome');
  const existing = editingId ? DB.find((r) => r.id === editingId) : null;

  const rec = normalizeRecord({
    id: editingId || uid(),
    cognome: cognome,
    nome: nome,
    sesso: val('w_sesso_override') || detectSesso(nome, cognome),
    dob: val('w_dob'),
    prima_onco: val('w_prima_onco'),
    data: val('w_data'),
    tipo_esame: val('w_tipo_esame'),
    richiesta: val('w_richiesta'),
    onco: wOnco || '',
    diagnosi: val('w_diagnosi'),
    sede: val('w_sede'),
    dim: val('w_dim'),
    primo_riscontro: wPrimo,
    sottocat: wSottocat,
    pat_assoc: val('w_pat_assoc'),
    metastasi: wMetastasi,
    meta_sede: val('w_meta_sede'),
    meta_primitivo: val('w_meta_primitivo'),
    anat: val('w_anat'),
    note: val('w_note'),
    followup: fuItems,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  });

  const idx = DB.findIndex((r) => r.id === rec.id);
  if (idx >= 0) DB[idx] = rec; else DB.push(rec);

  const wasEditing = !!editingId;
  editingId = null;
  scheduleSave();
  refreshViews();   // riscontro immediato, senza attendere l'esito del salvataggio
  resetWizard();
  notify(wasEditing ? 'Esame aggiornato.' : 'Esame salvato.');
}

function resetWizard() {
  ['w_cognome', 'w_nome', 'w_dob', 'w_data', 'w_tipo_esame', 'w_richiesta',
    'w_diagnosi', 'w_sede', 'w_dim', 'w_anat', 'w_note',
    'w_pat_assoc', 'w_meta_sede', 'w_meta_primitivo',
    'w_sesso_override', 'w_prima_onco'].forEach((id) => {
    setFieldValue(el(id), '');
  });
  ['sessoDetected', 'ageBox', 'examDayBox'].forEach((id) => {
    const e = el(id);
    if (e) e.style.display = 'none';
  });
  editingId = null;
  setOnco(null);
  fuItems = [];
  renderFUList();
  liveValidate1();
  liveValidate2();
  goStep(1);
}

function loadIntoWizard(id) {
  const r = DB.find((p) => p.id === id);
  if (!r) return;
  editingId = id;
  const map = {
    w_cognome: r.cognome, w_nome: r.nome, w_sesso_override: r.sesso,
    w_dob: r.dob, w_prima_onco: r.prima_onco, w_data: r.data,
    w_tipo_esame: r.tipo_esame, w_richiesta: r.richiesta, w_diagnosi: r.diagnosi,
    w_sede: r.sede, w_dim: r.dim, w_anat: r.anat, w_note: r.note,
    w_pat_assoc: r.pat_assoc, w_meta_sede: r.meta_sede, w_meta_primitivo: r.meta_primitivo
  };
  Object.keys(map).forEach((k) => setFieldValue(el(k), map[k] || ''));

  fuItems = r.followup.map((f) => ({ date: f.date, type: f.type, text: f.text }));
  renderFUList();
  setOnco(r.onco || null);
  setClassTumore(r.primo_riscontro ? 'primo' : null);
  setSottocat(r.sottocat || null);
  setMetastasi(r.metastasi || null);
  onNomeInput();
  updateAge();
  liveValidate2();

  showView('wizard');
  goStep(1);
  notify('Esame caricato per la modifica.');
}

// ══════════════════════════════════════════════════════════════════
//  SUGGERIMENTI (datalist + pulsanti rapidi)
// ══════════════════════════════════════════════════════════════════
function uniqueValues(key) {
  const set = new Set();
  DB.forEach((r) => { if (r[key]) set.add(r[key]); });
  return Array.from(set).sort();
}

function optionsHtml(list, selectedValue) {
  return list.map((v) =>
    '<option value="' + esc(v) + '"' + (v === selectedValue ? ' selected' : '') + '>' + esc(v) + '</option>'
  ).join('');
}

function updateSuggests() {
  const tipi = uniqueValues('tipo_esame');
  const sedi = uniqueValues('sede');
  const metaSedi = uniqueValues('meta_sede');

  setHtml('tipoEsameList', tipi.map((t) => '<option value="' + esc(t) + '"></option>').join(''));
  setHtml('sedeList', sedi.map((s) => '<option value="' + esc(s) + '"></option>').join(''));
  setHtml('metaSedeList', metaSedi.map((s) => '<option value="' + esc(s) + '"></option>').join(''));

  setHtml('sediRapide', sedi.map((s) =>
    '<button type="button" class="sede-btn" data-act="pick" data-target="w_sede" data-value="' +
    esc(s) + '">' + esc(s) + '</button>').join(''));
  setHtml('metaSediRapide', metaSedi.map((s) =>
    '<button type="button" class="sede-btn sede-btn-meta" data-act="pick" data-target="w_meta_sede" data-value="' +
    esc(s) + '">' + esc(s) + '</button>').join(''));

  const fTipo = el('fTipo');
  if (fTipo) fTipo.innerHTML = '<option value="">Tutti</option>' + optionsHtml(tipi, fTipo.value);
  const sfTipo = el('sfTipo');
  if (sfTipo) sfTipo.innerHTML = '<option value="">Tutti i tipi</option>' + optionsHtml(tipi, sfTipo.value);
}

function setHtml(id, html) {
  const e = el(id);
  if (e) e.innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════
//  ARCHIVIO
// ══════════════════════════════════════════════════════════════════
function updateStatsBar() {
  const counts = {
    sTot: DB.length,
    sOnco: DB.filter((r) => r.onco === 'si').length,
    sSosp: DB.filter((r) => r.onco === 'sospetto').length,
    sPrimo: DB.filter((r) => r.primo_riscontro).length,
    sPrima: DB.filter((r) => r.onco === 'si' && r.prima_onco === 'si').length,
    sMeta: DB.filter((r) => r.metastasi === 'si').length,
    sM: DB.filter((r) => r.sesso === 'M').length
  };
  Object.keys(counts).forEach((id) => {
    const e = el(id);
    if (e) e.textContent = String(counts[id]);
  });
}

function applyFilters() {
  const fo = val('fOnco');
  const fp = val('fPrima');
  const ft = val('fTipo');
  const fct = val('fClassTumore');
  const fm = val('fMeta');
  const q = rawVal('fSearch').toLowerCase().trim();

  filtered = DB.filter((r) => {
    if (fo && r.onco !== fo) return false;
    if (fp && r.prima_onco !== fp) return false;
    if (ft && r.tipo_esame !== ft) return false;
    if (fct === 'primo' && !r.primo_riscontro) return false;
    if (fct === 'unica' && r.sottocat !== 'unica') return false;
    if (fct === 'associata' && r.sottocat !== 'associata') return false;
    if (fm && r.metastasi !== fm) return false;
    if (q && (r.cognome + ' ' + r.nome).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let av, bv;
    if (sortKey === 'eta') {
      av = a.eta == null ? -1 : a.eta;
      bv = b.eta == null ? -1 : b.eta;
    } else if (sortKey === 'primo_riscontro') {
      av = a.primo_riscontro ? 1 : 0;
      bv = b.primo_riscontro ? 1 : 0;
    } else {
      av = String(a[sortKey] == null ? '' : a[sortKey]);
      bv = String(b[sortKey] == null ? '' : b[sortKey]);
    }
    if (av < bv) return -sortDir;
    if (av > bv) return sortDir;
    return 0;
  });

  // Le selezioni che non esistono più vanno scartate.
  const live = new Set(DB.map((r) => r.id));
  Array.from(selected).forEach((id) => { if (!live.has(id)) selected.delete(id); });

  renderTable();
  updateStatsBar();
}

function resetFilters() {
  ['fOnco', 'fPrima', 'fTipo', 'fClassTumore', 'fMeta', 'fSearch'].forEach((id) => {
    const e = el(id);
    if (e) e.value = '';
  });
  applyFilters();
}

function sortBy(k) {
  if (!k) return;
  if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
  document.querySelectorAll('thead th span.sort-arrow').forEach((e) => { e.textContent = ''; });
  const arrow = el('sa-' + k);
  if (arrow) arrow.textContent = sortDir === 1 ? '▲' : '▼';
  applyFilters();
}

function renderTable() {
  const tbody = el('tblBody');
  if (!tbody) return;
  const count = el('tblCount');
  if (count) count.textContent = filtered.length + ' esam' + (filtered.length === 1 ? 'e' : 'i');

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="12"><div class="empty"><p>' +
      (DB.length ? 'Nessun esame corrisponde ai filtri.' : 'Nessun esame. Usa "Nuovo esame" per iniziare.') +
      '</p></div></td></tr>';
    updateDelButton();
    return;
  }

  tbody.innerHTML = filtered.map((r) => {
    const age = r.eta;
    const fuC = r.followup.length;
    const rowCls = r.onco === 'si' ? 'row-onco' : r.onco === 'sospetto' ? 'row-sospetto' : '';
    const anatFull = r.anat || '';
    const anatTxt = anatFull.length > 50 ? anatFull.slice(0, 50) + '…' : anatFull;
    const id = esc(r.id);
    return '<tr class="' + rowCls + '">' +
      '<td><input type="checkbox" class="rchk" data-id="' + id + '"' +
        (selected.has(r.id) ? ' checked' : '') + '></td>' +
      '<td><strong>' + esc(r.cognome) + '</strong> ' + esc(r.nome) +
        (age == null ? '' : ' <span class="age-hint">' + age + '</span>') + '</td>' +
      '<td><span class="badge badge-' + esc((r.sesso || 'u').toLowerCase()) + '">' + esc(r.sesso || 'N.D.') + '</span></td>' +
      '<td class="mono">' + esc(fmtDate(r.data)) + '</td>' +
      '<td class="cell-sm">' + esc(r.tipo_esame || '—') + '</td>' +
      '<td>' + primaLabel(r.prima_onco) + '</td>' +
      '<td>' + oncoLabel(r.onco) + '</td>' +
      '<td>' + classTumoreLabel(r) + '</td>' +
      '<td>' + metaLabel(r) + '</td>' +
      '<td class="cell-sm">' + esc(r.sede || '—') + '</td>' +
      '<td class="cell-anat" title="' + esc(anatFull) + '">' + esc(anatTxt || '—') +
        (fuC ? ' <span class="badge badge-fu">' + fuC + 'FU</span>' : '') + '</td>' +
      '<td class="cell-actions">' +
        '<button type="button" class="btn btn-sm btn-amber" data-act="addfu" data-id="' + id + '">+FU</button>' +
        '<button type="button" class="btn btn-sm btn-outline" data-act="detail" data-id="' + id + '">Vedi</button>' +
      '</td></tr>';
  }).join('');

  const chkAll = el('chkAll');
  if (chkAll) chkAll.checked = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  updateDelButton();
}

function updateDelButton() {
  const b = el('delSelBtn');
  if (b) b.style.display = selected.size ? '' : 'none';
}

function toggleAll(checked) {
  filtered.forEach((r) => { if (checked) selected.add(r.id); else selected.delete(r.id); });
  document.querySelectorAll('.rchk').forEach((c) => { c.checked = checked; });
  updateDelButton();
}

function toggleRow(chk) {
  const id = chk.getAttribute('data-id');
  if (!id) return;
  if (chk.checked) selected.add(id); else selected.delete(id);
  updateDelButton();
}

function markDeleted(ids) {
  const now = Date.now();
  ids.forEach((id) => { deletedIds[id] = now; });
  DB = DB.filter((r) => ids.indexOf(r.id) === -1);
}

function deleteSelected() {
  if (!selected.size) return;
  const n = selected.size;
  if (!confirm('Eliminare ' + n + ' esam' + (n === 1 ? 'e' : 'i') + '?')) return;
  markDeleted(Array.from(selected));
  selected.clear();
  scheduleSave();
  refreshViews();
  notify(n === 1 ? 'Esame eliminato.' : n + ' esami eliminati.');
}

function detRow(key, valueHtml) {
  return '<div class="det-row"><span class="det-key">' + esc(key) +
    '</span><span class="det-val">' + valueHtml + '</span></div>';
}

function openDetail(id) {
  const r = DB.find((p) => p.id === id);
  if (!r) return;
  detailId = id;
  const age = r.eta;

  const fuHTML = r.followup.length
    ? '<div class="fu-timeline">' + r.followup.map((f, i) =>
        '<div class="fu-tl-item"><div class="fu-tl-date">FU ' + (i + 1) + ' — ' +
        esc(fmtDate(f.date)) + (f.type ? ' — ' + esc(f.type) : '') + '</div>' +
        '<div class="fu-tl-text">' + esc(f.text || '—') + '</div></div>').join('') + '</div>'
    : '<span class="muted-note">Nessun follow-up</span>';

  el('detTitle').textContent = (r.cognome + ' ' + r.nome).trim() || 'Dettaglio esame';

  let html =
    '<div class="det-section"><h4>Anagrafica</h4>' +
      detRow('Sesso', '<span class="badge badge-' + esc((r.sesso || 'u').toLowerCase()) + '">' +
        esc(r.sesso || 'N.D.') + '</span>') +
      detRow('Data nascita / Età', esc(fmtDate(r.dob)) + (age !== null ? ' (' + age + ' anni)' : '')) +
      detRow('Prima diagnosi onco.', primaLabel(r.prima_onco)) +
    '</div>' +
    '<div class="det-section"><h4>Esame PS</h4>' +
      detRow('Data', esc(fmtDate(r.data))) +
      detRow('Tipo esame', esc(r.tipo_esame || '—')) +
      detRow('Richiesta PS', esc(r.richiesta || '—')) +
    '</div>' +
    '<div class="det-section"><h4>Diagnosi oncologica</h4>' +
      detRow('Esito', oncoLabel(r.onco));

  if (r.onco === 'si' || r.onco === 'sospetto') {
    html += detRow('Descrizione', esc(r.diagnosi || '—')) +
      detRow('Sede / Dimensioni', esc([r.sede, r.dim].filter(Boolean).join(' / ') || '—')) +
      detRow('Classificazione', classTumoreLabel(r));
    if (r.sottocat === 'associata' && r.pat_assoc) {
      html += detRow('Patologie associate', esc(r.pat_assoc));
    }
    html += detRow('Metastasi', metaLabel(r));
    if (r.metastasi === 'si') {
      html += detRow('Primitivo noto', esc(r.meta_primitivo || '—'));
    }
  }

  html += '</div>' +
    '<div class="det-section"><h4>Anatomia patologica</h4>' +
      '<p class="det-para">' + esc(r.anat || '—') + '</p>' +
      '<div class="det-sublabel">Follow-up</div>' + fuHTML +
    '</div>';

  if (r.note) {
    html += '<div class="det-section"><h4>Note</h4><p class="det-para">' + esc(r.note) + '</p></div>';
  }

  el('detBody').innerHTML = html;
  el('modDetail').classList.add('open');
}

function deleteDetail() {
  if (!detailId) return;
  if (!confirm('Eliminare definitivamente questo esame?')) return;
  markDeleted([detailId]);
  selected.delete(detailId);
  detailId = null;
  scheduleSave();
  refreshViews();
  closeOverlay('modDetail');
  notify('Esame eliminato.');
}

function openAddFU(id) {
  fuTargetId = id;
  ['mfuDate', 'mfuText', 'mfuType'].forEach((k) => setFieldValue(el(k), ''));
  el('modFU').classList.add('open');
}

function saveFU() {
  const date = dateStr(val('mfuDate'));
  const text = val('mfuText');
  const type = val('mfuType');
  if (!date || !text) { notify('Inserire data e referto.'); return; }
  const r = DB.find((p) => p.id === fuTargetId);
  if (!r) { notify('Esame non più disponibile.'); closeOverlay('modFU'); return; }
  r.followup.push({ date: date, type: str(type, 200), text: str(text) });
  r.updatedAt = Date.now();
  scheduleSave();
  refreshViews();
  closeOverlay('modFU');
  notify('Follow-up aggiunto.');
}

// ══════════════════════════════════════════════════════════════════
//  EXPORT
// ══════════════════════════════════════════════════════════════════
function exportSource() {
  return filtered.slice();
}

function siNo(v) {
  return v === 'si' ? 'Sì' : v === 'no' ? 'No' : v === 'sospetto' ? 'Sospetto' : v === 'ignoto' ? 'Non noto' : '—';
}

function classificazione(r) {
  if (!r.primo_riscontro) return '—';
  if (r.sottocat === 'unica') return 'Primo riscontro — unica patologia';
  if (r.sottocat === 'associata') return 'Primo riscontro — patologie associate';
  return 'Primo riscontro';
}

function followupText(r) {
  return r.followup
    .map((f, i) => 'FU' + (i + 1) + ' (' + fmtDate(f.date) + '): ' + f.text)
    .join(' | ');
}

function exportHeader(anonymous) {
  const head = anonymous ? [] : ['Cognome', 'Nome'];
  return head.concat([
    'Sesso', 'Data nascita', 'Età', 'Data esame', 'Tipo esame', 'Richiesta PS',
    'Prima diagnosi oncologica', 'Esito oncologico', 'Descrizione diagnosi',
    'Sede', 'Dimensioni', 'Classificazione tumore', 'Patologie associate',
    'Metastasi', 'Sede metastasi', 'Tumore primitivo', 'Anatomia patologica',
    'Follow-up AP', 'Note'
  ]);
}

function exportRow(r, anonymous) {
  const head = anonymous ? [] : [r.cognome, r.nome];
  return head.concat([
    r.sesso,
    anonymous ? '' : r.dob,
    r.eta == null ? '' : r.eta,
    r.data,
    r.tipo_esame,
    r.richiesta,
    siNo(r.prima_onco),
    siNo(r.onco),
    r.diagnosi,
    r.sede,
    r.dim,
    classificazione(r),
    r.pat_assoc,
    siNo(r.metastasi),
    r.meta_sede,
    r.meta_primitivo,
    r.anat,
    followupText(r),
    r.note
  ]);
}

function statsSheet(src) {
  const tot = src.length;
  const onco = src.filter((r) => r.onco === 'si').length;
  const sosp = src.filter((r) => r.onco === 'sospetto').length;
  const prima = src.filter((r) => r.onco === 'si' && r.prima_onco === 'si').length;
  const primo = src.filter((r) => r.primo_riscontro).length;
  const meta = src.filter((r) => r.metastasi === 'si').length;
  return [
    ['STATISTICHE — PS Oncologia'],
    ['Generato il', new Date().toLocaleString('it-IT')],
    [],
    ['Esami esportati', tot],
    ['Diagnosi oncologiche', onco, pct(onco, tot, 1) + ' degli esami'],
    ['Sospetti', sosp, pct(sosp, tot, 1) + ' degli esami'],
    ['Primo riscontro', primo, pct(primo, onco, 1) + ' delle diagnosi onco.'],
    ['Prime diagnosi onco.', prima, pct(prima, tot, 1) + ' degli esami'],
    ['Metastasi', meta, pct(meta, onco + sosp, 1) + ' delle diagnosi onco.']
  ];
}

async function sendFile(name, base64) {
  if (!IS_ELECTRON) {
    notify('Export disponibile solo nell’applicazione desktop.');
    return false;
  }
  const saved = await API.saveExport(name, base64);
  return !!saved;
}

function utf8ToBase64(text) {
  const u8 = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function exportExcel(anonymous) {
  const src = exportSource();
  if (!src.length) { notify('Nessun esame nella selezione corrente.'); return; }
  try {
    const rows = [exportHeader(anonymous)].concat(src.map((r) => exportRow(r, anonymous)));
    const file = window.XlsxWriter.build([
      { name: anonymous ? 'Dati anonimi' : 'Archivio', rows: rows },
      { name: 'Statistiche', rows: statsSheet(src) }
    ]);
    const ok = await sendFile(
      anonymous ? 'ps_onco_anonimo.xlsx' : 'ps_onco_archivio.xlsx',
      window.XlsxWriter.toBase64(file)
    );
    if (ok) notify('Excel esportato (' + src.length + ' esami' + (anonymous ? ', anonimo' : '') + ').');
  } catch (e) {
    notify('Errore export Excel: ' + e.message);
  }
}

/** Neutralizza le celle che Excel interpreterebbe come formula. */
function csvCell(value) {
  let s = String(value == null ? '' : value);
  const c = s.charAt(0);
  if (c === '=' || c === '+' || c === '-' || c === '@' ||
      c === String.fromCharCode(9) || c === String.fromCharCode(13)) {
    s = "'" + s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

async function exportCSV(anonymous) {
  const src = exportSource();
  if (!src.length) { notify('Nessun esame nella selezione corrente.'); return; }
  try {
    const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    const lines = [exportHeader(anonymous).map(csvCell).join(';')];
    src.forEach((r) => { lines.push(exportRow(r, anonymous).map(csvCell).join(';')); });
    const BOM = String.fromCharCode(0xFEFF);
    const ok = await sendFile(
      anonymous ? 'ps_onco_anonimo.csv' : 'ps_onco_archivio.csv',
      utf8ToBase64(BOM + lines.join(CRLF) + CRLF)
    );
    if (ok) notify('CSV esportato (' + src.length + ' esami).');
  } catch (e) {
    notify('Errore export CSV: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
//  EXPORT POWERPOINT
//  I grafici sono SVG nel DOM: si rasterizzano su canvas e finiscono
//  nelle diapositive come PNG. Nessuna libreria esterna.
// ══════════════════════════════════════════════════════════════════

/** SVG del DOM → PNG. Il fondo bianco evita il trasparente, che in
 *  PowerPoint su tema scuro renderebbe illeggibili le etichette. */
function svgToPng(svgEl, fattore) {
  return new Promise((resolve, reject) => {
    if (!svgEl) return reject(new Error('grafico assente'));
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    let w = parseFloat(clone.getAttribute('width'));
    let h = parseFloat(clone.getAttribute('height'));
    const vb = clone.getAttribute('viewBox');
    if ((!w || !h) && vb) {
      const p = vb.split(/[\s,]+/);
      w = parseFloat(p[2]);
      h = parseFloat(p[3]);
    }
    if (!w || !h) {
      const r = svgEl.getBoundingClientRect();
      w = r.width; h = r.height;
    }
    if (!w || !h) return reject(new Error('grafico senza dimensioni'));
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);

    const testo = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.round(w * fattore);
        c.height = Math.round(h * fattore);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve({ dataUrl: c.toDataURL('image/png'), w: w, h: h });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('SVG non rasterizzabile'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(testo);
  });
}

function base64ToBytes(base64) {
  const binario = atob(base64);
  const out = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) out[i] = binario.charCodeAt(i);
  return out;
}

/** Riquadro centrato dentro l'area utile della diapositiva. */
function riquadroImmagine(w, h, x, larghezzaMax, altezzaMax, y) {
  const scala = Math.min(larghezzaMax / w, altezzaMax / h);
  const larg = w * scala;
  const alt = h * scala;
  return { x: x + (larghezzaMax - larg) / 2, y: y + (altezzaMax - alt) / 2, w: larg, h: alt };
}

async function exportPPTX() {
  const set = getStatsSubset();
  if (!set.length) { notify('Nessun esame nel periodo selezionato.'); return; }
  if (!IS_ELECTRON) { notify('Export disponibile solo nell’applicazione desktop.'); return; }

  try {
    const P = window.PptxWriter;
    const tot = set.length;
    const onco = set.filter((r) => r.onco === 'si').length;
    const sosp = set.filter((r) => r.onco === 'sospetto').length;
    const prima = set.filter((r) => r.onco === 'si' && r.prima_onco === 'si').length;
    const primo = set.filter((r) => r.primo_riscontro).length;
    const meta = set.filter((r) => r.metastasi === 'si').length;

    const dal = val('sfDal'), al = val('sfAl'), tipo = val('sfTipo');
    const periodo = (dal || al)
      ? 'Periodo ' + (dal ? fmtDate(dal) : 'inizio') + ' – ' + (al ? fmtDate(al) : 'oggi')
      : 'Archivio completo';

    // rasterizzazione dei grafici SVG presenti nella vista statistiche
    const grafici = {};
    const sorgenti = { donut: 'svgDonut', sede: 'svgBarseSede', mensile: 'svgMensile' };
    const chiavi = Object.keys(sorgenti);
    for (let i = 0; i < chiavi.length; i++) {
      const svg = document.querySelector('#' + sorgenti[chiavi[i]] + ' svg');
      if (!svg) continue;
      try { grafici[chiavi[i]] = await svgToPng(svg, 2.5); } catch (_) { /* si salta */ }
    }

    const MARG = 640000;
    const AREA_W = P.LARG - MARG * 2;
    const dia = [];

    dia.push({
      titolo: 'ER Oncology Archivist',
      sottotitolo: periodo + (tipo ? ' · ' + tipo : ''),
      righe: ['Pronto Soccorso Oncologico — Radiologia d’Urgenza',
              'Report generato il ' + new Date().toLocaleString('it-IT')]
    });

    dia.push({
      titolo: 'Sintesi del periodo',
      righe: [
        'Esami nel periodo: ' + tot,
        'Diagnosi oncologiche: ' + onco + '  (' + pct(onco, tot, 1) + ' degli esami)',
        'Sospetti: ' + sosp + '  (' + pct(sosp, tot, 1) + ' degli esami)',
        'Primo riscontro: ' + primo + '  (' + pct(primo, onco, 1) + ' delle diagnosi onco.)',
        'Prime diagnosi oncologiche: ' + prima + '  (' + pct(prima, tot, 1) + ' degli esami)',
        'Metastasi: ' + meta + '  (' + pct(meta, onco + sosp, 1) + ' delle diagnosi onco.)'
      ]
    });

    if (grafici.donut || grafici.sede) {
      const immagini = [];
      const metaLarg = (AREA_W - 400000) / 2;
      if (grafici.donut) {
        const r = riquadroImmagine(grafici.donut.w, grafici.donut.h,
          MARG, metaLarg, 3600000, 2200000);
        immagini.push({ png: base64ToBytes(grafici.donut.dataUrl.split(',')[1]),
                        x: r.x, y: r.y, w: r.w, h: r.h });
      }
      if (grafici.sede) {
        const r = riquadroImmagine(grafici.sede.w, grafici.sede.h,
          MARG + metaLarg + 400000, metaLarg, 3600000, 2200000);
        immagini.push({ png: base64ToBytes(grafici.sede.dataUrl.split(',')[1]),
                        x: r.x, y: r.y, w: r.w, h: r.h });
      }
      dia.push({ titolo: 'Distribuzione e sedi', sottotitolo: periodo, immagini: immagini });
    }

    if (grafici.mensile) {
      const r = riquadroImmagine(grafici.mensile.w, grafici.mensile.h,
        MARG, AREA_W, 3900000, 2100000);
      dia.push({
        titolo: 'Andamento mensile',
        sottotitolo: 'Esami totali, diagnosi oncologiche e percentuale',
        immagini: [{ png: base64ToBytes(grafici.mensile.dataUrl.split(',')[1]),
                     x: r.x, y: r.y, w: r.w, h: r.h }]
      });
    }

    // tabella per sede, le prime dieci
    const sediTot = {}, sediMeta = {}, sediPrima = {};
    set.filter((r) => (r.onco === 'si' || r.onco === 'sospetto') && r.sede).forEach((r) => {
      sediTot[r.sede] = (sediTot[r.sede] || 0) + 1;
      if (r.metastasi === 'si') sediMeta[r.sede] = (sediMeta[r.sede] || 0) + 1;
      if (r.prima_onco === 'si') sediPrima[r.sede] = (sediPrima[r.sede] || 0) + 1;
    });
    const righeSede = Object.keys(sediTot)
      .map((k) => [k, sediTot[k]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map((e) => [e[0], String(e[1]), String(sediPrima[e[0]] || 0),
                   String(sediMeta[e[0]] || 0), pct(e[1], onco + sosp, 1)]);

    if (righeSede.length) {
      dia.push({
        titolo: 'Prevalenza per sede',
        sottotitolo: 'Percentuale sul totale delle diagnosi oncologiche',
        tabella: {
          intestazioni: ['Sede', 'Casi', 'Prime diagnosi', 'Metastasi', '% su onco.'],
          righe: righeSede
        }
      });
    }

    const file = P.build(dia);
    const ok = await sendFile('ps_onco_presentazione.pptx', window.ZipWriter.toBase64(file));
    if (ok) notify('Presentazione esportata (' + dia.length + ' diapositive).');
  } catch (e) {
    notify('Errore export PowerPoint: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
//  REPORT PDF (printToPDF di Electron: nessuna libreria esterna)
// ══════════════════════════════════════════════════════════════════
function cloneChart(id) {
  const source = el(id);
  if (!source) return '';
  const clone = source.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  const box = document.createElement('div');
  box.appendChild(clone);
  return box.innerHTML;
}

function buildReport(set) {
  const tot = set.length;
  const onco = set.filter((r) => r.onco === 'si').length;
  const sosp = set.filter((r) => r.onco === 'sospetto').length;
  const prima = set.filter((r) => r.onco === 'si' && r.prima_onco === 'si').length;
  const primo = set.filter((r) => r.primo_riscontro).length;
  const meta = set.filter((r) => r.metastasi === 'si').length;
  const unica = set.filter((r) => r.sottocat === 'unica').length;
  const assoc = set.filter((r) => r.sottocat === 'associata').length;

  const dal = val('sfDal'), al = val('sfAl'), tipo = val('sfTipo');
  const periodo = (dal || al)
    ? 'Periodo ' + (dal ? fmtDate(dal) : 'inizio') + ' – ' + (al ? fmtDate(al) : 'oggi')
    : 'Archivio completo';

  const kpi = [
    ['Esami nel periodo', tot, ''],
    ['Diagnosi oncologiche', onco, pct(onco, tot, 1) + ' degli esami'],
    ['Sospetti', sosp, pct(sosp, tot, 1) + ' degli esami'],
    ['Primo riscontro', primo, pct(primo, onco, 1) + ' delle onco.'],
    ['Prime diagnosi', prima, pct(prima, tot, 1) + ' degli esami'],
    ['Metastasi', meta, pct(meta, onco + sosp, 1) + ' delle onco.']
  ];

  const intestazione = (titolo) =>
    '<div class="rep-page"><div class="rep-head"><h1>ER Oncology Archivist</h1>' +
    '<div class="rep-sub">' + esc(periodo) + (tipo ? ' · ' + esc(tipo) : '') +
    ' · ' + esc(titolo) + ' · ' + esc(new Date().toLocaleString('it-IT')) + '</div></div>';

  // Pagina 1 — sintesi e distribuzione
  let html = intestazione('Sintesi') +
    '<div class="rep-kpis">' + kpi.map((k) =>
      '<div class="rep-kpi"><div class="rep-kpi-n">' + esc(k[1]) + '</div>' +
      '<div class="rep-kpi-l">' + esc(k[0]) + '</div>' +
      '<div class="rep-kpi-p">' + esc(k[2]) + '</div></div>').join('') + '</div>' +
    '<div class="rep-due">' +
      '<div><h2>Distribuzione generale</h2><div class="rep-chart">' +
        cloneChart('svgDonut') + '</div></div>' +
      '<div><h2>Diagnosi per sede / organo</h2><div class="rep-chart">' +
        cloneChart('svgBarseSede') + '</div></div>' +
    '</div>' +
    '<div class="rep-nota">Primo riscontro — unica patologia: <strong>' + unica +
    '</strong> · con patologie associate: <strong>' + assoc + '</strong></div>' +
    '</div>';

  // Pagina 2 — andamento nel tempo
  html += intestazione('Andamento mensile') +
    '<h2>Esami e diagnosi oncologiche per mese</h2>' +
    '<div class="rep-chart rep-chart-largo">' + cloneChart('svgMensile') + '</div>' +
    '<h2>Heatmap per tipo di esame</h2>' +
    '<div class="rep-table">' + cloneChart('svgHeatmap') + '</div>' +
    '</div>';

  // Pagina 3 — tabelle di dettaglio
  html += intestazione('Dettaglio') +
    '<h2>Prevalenza per sede</h2><div class="rep-table">' +
    (el('tableSedeWrap') ? el('tableSedeWrap').innerHTML : '') + '</div>' +
    '<h2>Dettaglio mensile per tipo di esame</h2><div class="rep-table">' +
    tabellaMensileHtml() + '</div>' +
    '</div>';

  return html;
}

/** La tabella mensile vive dentro un pannello con intestazione propria:
 *  per il report serve solo la tabella. */
function tabellaMensileHtml() {
  const head = el('tableMensileHead');
  const body = el('tableMensileBody');
  if (!head || !body) return '';
  return '<table class="data-table"><thead><tr>' + head.innerHTML +
         '</tr></thead><tbody>' + body.innerHTML + '</tbody></table>';
}

async function exportPDF() {
  if (!IS_ELECTRON) { notify('Il PDF è disponibile solo nell’applicazione desktop.'); return; }
  const root = el('printRoot');
  if (!root) return;
  root.innerHTML = buildReport(getStatsSubset());
  document.body.classList.add('printing');
  try {
    const saved = await API.savePdf('ps_onco_report.pdf');
    if (saved) notify('Report PDF salvato.');
  } catch (e) {
    notify('Errore export PDF: ' + e.message);
  } finally {
    document.body.classList.remove('printing');
    root.innerHTML = '';
  }
}

// ══════════════════════════════════════════════════════════════════
//  GRAFICI SVG
// ══════════════════════════════════════════════════════════════════
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, children) {
  const e = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
  (children || []).forEach((c) => {
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

function chartEmpty(container, text) {
  container.textContent = '';
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = text;
  container.appendChild(d);
}

function drawDonut(containerId, segments, centerLabel) {
  const box = el(containerId);
  if (!box) return;
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) { chartEmpty(box, 'Nessun dato.'); return; }

  const W = 180, cx = 90, cy = 90, R = 70, ri = 44;
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + W, width: W, height: W, style: 'flex-shrink:0;' });
  let angle = -Math.PI / 2;

  segments.forEach((seg) => {
    if (!seg.value) return;
    const sweep = (seg.value / total) * 2 * Math.PI;
    const end = angle + sweep;
    const x1 = cx + R * Math.cos(angle), y1 = cy + R * Math.sin(angle);
    const x2 = cx + R * Math.cos(end), y2 = cy + R * Math.sin(end);
    const xi1 = cx + ri * Math.cos(angle), yi1 = cy + ri * Math.sin(angle);
    const xi2 = cx + ri * Math.cos(end), yi2 = cy + ri * Math.sin(end);
    const large = sweep > Math.PI ? 1 : 0;
    const d = 'M ' + x1 + ' ' + y1 + ' A ' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2 +
      ' L ' + xi2 + ' ' + yi2 + ' A ' + ri + ' ' + ri + ' 0 ' + large + ' 0 ' + xi1 + ' ' + yi1 + ' Z';
    const path = svgEl('path', { d: d, fill: seg.color, opacity: seg.opacity || 1 });
    path.appendChild(svgEl('title', {}, [seg.label + ': ' + seg.value +
      ' (' + Math.round(seg.value / total * 100) + '%)']));
    svg.appendChild(path);
    angle = end;
  });

  svg.appendChild(svgEl('text', {
    x: cx, y: cy - 6, 'text-anchor': 'middle', 'font-size': '22',
    'font-weight': '500', fill: '#18170F', 'font-family': 'IBM Plex Mono,monospace'
  }, [String(total)]));
  svg.appendChild(svgEl('text', {
    x: cx, y: cy + 12, 'text-anchor': 'middle', 'font-size': '10', fill: '#6B6A62'
  }, [centerLabel || 'totale']));

  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  segments.forEach((seg) => {
    if (!seg.value) return;
    const row = document.createElement('div');
    row.className = 'dl-row';
    const dot = document.createElement('div');
    dot.className = 'dl-dot';
    dot.style.background = seg.color;
    dot.style.opacity = String(seg.opacity || 1);
    const txt = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'dl-label';
    lbl.textContent = seg.label;
    const num_ = document.createElement('div');
    num_.className = 'dl-num';
    num_.textContent = seg.value + ' — ' + Math.round(seg.value / total * 100) + '%';
    num_.style.color = seg.color;
    txt.appendChild(lbl);
    txt.appendChild(num_);
    row.appendChild(dot);
    row.appendChild(txt);
    legend.appendChild(row);
  });

  box.textContent = '';
  box.appendChild(svg);
  box.appendChild(legend);
}

function drawHBars(containerId, items, opts) {
  const box = el(containerId);
  if (!box) return;
  if (!items.length) { chartEmpty(box, 'Nessuna diagnosi oncologica nel periodo.'); return; }

  const W = 500, ROW_H = 28, PAD_L = 130, PAD_R = 60, PAD_T = 8;
  const H = PAD_T * 2 + ROW_H * items.length;
  const maxVal = Math.max.apply(null, items.map((i) => i.value).concat([1]));
  const TW = W - PAD_L - PAD_R;
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', style: 'max-width:500px;' });

  [0.25, 0.5, 0.75, 1].forEach((f) => {
    const x = PAD_L + TW * f;
    svg.appendChild(svgEl('line', { x1: x, y1: PAD_T, x2: x, y2: H - PAD_T, stroke: '#E0DED7', 'stroke-width': 1 }));
  });

  items.forEach((item, i) => {
    const y = PAD_T + i * ROW_H;
    const bw = Math.round(item.value / maxVal * TW);
    const bw2 = item.value2 ? Math.round(item.value2 / maxVal * TW) : 0;
    svg.appendChild(svgEl('rect', { x: PAD_L, y: y + 5, width: bw, height: 16, rx: 3, fill: (opts && opts.color) || '#6B1A7A', opacity: 0.85 }));
    if (bw2 > 0) svg.appendChild(svgEl('rect', { x: PAD_L, y: y + 5, width: bw2, height: 16, rx: 3, fill: '#8B1A1A', opacity: 0.7 }));

    const short = item.label.length > 16 ? item.label.slice(0, 15) + '…' : item.label;
    const lbl = svgEl('text', { x: PAD_L - 6, y: y + 17, 'text-anchor': 'end', 'font-size': 11, fill: '#18170F' }, [short]);
    lbl.appendChild(svgEl('title', {}, [item.label]));
    svg.appendChild(lbl);
    svg.appendChild(svgEl('text', {
      x: PAD_L + TW + 6, y: y + 17, 'font-size': 11, fill: '#6B6A62',
      'font-family': 'IBM Plex Mono,monospace'
    }, [item.value + (item.pct ? ' (' + item.pct + ')' : '')]));
  });

  box.textContent = '';
  box.appendChild(svg);
}

function drawMensileChart(containerId, mesi, mesiTot, mesiOnco) {
  const box = el(containerId);
  if (!box) return;
  if (!mesi.length) { chartEmpty(box, 'Nessun dato nel periodo selezionato.'); return; }

  const BAR_W = 36, GAP = 10, PAD_L = 36, PAD_R = 20, PAD_T = 24, PAD_B = 48;
  const W = PAD_L + mesi.length * (BAR_W + GAP) + PAD_R;
  const CH = 160;
  const H = PAD_T + CH + PAD_B;
  const maxVal = Math.max.apply(null, mesi.map((m) => mesiTot[m] || 0).concat([1]));
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: Math.max(W, 400), height: H, style: 'display:block;' });

  [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    const y = PAD_T + CH * (1 - f);
    svg.appendChild(svgEl('line', { x1: PAD_L, y1: y, x2: W - PAD_R, y2: y, stroke: '#E0DED7', 'stroke-width': 1 }));
    if (f > 0) {
      svg.appendChild(svgEl('text', {
        x: PAD_L - 4, y: y + 4, 'text-anchor': 'end', 'font-size': 9, fill: '#A09E97'
      }, [String(Math.round(maxVal * f))]));
    }
  });

  const linePoints = [];
  mesi.forEach((m, i) => {
    const x = PAD_L + i * (BAR_W + GAP);
    const tot = mesiTot[m] || 0;
    const onco = mesiOnco[m] || 0;
    const hTot = Math.round(tot / maxVal * CH);
    const hOnco = Math.round(onco / maxVal * CH);

    svg.appendChild(svgEl('rect', { x: x, y: PAD_T + CH - hTot, width: BAR_W, height: hTot, rx: 3, fill: '#C8C6BE' }));
    if (hOnco > 0) {
      svg.appendChild(svgEl('rect', { x: x, y: PAD_T + CH - hOnco, width: BAR_W, height: hOnco, rx: 3, fill: '#6B1A7A', opacity: 0.85 }));
    }

    const pctVal = tot ? Math.round(onco / tot * 100) : 0;
    const hit = svgEl('rect', { x: x, y: PAD_T, width: BAR_W, height: CH, fill: 'transparent' });
    hit.appendChild(svgEl('title', {}, [fmtMese(m) + ': ' + tot + ' esami, ' + onco + ' oncologici (' + pctVal + '%)']));
    svg.appendChild(hit);

    svg.appendChild(svgEl('text', {
      x: x + BAR_W / 2, y: H - PAD_B + 14, 'text-anchor': 'middle', 'font-size': 9, fill: '#6B6A62',
      transform: 'rotate(-35, ' + (x + BAR_W / 2) + ', ' + (H - PAD_B + 14) + ')'
    }, [fmtMeseBreve(m)]));

    if (tot > 0) linePoints.push({ x: x + BAR_W / 2, y: PAD_T + CH * (1 - pctVal / 100), pct: pctVal });
  });

  if (linePoints.length > 1) {
    svg.appendChild(svgEl('polyline', {
      points: linePoints.map((p) => p.x + ',' + p.y).join(' '),
      fill: 'none', stroke: '#E8A020', 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));
  }
  linePoints.forEach((p) => {
    svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 4, fill: '#E8A020', stroke: '#fff', 'stroke-width': 1.5 }));
    svg.appendChild(svgEl('text', {
      x: p.x, y: p.y - 8, 'text-anchor': 'middle', 'font-size': 9, fill: '#E8A020',
      'font-weight': '500', 'font-family': 'IBM Plex Mono,monospace'
    }, [p.pct + '%']));
  });

  box.textContent = '';
  box.appendChild(svg);
}

function heatClass(tot, onco) {
  if (!tot) return 'hm-0';
  const p = onco / tot;
  if (p === 0) return 'hm-0';
  if (p < 0.1) return 'hm-1';
  if (p < 0.3) return 'hm-2';
  if (p < 0.5) return 'hm-3';
  return 'hm-4';
}

function drawHeatmap(containerId, mesi, tipi, set) {
  const box = el(containerId);
  if (!box) return;
  if (!mesi.length || !tipi.length) { chartEmpty(box, 'Nessun dato.'); return; }

  const matrix = {};
  set.forEach((r) => {
    if (!r.data || !r.tipo_esame) return;
    const m = r.data.slice(0, 7);
    if (!matrix[m]) matrix[m] = {};
    if (!matrix[m][r.tipo_esame]) matrix[m][r.tipo_esame] = { tot: 0, onco: 0 };
    matrix[m][r.tipo_esame].tot++;
    if (r.onco === 'si' || r.onco === 'sospetto') matrix[m][r.tipo_esame].onco++;
  });

  let html = '<table class="heatmap-table"><thead><tr><th class="hm-head hm-head-left">Mese</th>';
  tipi.forEach((t) => {
    html += '<th class="hm-head" title="' + esc(t) + '">' +
      esc(t.length > 14 ? t.slice(0, 13) + '…' : t) + '</th>';
  });
  html += '</tr></thead><tbody>';

  mesi.slice().reverse().forEach((m) => {
    html += '<tr><td class="hm-month">' + esc(fmtMeseBreve(m)) + '</td>';
    tipi.forEach((t) => {
      const cell = (matrix[m] || {})[t];
      if (!cell || !cell.tot) {
        html += '<td class="hm-0">—</td>';
      } else {
        const p = Math.round(cell.onco / cell.tot * 100);
        html += '<td class="' + heatClass(cell.tot, cell.onco) + '" title="' +
          cell.tot + ' esami, ' + cell.onco + ' oncologici (' + p + '%)">' +
          cell.tot + '<span class="hm-sub"> (' + cell.onco + ')</span></td>';
      }
    });
    html += '</tr>';
  });
  box.innerHTML = html + '</tbody></table>';
}

// ══════════════════════════════════════════════════════════════════
//  STATISTICHE
// ══════════════════════════════════════════════════════════════════
function resetStatsFilters() {
  ['sfDal', 'sfAl', 'sfTipo'].forEach((id) => setFieldValue(el(id), ''));
  const focus = el('sfFocus');
  if (focus) focus.value = 'all';
  renderStats();
}

function getStatsSubset() {
  const dal = val('sfDal');
  const al = val('sfAl');
  const tipo = val('sfTipo');
  const focus = val('sfFocus') || 'all';
  return DB.filter((r) => {
    if (dal && (!r.data || r.data < dal)) return false;
    if (al && (!r.data || r.data > al)) return false;
    if (tipo && r.tipo_esame !== tipo) return false;
    if (focus === 'onco' && r.onco !== 'si' && r.onco !== 'sospetto') return false;
    if (focus === 'prima' && !(r.onco === 'si' && r.prima_onco === 'si')) return false;
    if (focus === 'meta' && r.metastasi !== 'si') return false;
    if (focus === 'primo' && !r.primo_riscontro) return false;
    return true;
  });
}

function renderStats() {
  const cards = el('statsCards');
  if (!cards) return;

  const set = getStatsSubset();
  const tot = set.length;
  const onco = set.filter((r) => r.onco === 'si').length;
  const sospetti = set.filter((r) => r.onco === 'sospetto').length;
  const prima = set.filter((r) => r.onco === 'si' && r.prima_onco === 'si').length;
  const primo = set.filter((r) => r.primo_riscontro).length;
  const meta = set.filter((r) => r.metastasi === 'si').length;
  const unica = set.filter((r) => r.sottocat === 'unica').length;
  const assoc = set.filter((r) => r.sottocat === 'associata').length;

  cards.innerHTML =
    '<div class="stat-big"><div class="sb-num">' + tot + '</div>' +
      '<div class="sb-label">Esami nel periodo</div>' +
      '<div class="sb-sub">Base di calcolo per tutte le percentuali</div></div>' +
    '<div class="stat-big"><div class="sb-num sb-onco">' + onco + '</div>' +
      '<div class="sb-pct">' + pct(onco, tot, 1) + ' degli esami</div>' +
      '<div class="sb-label">Diagnosi oncologiche</div>' +
      '<div class="sb-sub">Prime diagnosi: <strong>' + prima + '</strong> (' + pct(prima, tot, 1) +
      ' tot. · ' + pct(prima, onco, 1) + ' onco.)<br>Sospetti: <strong>' + sospetti +
      '</strong> (' + pct(sospetti, tot, 1) + ' degli esami)</div></div>' +
    '<div class="stat-big"><div class="sb-num sb-onco">' + primo + '</div>' +
      '<div class="sb-pct">' + pct(primo, onco, 1) + ' delle diagnosi onco.</div>' +
      '<div class="sb-label">Primo riscontro</div>' +
      '<div class="sb-sub">Unica patologia: <strong>' + unica + '</strong> · Con comorbidità: <strong>' +
      assoc + '</strong></div></div>' +
    '<div class="stat-big"><div class="sb-num sb-red">' + meta + '</div>' +
      '<div class="sb-pct">' + pct(meta, onco, 1) + ' delle diagnosi onco.</div>' +
      '<div class="sb-label">Metastasi</div>' +
      '<div class="sb-sub">Primitive: <strong>' + Math.max(0, onco - meta) + '</strong> (' +
      pct(Math.max(0, onco - meta), onco, 1) + ' delle onco.)</div></div>';

  const mesiTot = {}, mesiOnco = {};
  set.forEach((r) => {
    if (!r.data) return;
    const m = r.data.slice(0, 7);
    mesiTot[m] = (mesiTot[m] || 0) + 1;
    if (r.onco === 'si' || r.onco === 'sospetto') mesiOnco[m] = (mesiOnco[m] || 0) + 1;
  });
  const mesiSorted = Object.keys(mesiTot).sort().slice(-24);

  drawDonut('svgDonut', [
    { label: 'Esami negativi', value: Math.max(0, tot - onco - sospetti), color: '#C8C6BE' },
    { label: 'Diagnosi oncologiche', value: onco, color: '#6B1A7A', opacity: 0.85 },
    { label: 'Sospetti', value: sospetti, color: '#E8A020' },
    { label: 'Primo riscontro', value: primo, color: '#C2185B' },
    { label: 'Metastasi', value: meta, color: '#8B1A1A', opacity: 0.7 }
  ].filter((s) => s.value > 0), 'esami');

  const sediTot = {}, sediMeta = {}, sediPrima = {};
  set.filter((r) => (r.onco === 'si' || r.onco === 'sospetto') && r.sede).forEach((r) => {
    sediTot[r.sede] = (sediTot[r.sede] || 0) + 1;
    if (r.metastasi === 'si') sediMeta[r.sede] = (sediMeta[r.sede] || 0) + 1;
    if (r.prima_onco === 'si') sediPrima[r.sede] = (sediPrima[r.sede] || 0) + 1;
  });
  const sediSorted = Object.keys(sediTot)
    .map((k) => [k, sediTot[k]])
    .sort((a, b) => b[1] - a[1]);

  drawHBars('svgBarseSede', sediSorted.slice(0, 10).map((entry) => ({
    label: entry[0],
    value: entry[1],
    value2: sediMeta[entry[0]] || 0,
    pct: pct(entry[1], onco + sospetti, 1)
  })), { color: '#6B1A7A' });

  drawMensileChart('svgMensile', mesiSorted, mesiTot, mesiOnco);

  const tipi = Array.from(new Set(set.filter((r) => r.tipo_esame).map((r) => r.tipo_esame))).sort();
  drawHeatmap('svgHeatmap', mesiSorted, tipi, set);
  renderTableMensile(mesiSorted, tipi, set, mesiTot, mesiOnco);
  renderTableSede(sediSorted, sediPrima, sediMeta, onco, sospetti, prima, meta);
}

function renderTableMensile(mesi, tipi, set, mesiTot, mesiOnco) {
  const head = el('tableMensileHead');
  const body = el('tableMensileBody');
  if (!head || !body) return;

  if (!mesi.length || !tipi.length) {
    head.innerHTML = '';
    body.innerHTML = '<tr><td colspan="4" class="tbl-empty">Nessun dato.</td></tr>';
    return;
  }

  head.innerHTML = '<th class="st-head st-head-left">Mese</th>' +
    tipi.map((t) => '<th class="st-head" title="' + esc(t) + '">' +
      esc(t.length > 16 ? t.slice(0, 15) + '…' : t) + '</th>').join('') +
    '<th class="st-head">Totale</th><th class="st-head">Onco.</th><th class="st-head">%</th>';

  body.innerHTML = mesi.slice().reverse().map((m) => {
    const rigaTot = {}, rigaOnco = {};
    set.forEach((r) => {
      if (!r.data || r.data.slice(0, 7) !== m) return;
      const t = r.tipo_esame || 'N.D.';
      rigaTot[t] = (rigaTot[t] || 0) + 1;
      if (r.onco === 'si' || r.onco === 'sospetto') rigaOnco[t] = (rigaOnco[t] || 0) + 1;
    });
    const totM = mesiTot[m] || 0;
    const oncoM = mesiOnco[m] || 0;
    const ratio = totM ? oncoM / totM : 0;
    const cls = ratio >= 0.3 ? 'v-red' : ratio >= 0.1 ? 'v-amber' : 'v-onco';
    return '<tr><td class="st-month">' + esc(fmtMese(m)) + '</td>' +
      tipi.map((t) => {
        const tv = rigaTot[t] || 0, ov = rigaOnco[t] || 0;
        if (!tv) return '<td class="st-cell st-faint">—</td>';
        return '<td class="st-cell" title="' + tv + ' esami, ' + ov + ' oncologici">' + tv +
          '<span class="st-onco"> (' + ov + ')</span></td>';
      }).join('') +
      '<td class="st-cell st-strong">' + totM + '</td>' +
      '<td class="st-cell v-onco">' + oncoM + '</td>' +
      '<td class="st-cell ' + cls + '">' + pct(oncoM, totM, 1) + '</td></tr>';
  }).join('');
}

function renderTableSede(sediSorted, sediPrima, sediMeta, onco, sospetti, prima, meta) {
  const body = el('tableSedeBody');
  if (!body) return;
  if (!sediSorted.length) {
    body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Nessuna diagnosi oncologica nel periodo.</td></tr>';
    return;
  }
  const max = sediSorted[0][1] || 1;
  body.innerHTML = sediSorted.map((entry) => {
    const sede = entry[0], casi = entry[1];
    const ps = sediPrima[sede] || 0;
    const ms = sediMeta[sede] || 0;
    const barW = Math.round(casi / max * 100);
    return '<tr><td class="sd-name">' + esc(sede) + '</td>' +
      '<td class="sd-c">' + casi + '</td>' +
      '<td class="sd-c v-onco">' + ps + (ps ? ' <span class="sd-pct">(' + pct(ps, casi, 0) + ')</span>' : '') + '</td>' +
      '<td class="sd-c v-red">' + ms + (ms ? ' <span class="sd-pct">(' + pct(ms, casi, 0) + ')</span>' : '') + '</td>' +
      '<td class="sd-bar-cell"><div class="sd-bar-wrap"><div class="sd-bar-track">' +
      '<div class="sd-bar" style="width:' + barW + '%"></div></div>' +
      '<span class="sd-bar-val">' + pct(casi, onco + sospetti, 1) + '</span></div></td></tr>';
  }).join('') +
    '<tr class="sd-total"><td class="sd-name">TOTALE</td>' +
    '<td class="sd-c">' + (onco + sospetti) + '</td>' +
    '<td class="sd-c v-onco">' + prima + '</td>' +
    '<td class="sd-c v-red">' + meta + '</td>' +
    '<td class="sd-bar-cell">100%</td></tr>';
}

// ══════════════════════════════════════════════════════════════════
//  DOCK — magnificazione per prossimità, dal Dock di Magic UI
//  Costanti loro: size 40 → magnification 60 su distanza 140,
//  molla mass .1 / stiffness 150 / damping 12.
// ══════════════════════════════════════════════════════════════════
const DOCK_DISTANCE = 140;
const DOCK_SCALE_MAX = 1.09;   // 40→60px sono 1.5x: su pillole di testo è troppo
const DOCK_LIFT = 2;           // px di sollevamento a piena magnificazione
const DOCK_SPRING = { massa: 0.1, rigidita: 150, smorzamento: 12 };

let dockItems = [];
let dockMouseX = Infinity;
let dockRaf = null;
let dockLastTs = 0;

function setupDock() {
  const dock = el('navDock');
  if (!dock) return;
  dockItems = Array.prototype.slice.call(dock.querySelectorAll('.dock-item'))
    .map((e) => ({ e: e, valore: 1, velocita: 0 }));

  dock.addEventListener('pointermove', (ev) => {
    if (PREFS.reduceMotion) return;
    dockMouseX = ev.clientX;
    startDockLoop();
  });
  dock.addEventListener('pointerleave', () => {
    dockMouseX = Infinity;
    startDockLoop();
  });
}

function startDockLoop() {
  if (dockRaf !== null) return;
  dockLastTs = 0;
  dockRaf = requestAnimationFrame(dockTick);
}

function dockTick(ts) {
  const dt = dockLastTs ? Math.min((ts - dockLastTs) / 1000, 0.032) : 0.016;
  dockLastTs = ts;

  let inMovimento = false;
  dockItems.forEach((it) => {
    const r = it.e.getBoundingClientRect();
    const centro = r.left + r.width / 2;
    const d = Math.abs(dockMouseX - centro);
    // interpolazione lineare come il loro useTransform([-dist,0,dist])
    const t = d >= DOCK_DISTANCE || !isFinite(d) ? 0 : 1 - d / DOCK_DISTANCE;
    const obiettivo = 1 + (DOCK_SCALE_MAX - 1) * t;

    const a = (DOCK_SPRING.rigidita * (obiettivo - it.valore)
               - DOCK_SPRING.smorzamento * it.velocita) / DOCK_SPRING.massa;
    it.velocita += a * dt;
    it.valore += it.velocita * dt;

    if (Math.abs(obiettivo - it.valore) > 0.0008 || Math.abs(it.velocita) > 0.0008) {
      inMovimento = true;
    } else {
      it.valore = obiettivo;
      it.velocita = 0;
    }

    const sollevamento = -DOCK_LIFT * (it.valore - 1) / (DOCK_SCALE_MAX - 1);
    it.e.style.transform = it.valore === 1
      ? ''
      : 'translateY(' + sollevamento.toFixed(2) + 'px) scale(' + it.valore.toFixed(4) + ')';
  });

  if (inMovimento) {
    dockRaf = requestAnimationFrame(dockTick);
  } else {
    dockRaf = null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  CALENDARIO
//  Il selettore nativo di Chromium non è personalizzabile e mostra la
//  data nel formato del motore (mm/dd/yyyy): sbagliato per l'Italia e
//  fuori dal disegno del tool. Qui i campi data sono caselle di testo
//  in gg/mm/aaaa, con il valore ISO conservato in data-iso, e un
//  pannello disegnato con lo stesso stile del resto.
// ══════════════════════════════════════════════════════════════════
const GIORNI_BREVI = ['lu', 'ma', 'me', 'gi', 've', 'sa', 'do'];
const MESI_LUNGHI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

let calCampo = null;      // campo attualmente collegato al pannello
let calMese = null;       // primo giorno del mese mostrato

/** Imposta un campo data: valore ISO nascosto, testo visibile in italiano. */
function setDateField(campo, iso) {
  if (!campo) return;
  const pulito = dateStr(iso);
  campo.setAttribute('data-iso', pulito);
  campo.value = pulito ? fmtDate(pulito) : '';
}

/** Scrive in un campo qualsiasi, rispettando i campi data. */
function setFieldValue(campo, valore) {
  if (!campo) return;
  if (campo.hasAttribute('data-date')) { setDateField(campo, valore || ''); return; }
  campo.value = valore == null ? '' : valore;
}

/** gg/mm/aaaa digitato a mano → ISO. Accetta anche gg-mm-aaaa e g/m/aa. */
function parseDataItaliana(testo) {
  const m = String(testo || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (!m) return '';
  let anno = parseInt(m[3], 10);
  if (anno < 100) anno += anno > 40 ? 1900 : 2000;
  const mese = parseInt(m[2], 10);
  const giorno = parseInt(m[1], 10);
  if (mese < 1 || mese > 12 || giorno < 1 || giorno > 31) return '';
  const d = new Date(anno, mese - 1, giorno);
  if (d.getFullYear() !== anno || d.getMonth() !== mese - 1 || d.getDate() !== giorno) return '';
  const due = (n) => String(n).padStart(2, '0');
  return anno + '-' + due(mese) + '-' + due(giorno);
}

function isoDiOggi() {
  const d = new Date();
  const due = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());
}

function apriCalendario(campo) {
  const pannello = el('calPanel');
  if (!pannello || !campo) return;
  calCampo = campo;

  const iso = campo.getAttribute('data-iso') || '';
  const base = iso ? new Date(iso + 'T00:00:00') : new Date();
  calMese = new Date(base.getFullYear(), base.getMonth(), 1);

  renderCalendario();
  pannello.classList.add('open');

  // sotto al campo, rientrato se sborderebbe dalla finestra
  const r = campo.getBoundingClientRect();
  const larghezza = pannello.offsetWidth || 272;
  const altezza = pannello.offsetHeight || 300;
  let x = r.left;
  let y = r.bottom + 6;
  if (x + larghezza > window.innerWidth - 12) x = window.innerWidth - larghezza - 12;
  if (y + altezza > window.innerHeight - 12) y = Math.max(12, r.top - altezza - 6);
  pannello.style.left = Math.max(12, x) + 'px';
  pannello.style.top = y + 'px';
}

function chiudiCalendario() {
  const pannello = el('calPanel');
  if (pannello) pannello.classList.remove('open');
  calCampo = null;
}

function renderCalendario() {
  const pannello = el('calPanel');
  if (!pannello || !calMese) return;

  const anno = calMese.getFullYear();
  const mese = calMese.getMonth();
  const selezionato = calCampo ? (calCampo.getAttribute('data-iso') || '') : '';
  const oggi = isoDiOggi();
  const due = (n) => String(n).padStart(2, '0');

  // lunedì come primo giorno della settimana
  const primo = new Date(anno, mese, 1);
  let scarto = primo.getDay() - 1;
  if (scarto < 0) scarto = 6;
  const giorniMese = new Date(anno, mese + 1, 0).getDate();
  const giorniPrec = new Date(anno, mese, 0).getDate();

  let celle = '';
  for (let i = 0; i < 42; i++) {
    const n = i - scarto + 1;
    let giorno, isoCella, fuori;
    if (n < 1) {
      giorno = giorniPrec + n;
      const d = new Date(anno, mese - 1, giorno);
      isoCella = d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(giorno);
      fuori = true;
    } else if (n > giorniMese) {
      giorno = n - giorniMese;
      const d = new Date(anno, mese + 1, giorno);
      isoCella = d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(giorno);
      fuori = true;
    } else {
      giorno = n;
      isoCella = anno + '-' + due(mese + 1) + '-' + due(giorno);
      fuori = false;
    }
    const classi = ['cal-day'];
    if (fuori) classi.push('fuori');
    if (isoCella === selezionato) classi.push('scelto');
    if (isoCella === oggi) classi.push('oggi');
    celle += '<button type="button" class="' + classi.join(' ') +
             '" data-act="cal-pick" data-iso="' + esc(isoCella) + '">' + giorno + '</button>';
    if (n > giorniMese && (i + 1) % 7 === 0 && n >= 7) break;
  }

  pannello.innerHTML =
    '<div class="cal-head">' +
      '<button type="button" class="cal-nav" data-act="cal-mese" data-delta="-1" aria-label="Mese precedente">&#8249;</button>' +
      '<div class="cal-titolo">' + esc(MESI_LUNGHI[mese]) + ' ' + anno + '</div>' +
      '<button type="button" class="cal-nav" data-act="cal-mese" data-delta="1" aria-label="Mese successivo">&#8250;</button>' +
    '</div>' +
    '<div class="cal-settimana">' + GIORNI_BREVI.map((g) => '<span>' + g + '</span>').join('') + '</div>' +
    '<div class="cal-griglia">' + celle + '</div>' +
    '<div class="cal-piede">' +
      '<button type="button" class="cal-azione" data-act="cal-oggi">Oggi</button>' +
      '<button type="button" class="cal-azione" data-act="cal-vuota">Cancella</button>' +
    '</div>';
}

function scegliData(iso) {
  if (!calCampo) return;
  const campo = calCampo;
  setDateField(campo, iso);
  chiudiCalendario();
  campo.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Trasforma i campi data nativi in caselle di testo con calendario. */
function setupCalendari() {
  document.querySelectorAll('input[data-date]').forEach((campo) => {
    campo.setAttribute('type', 'text');
    campo.setAttribute('autocomplete', 'off');
    campo.setAttribute('placeholder', 'gg/mm/aaaa');
    campo.setAttribute('inputmode', 'numeric');
    if (!campo.hasAttribute('data-iso')) campo.setAttribute('data-iso', '');

    campo.addEventListener('focus', () => apriCalendario(campo));
    campo.addEventListener('click', () => apriCalendario(campo));
    // digitando a mano, il valore ISO si allinea a ogni carattere valido
    campo.addEventListener('input', () => {
      const iso = parseDataItaliana(campo.value);
      campo.setAttribute('data-iso', iso);
      if (iso) {
        calMese = new Date(iso + 'T00:00:00');
        calMese.setDate(1);
        if (calCampo === campo) renderCalendario();
      }
    });
    campo.addEventListener('blur', () => {
      const iso = parseDataItaliana(campo.value);
      if (campo.value.trim() && !iso) {
        // testo non interpretabile: si ripristina l'ultimo valore buono
        setDateField(campo, campo.getAttribute('data-iso') || '');
      } else if (iso) {
        setDateField(campo, iso);
      }
    });
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { chiudiCalendario(); campo.blur(); }
      if (ev.key === 'Enter') { chiudiCalendario(); }
    });
  });

  document.addEventListener('click', (ev) => {
    if (ev.target.closest('#calPanel') || ev.target.closest('input[data-date]')) return;
    chiudiCalendario();
  });
  window.addEventListener('resize', chiudiCalendario);
}

// ══════════════════════════════════════════════════════════════════
//  PREFERENZE E MENÙ IMPOSTAZIONI
//  Vivono in localStorage: sono scelte della postazione, non dati del
//  paziente. Nessun dato clinico esce mai dal file condiviso.
// ══════════════════════════════════════════════════════════════════
const PREFS_KEY = 'psonco-prefs';
const PREFS_DEFAULT = { dense: false, reduceMotion: false, skipIntro: false };
let PREFS = Object.assign({}, PREFS_DEFAULT);

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      Object.keys(PREFS_DEFAULT).forEach((k) => {
        if (typeof saved[k] === 'boolean') PREFS[k] = saved[k];
      });
    }
  } catch (_) { /* profilo nuovo o storage negato: si usano i default */ }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS)); } catch (_) {}
}

function applyPrefs() {
  document.body.classList.toggle('dense', PREFS.dense);
  document.body.classList.toggle('reduce-motion', PREFS.reduceMotion);
  document.querySelectorAll('[data-act="pref"]').forEach((btn) => {
    const chiave = btn.getAttribute('data-pref');
    btn.setAttribute('aria-checked', PREFS[chiave] ? 'true' : 'false');
  });
}

function togglePref(chiave) {
  if (!(chiave in PREFS_DEFAULT)) return;
  PREFS[chiave] = !PREFS[chiave];
  savePrefs();
  applyPrefs();
  if (chiave === 'dense') moveTabHighlight();
}

function toggleSettings(forza) {
  const menu = el('settingsMenu');
  const btn = el('settingsBtn');
  if (!menu || !btn) return;
  const apri = typeof forza === 'boolean' ? forza : !menu.classList.contains('open');
  menu.classList.toggle('open', apri);
  btn.setAttribute('aria-expanded', apri ? 'true' : 'false');
  if (apri) refreshSettingsInfo();
}

function refreshSettingsInfo() {
  const info = el('smInfo');
  if (!info) return;
  const righe = ['ER Oncology Archivist ' + (appInfo.version || '')];
  if (IS_ELECTRON) {
    righe.push(dataFolder ? 'Cartella: ' + dataFolder : 'Cartella dati non ancora scelta');
    if (readOnly) righe.push('Sola lettura');
  } else {
    righe.push('Modalità browser — i dati non vengono salvati');
  }
  info.textContent = '';
  righe.forEach((r) => {
    const d = document.createElement('div');
    d.textContent = r;
    info.appendChild(d);
  });
}


/** Copia di sicurezza dell'archivio su chiavetta USB.
 *  La ricerca dell'unità, la conferma e la scrittura avvengono nel
 *  processo principale: il renderer non tocca mai un percorso. */
async function safetyNet() {
  if (!IS_ELECTRON) { notify('Disponibile solo nell’applicazione desktop.'); return; }
  if (!storageReady) { notify('Serve prima una cartella dati leggibile.'); return; }
  notify('Cerco un’unità rimovibile…');
  try {
    const r = await API.safetyNet();
    if (!r || r.stato === 'nessuna-unita') {
      notify('Nessuna chiavetta USB rilevata: inseriscine una e riprova.');
    } else if (r.stato === 'annullato') {
      notify('Copia annullata.');
    } else if (r.stato === 'senza-cartella') {
      notify('Cartella dati non configurata.');
    } else if (r.stato === 'ok') {
      notify('Copia salvata su ' + r.unita + ' (' + r.esami + ' esami).');
      refreshSettingsInfo();
    } else {
      notify('Copia non riuscita: ' + (r.messaggio || 'errore sconosciuto'));
    }
  } catch (e) {
    notify('Copia non riuscita: ' + e.message);
  }
}

/** In modalità browser le voci che toccano il file non hanno senso. */
function setupSettings() {
  loadPrefs();
  applyPrefs();
  if (!IS_ELECTRON) {
    ['smFolder', 'smReload', 'smSafety'].forEach((id) => {
      const b = el(id);
      if (b) { b.disabled = true; b.title = 'Disponibile solo nell’applicazione desktop'; }
    });
  }
  refreshSettingsInfo();
}

// ══════════════════════════════════════════════════════════════════
//  SPLASH E TRANSIZIONI
// ══════════════════════════════════════════════════════════════════
// Ritardi della sequenza. Il totale e' volutamente contenuto: e' uno
// strumento che si apre molte volte per turno, un'intro lunga e' attrito.
const INTRO_TITLE_DELAY = 580;    // quando parte il primo glifo
const INTRO_GLYPH_STAGGER = 17;   // sfalsamento fra un glifo e il successivo
const INTRO_HOLD = 2650;          // quando parte la dissolvenza di uscita
const INTRO_FLIGHT = 700;         // volo del logo verso la nav
const POP_STEP = 90;              // cascata fra una sezione e la successiva
const HEX_SIZE = 76;              // larghezza di un esagono, px
const HEX_SPEED = 2.1;            // px al millisecondo del fronte d'onda
const HEX_CELL_MS = 420;          // durata della sparizione di una cella

let introTimer = null;
let introClosed = false;
let hexCells = null;

/** Intro automatica: nessun click richiesto, ma interrompibile. */
function runIntro() {
  const stage = el('splashStage');
  const screen = el('splashScreen');
  if (!stage || !screen) return;

  // Chi apre il programma venti volte al giorno l'intro non la vuole.
  if (PREFS.skipIntro || PREFS.reduceMotion) {
    screen.classList.add('closing');
    stage.classList.add('settled');
    if (el('navLogo')) el('navLogo').classList.add('landed');
    introClosed = true;
    return;
  }

  // Logo: pathLength=1 normalizza la lunghezza del tracciato a 1, cosi'
  // stroke-dashoffset funziona su qualunque geometria. E' anche cio' che
  // rende superfluo getTotalLength(), che sui tracciati compositi (le
  // lettere con i fori) restituiva valori sbagliati.
  document.querySelectorAll('.splash-logo-svg-wrap path').forEach((path) => {
    path.setAttribute('pathLength', '1');
    path.classList.add('splash-logo-path');
  });

  // Titolo: i --d originali andavano da destra a sinistra. Si riordinano
  // per far entrare le lettere nel verso di lettura.
  const glyphs = Array.prototype.slice.call(document.querySelectorAll('.splash-glyph'));
  glyphs
    .map((g) => ({ g: g, d: parseFloat(g.style.getPropertyValue('--d')) || 0 }))
    .sort((a, b) => b.d - a.d)
    .forEach((item, i) => {
      item.g.style.setProperty('--d', (INTRO_TITLE_DELAY + i * INTRO_GLYPH_STAGGER) + 'ms');
    });

  // Le animazioni CSS non avanzano finche' la finestra non viene
  // disegnata, ed Electron la crea con show:false. Partendo a orologio
  // l'intro verrebbe tagliata dei millisecondi passati da nascosta.
  // Quindi: si parte al primo fotogramma davvero dipinto...
  let avviata = false;
  const avvia = () => {
    if (avviata) return;
    avviata = true;
    void stage.offsetWidth;
    stage.classList.add('playing');
    introTimer = setTimeout(closeIntro, INTRO_HOLD);
  };
  requestAnimationFrame(() => requestAnimationFrame(avvia));
  // ...ma non oltre questo limite, se la finestra restasse nascosta:
  // meglio un'intro non vista che restare bloccati sullo splash.
  setTimeout(avvia, 1200);
  screen.addEventListener('click', closeIntro);
  document.addEventListener('keydown', introKeyHandler);
}

function introKeyHandler(ev) {
  if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') closeIntro();
}

function closeIntro() {
  if (introClosed) return;
  introClosed = true;
  clearTimeout(introTimer);
  document.removeEventListener('keydown', introKeyHandler);

  const screen = el('splashScreen');
  const logoBtn = el('splashLogo');
  const logoWrap = document.querySelector('.splash-logo-svg-wrap');
  const navLogo = el('navLogo');
  if (screen) screen.removeEventListener('click', closeIntro);

  // ── FLIP, misurato PRIMA di far entrare l'interfaccia ──
  // La nav e' il bersaglio dell'atterraggio: misurarla mentre e' gia'
  // spostata dalla propria animazione d'ingresso manderebbe il logo
  // dove la nav si trova a meta' corsa, non dove finisce.
  let volo = null;
  if (logoBtn && logoWrap && navLogo) {
    const btn = logoBtn.getBoundingClientRect();
    const wrap = logoWrap.getBoundingClientRect();
    const to = navLogo.getBoundingClientRect();
    if (wrap.width > 0 && to.width > 0) {
      const scala = to.width / wrap.width;
      // Il logo visibile e' il wrap, ma la transform va sul contenitore
      // (il wrap ha gia' la sua): si compensa lo scarto fra i due.
      volo = {
        dx: to.left - btn.left - (wrap.left - btn.left) * scala,
        dy: to.top - btn.top - (wrap.top - btn.top) * scala,
        scala: scala
      };
    }
  }

  if (!screen || !volo) { finishIntro(); return; }

  hexCells = buildHexVeil();
  screen.classList.add('exiting');
  logoBtn.classList.add('flying');
  logoBtn.style.transform =
    'translate(' + volo.dx.toFixed(2) + 'px, ' + volo.dy.toFixed(2) + 'px)' +
    ' scale(' + volo.scala.toFixed(4) + ')';

  setTimeout(finishIntro, INTRO_FLIGHT);
}

/** Atterraggio: il logo della nav prende il posto di quello volante,
 *  e solo allora le sezioni cominciano a comparire, una per volta. */
function finishIntro() {
  const screen = el('splashScreen');
  const stage = el('splashStage');
  const navLogo = el('navLogo');
  if (navLogo) navLogo.classList.add('landed');
  if (screen) screen.classList.add('closing');
  // Spenti i filtri: 51 blur SVG vivi costano frame per nulla.
  if (stage) stage.classList.add('settled');

  // La prima pagina non entra a cascata: si scopre da sotto il favo,
  // che si scompone partendo dal logo appena atterrato.
  if (hexCells && navLogo) {
    const r = navLogo.getBoundingClientRect();
    revealFromHex(hexCells, r.left + r.width / 2, r.top + r.height / 2);
    hexCells = null;
  } else {
    popSections(currentView);
  }
}

/** Fa comparire a cascata le sezioni della vista indicata.
 *  Riavvia sempre da zero: senza togliere la classe, riattivarla non
 *  fa ripartire l'animazione. */
function popSections(view) {
  if (PREFS.reduceMotion) return;
  const root = el('view-' + view);
  if (!root) return;
  const sezioni = root.querySelectorAll('.pop-section');
  let i = 0;
  sezioni.forEach((e) => {
    // le sezioni non visibili (step del wizard nascosti) non contano
    if (e.offsetParent === null) { e.classList.remove('popping'); return; }
    e.classList.remove('popping');
    void e.offsetWidth;
    e.style.setProperty('--pop-delay', (i * POP_STEP) + 'ms');
    e.classList.add('popping');
    i++;
  });
}


/** Costruisce il favo che copre la finestra. Si prepara mentre il logo
 *  vola, così a fine volo la rivelazione parte senza scatti. */
function buildHexVeil() {
  const veil = el('hexReveal');
  if (!veil || PREFS.reduceMotion) return null;
  veil.textContent = '';

  const W = HEX_SIZE;
  const H = W * 0.8660;          // altezza di un esagono a punte laterali
  const passoX = W * 0.75;       // le colonne si incastrano
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const frammento = document.createDocumentFragment();
  const celle = [];

  for (let col = 0; col * passoX < vw + W; col++) {
    const offset = (col % 2) ? H / 2 : 0;
    for (let row = -1; row * H + offset < vh + H; row++) {
      const x = col * passoX;
      const y = row * H + offset;
      const cella = document.createElement('div');
      cella.className = 'hex-cell';
      cella.style.left = x + 'px';
      cella.style.top = y + 'px';
      cella.style.width = W + 'px';
      cella.style.height = H + 'px';
      celle.push({ e: cella, cx: x + W / 2, cy: y + H / 2 });
      frammento.appendChild(cella);
    }
  }
  veil.appendChild(frammento);
  veil.classList.add('armed');
  return celle;
}

/** Fa sparire il favo a onda, partendo dal punto indicato. */
function revealFromHex(celle, origineX, origineY) {
  const veil = el('hexReveal');
  if (!veil || !celle || !celle.length) { if (veil) veil.classList.remove('armed'); return 0; }

  let ritardoMax = 0;
  celle.forEach((c) => {
    const dx = c.cx - origineX;
    const dy = c.cy - origineY;
    const ritardo = Math.round(Math.sqrt(dx * dx + dy * dy) / HEX_SPEED);
    if (ritardo > ritardoMax) ritardoMax = ritardo;
    c.e.style.setProperty('--hex-delay', ritardo + 'ms');
  });
  veil.classList.add('revealing');

  const totale = ritardoMax + HEX_CELL_MS + 60;
  setTimeout(() => {
    veil.classList.remove('armed', 'revealing');
    veil.textContent = '';
  }, totale);
  return totale;
}

/** Copia del logo SD nella barra di navigazione. */
function setupNavLogo() {
  const original = document.querySelector('.splash-logo-svg-wrap svg');
  const holder = el('navLogo');
  if (!original || !holder || holder.childNodes.length) return;
  holder.appendChild(cloneLogoSvg(original, 'splashGradLogoIconNav'));
}

/** Clona il logo rinominando l'id del gradiente: due gradienti con lo
 *  stesso id nello stesso documento si annullano a vicenda. */
function cloneLogoSvg(original, newId) {
  const clone = original.cloneNode(true);
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  // Il clone vive fuori da .splash-stage.playing: senza spogliarlo della
  // classe di disegno resterebbe a dashoffset 1 e fill-opacity 0.
  clone.querySelectorAll('.splash-logo-path').forEach((path) => {
    path.classList.remove('splash-logo-path');
  });
  const grad = clone.querySelector('#splashGradLogoIcon');
  if (grad) {
    grad.id = newId;
    clone.querySelectorAll('[fill="url(#splashGradLogoIcon)"]').forEach((e) => {
      e.setAttribute('fill', 'url(#' + newId + ')');
    });
  }
  return clone;
}

// ══════════════════════════════════════════════════════════════════
//  EVENTI (delega: nessun gestore inline, la CSP resta rigida)
// ══════════════════════════════════════════════════════════════════
const CLICK_ACTIONS = {
  'view': (t) => showView(t.getAttribute('data-view')),
  'step': (t) => goStep(parseInt(t.getAttribute('data-step'), 10)),
  'save-wizard': () => saveWizard(),
  'reset-wizard': () => { resetWizard(); notify('Modulo azzerato.'); },
  'add-fu': () => addFU(),
  'del-fu': (t) => removeFU(parseInt(t.getAttribute('data-idx'), 10)),
  'set-onco': (t) => setOnco(t.getAttribute('data-val')),
  'set-class': (t) => setClassTumore(t.getAttribute('data-val')),
  'set-sottocat': (t) => setSottocat(t.getAttribute('data-val')),
  'set-meta': (t) => setMetastasi(t.getAttribute('data-val')),
  'settings-toggle': () => toggleSettings(),
  'pref': (t) => togglePref(t.getAttribute('data-pref')),
  'cal-pick': (t) => scegliData(t.getAttribute('data-iso')),
  'cal-mese': (t) => { if (!calMese) return; calMese.setMonth(calMese.getMonth() + (parseInt(t.getAttribute('data-delta'), 10) || 0)); renderCalendario(); },
  'cal-oggi': () => scegliData(isoDiOggi()),
  'cal-vuota': () => scegliData(''),
  'reset-filters': () => resetFilters(),
  'reset-stats': () => resetStatsFilters(),
  'sort': (t) => sortBy(t.getAttribute('data-key')),
  'detail': (t) => openDetail(t.getAttribute('data-id')),
  'addfu': (t) => openAddFU(t.getAttribute('data-id')),
  'save-fu': () => saveFU(),
  'del-selected': () => deleteSelected(),
  'detail-edit': () => { const id = detailId; closeOverlay('modDetail'); if (id) loadIntoWizard(id); },
  'detail-del': () => deleteDetail(),
  'close': (t) => closeOverlay(t.getAttribute('data-target')),
  'export-open': () => { const m = el('modExport'); if (m) m.classList.add('open'); },
  'export-xlsx': (t) => { closeOverlay('modExport'); exportExcel(t.getAttribute('data-anon') === '1'); },
  'export-csv': (t) => { closeOverlay('modExport'); exportCSV(t.getAttribute('data-anon') === '1'); },
  'export-pdf': () => { closeOverlay('modExport'); exportPDF(); },
  'export-pptx': () => { closeOverlay('modExport'); exportPPTX(); },
  'welcome-select': () => welcomeSelectFolder(),
  'select-folder': () => { toggleSettings(false); selectFolder(); },
  'reload': () => { toggleSettings(false); if (IS_ELECTRON && dataFolder) activateFolder(); },
  'safety-net': () => { toggleSettings(false); safetyNet(); },
  'pick': (t) => {
    const target = el(t.getAttribute('data-target'));
    if (target) { target.value = t.getAttribute('data-value') || ''; }
  }
};

function wireEvents() {
  document.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-act]');
    if (!target) return;
    const fn = CLICK_ACTIONS[target.getAttribute('data-act')];
    if (!fn) return;
    ev.preventDefault();
    fn(target);
  });

  const on = (id, evt, fn) => { const e = el(id); if (e) e.addEventListener(evt, fn); };

  ['w_nome', 'w_cognome'].forEach((id) => on(id, 'input', onNomeInput));
  on('w_sesso_override', 'change', onNomeInput);
  on('w_dob', 'change', updateAge);
  on('w_data', 'change', liveValidate2);
  on('w_tipo_esame', 'input', liveValidate2);
  on('w_richiesta', 'input', liveValidate2);

  ['fOnco', 'fPrima', 'fClassTumore', 'fMeta', 'fTipo'].forEach((id) => on(id, 'change', applyFilters));
  on('fSearch', 'input', applyFilters);
  ['sfDal', 'sfAl', 'sfTipo', 'sfFocus'].forEach((id) => on(id, 'change', renderStats));

  on('chkAll', 'change', (ev) => toggleAll(ev.target.checked));
  const tbody = el('tblBody');
  if (tbody) {
    tbody.addEventListener('change', (ev) => {
      if (ev.target.classList.contains('rchk')) toggleRow(ev.target);
    });
  }

  document.querySelectorAll('.overlay').forEach((m) => {
    m.addEventListener('click', (ev) => { if (ev.target === m) m.classList.remove('open'); });
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      toggleSettings(false);
      document.querySelectorAll('.overlay.open').forEach((m) => m.classList.remove('open'));
    }
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.settings-wrap')) toggleSettings(false);
  });
  window.addEventListener('resize', moveTabHighlight);

  window.addEventListener('beforeunload', releaseLock);
  window.addEventListener('pagehide', releaseLock);
}

// ══════════════════════════════════════════════════════════════════
//  AVVIO — dopo che tutte le dichiarazioni globali esistono
// ══════════════════════════════════════════════════════════════════
function boot() {
  setupCalendari();
  setupNavLogo();
  setupSettings();
  setupDock();              // prima di runIntro: i cloni devono essere "puliti"
  runIntro();
  wireEvents();
  applyViewState();
  buildProgress();
  renderFUList();
  liveValidate1();
  liveValidate2();
  checkServer();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
