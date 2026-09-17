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
let tipiEsame = { lista: [], updatedAt: 0 };   // tassonomia condivisa
let noteGrafici = { updatedAt: 0 };           // descrizioni corrette a mano
let personalizzazione = personalizzazioneVuota();  // categorie della cronologia
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
// Ogni modifica incrementa la prima, ogni salvataggio confermato porta la
// seconda al valore che aveva quando è partito: se differiscono, c'è
// qualcosa che vive solo in memoria.
let versioneModifiche = 0;
let versioneSalvata = 0;
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
  if (isNaN(d.getTime())) return '';
  // Date sposta i giorni in eccesso (2026-02-31 diventa il 3 marzo):
  // una data che non torna identica non esiste e si scarta.
  const due = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) === s ? s : '';
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Età alla data indicata (ISO yyyy-mm-dd); senza riferimento, a oggi.
 *  Su una scheda d'esame l'età che conta è quella al momento dell'esame:
 *  calcolarla sempre a oggi faceva invecchiare i record archiviati a ogni
 *  apertura del programma, e lo stesso archivio esportato a un anno di
 *  distanza dava numeri diversi. */
function calcAge(dob, riferimento) {
  if (!dob) return null;
  const b = new Date(dob + 'T00:00:00');
  if (isNaN(b.getTime())) return null;
  let n = null;
  if (riferimento) {
    const rif = new Date(riferimento + 'T00:00:00');
    if (!isNaN(rif.getTime())) n = rif;
  }
  if (!n) n = new Date();
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
  // separatore decimale italiano: su un referto "27.6" si legge male
  const testo = dec ? v.toFixed(dec).replace('.', ',') : String(Math.round(v));
  return testo + '%';
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

/** Chiude una finestra con un'uscita speculare all'entrata, invece di
 *  farla sparire di colpo. */
function chiudiOverlay(o) {
  // la finestra di dialogo chiusa con Esc o dallo sfondo vale come annulla
  if (o && o.id === 'modDialogo' && dialogoAperto) { dialogoAperto.risolvi(dialogoAperto.annulla); return; }
  if (!o || !o.classList.contains('open') || o.classList.contains('in-chiusura')) return;
  if (PREFS.reduceMotion) {
    o.classList.remove('open');
    dopoChiusuraOverlay(o);
    return;
  }
  o.classList.add('in-chiusura');
  setTimeout(() => {
    if (!o.classList.contains('in-chiusura')) return;      // riaperta nel frattempo
    o.classList.remove('open', 'in-chiusura');
    dopoChiusuraOverlay(o);
  }, 200);
}

function apriOverlay(o) {
  if (!o) return;
  o.classList.remove('in-chiusura');
  o.classList.add('open');
}

function dopoChiusuraOverlay(o) {
  if (o.id === 'modPersonalizza') {
    const b = el('railPersonalizza');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
}

function closeOverlay(id) {
  chiudiOverlay(el(id));
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

/** Id per i record che ne sono privi (file modificati a mano): ricavato
 *  da contenuto e posizione, quindi uguale a ogni lettura. Con un id
 *  casuale la copia sul file e quella in memoria sembravano due esami
 *  diversi, e al salvataggio il record si duplicava. */
function idStabile(raw, indice) {
  const testo = JSON.stringify(raw) + '#' + (indice || 0);
  let h = 0x811c9dc5;
  for (let i = 0; i < testo.length; i++) {
    h ^= testo.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'imp-' + h.toString(36) + '-' + (indice || 0);
}

function normalizeRecord(raw, indice) {
  if (!raw || typeof raw !== 'object') return null;
  // Senza createdAt si usa 0 e non l'ora corrente, per lo stesso motivo
  // dell'id: il record letto due volte deve risultare identico.
  const created = num(raw.createdAt);
  const rec = {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id.slice(0, 64) : idStabile(raw, indice),
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
  rec.eta = calcAge(rec.dob, rec.data);
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
  // senza prototipo: una chiave "__proto__" nel file resta una chiave qualsiasi
  const deleted = Object.create(null);
  let tipi = { lista: [], updatedAt: 0 };
  let note = { updatedAt: 0 };
  let pers = personalizzazioneVuota();
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    list = Array.isArray(raw.records) ? raw.records : [];
    if (raw.note && typeof raw.note === 'object') {
      note = { updatedAt: num(raw.note.updatedAt) };
      Object.keys(raw.note).forEach((k) => {
        const v = raw.note[k];
        // solo le descrizioni dei grafici esistenti: nessuna chiave arbitraria
        if (NOTE_CHIAVI.indexOf(k) !== -1 && v && typeof v === 'object' && typeof v.testo === 'string') {
          note[k] = { testo: str(v.testo, 1200), updatedAt: num(v.updatedAt) };
        }
      });
    }
    if (raw.tipiEsame && typeof raw.tipiEsame === 'object' && Array.isArray(raw.tipiEsame.lista)) {
      tipi = {
        lista: raw.tipiEsame.lista.map((t) => str(t, 200)).filter((t) => t && !esameEscluso(t)).slice(0, 200),
        updatedAt: num(raw.tipiEsame.updatedAt)
      };
    }
    if (raw.personalizzazione && typeof raw.personalizzazione === 'object') {
      pers = normalizzaPersonalizzazione(raw.personalizzazione);
    }
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
  list.forEach((r, i) => {
    const rec = normalizeRecord(r, i);
    if (rec) records.push(rec);
  });
  return { records: records, deleted: deleted, tipi: tipi, note: note, personalizzazione: pers };
}

function serializeStore(store) {
  return JSON.stringify({
    schema: SCHEMA,
    savedAt: new Date().toISOString(),
    records: store.records,
    deleted: store.deleted,
    tipiEsame: store.tipi || { lista: [], updatedAt: 0 },
    note: store.note || { updatedAt: 0 },
    personalizzazione: store.personalizzazione || personalizzazioneVuota()
  }, null, 2);
}

/** Unione last-write-wins per id, con tombstone per le cancellazioni. */
function mergeStores(a, b) {
  const deleted = Object.create(null);
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

  // la tassonomia segue la stessa regola: vince la più recente
  const tipiA = a.tipi || { lista: [], updatedAt: 0 };
  const tipiB = b.tipi || { lista: [], updatedAt: 0 };
  const tipi = tipiB.updatedAt > tipiA.updatedAt ? tipiB : tipiA;

  const noteA = a.note || { updatedAt: 0 };
  const noteB = b.note || { updatedAt: 0 };
  const note = noteB.updatedAt > noteA.updatedAt ? noteB : noteA;

  const persA = a.personalizzazione || personalizzazioneVuota();
  const persB = b.personalizzazione || personalizzazioneVuota();
  const pers = persB.updatedAt > persA.updatedAt ? persB : persA;

  return { records: records, deleted: deleted, tipi: tipi, note: note, personalizzazione: pers };
}

/** Impronta dello stato: record, cancellazioni, tipi di esame e
 *  descrizioni. Con i soli record, un elenco dei tipi modificato
 *  sull'altra postazione non arrivava finché non cambiava un esame. */
function storeSignature(store) {
  return store.records
    .map((r) => r.id + ':' + r.updatedAt)
    .sort()
    .join('|') +
    '#' + Object.keys(store.deleted || {}).length +
    '#' + ((store.tipi && store.tipi.updatedAt) || 0) +
    '#' + ((store.note && store.note.updatedAt) || 0) +
    '#' + ((store.personalizzazione && store.personalizzazione.updatedAt) || 0);
}

function statoLocale() {
  return { records: DB, deleted: deletedIds, tipi: tipiEsame, note: noteGrafici, personalizzazione: personalizzazione };
}

function applicaStore(store) {
  DB = store.records;
  deletedIds = store.deleted;
  tipiEsame = store.tipi || tipiEsame;
  noteGrafici = store.note || noteGrafici;
  personalizzazione = store.personalizzazione || personalizzazione;
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

/** conservaMemoria: ricarica della stessa cartella, quanto è in memoria
 *  e non ancora sul file si unisce invece di andare perso. */
async function activateFolder(conservaMemoria) {
  storageReady = true;
  refreshSettingsInfo();
  readOnly = false;
  renderBanners('file');
  const daScrivere = await loadFromFile(conservaMemoria);
  if (storageReady) {
    startLock();
    startPolling();
    if (daScrivere) scheduleSave();
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
    // I salvataggi in attesa vanno scritti PRIMA di cambiare cartella: il
    // processo principale punta subito alla nuova, e un salvataggio
    // ritardato vi avrebbe riversato gli esami dell'archivio precedente.
    await scaricaSalvataggi();
    const folder = await API.selectDataFolder();
    if (!folder) return;
    if (typeof folder === 'object') {
      await avviso({
        tipo: 'errore',
        titolo: 'Cartella non utilizzabile',
        messaggio: 'La cartella selezionata non esiste o non è scrivibile.',
        dettaglio: 'Verificare i permessi sulla condivisione di rete e riprovare.'
      });
      return;
    }
    const stessa = folder === dataFolder;
    if (!stessa) {
      clearTimeout(saveTimer);
      saveTimer = null;
      applicaStore({ records: [], deleted: Object.create(null), tipi: { lista: [], updatedAt: 0 },
        note: { updatedAt: 0 }, personalizzazione: personalizzazioneVuota() });
      versioneSalvata = versioneModifiche;
    }
    dataFolder = folder;
    await activateFolder(stessa);
  } catch (e) {
    notify('Errore selezione cartella: ' + e.message);
  }
}

/** Restituisce true se la memoria conteneva modifiche assenti dal file. */
async function loadFromFile(conservaMemoria) {
  let text;
  try {
    text = await API.readText(DATA_FILE);
  } catch (e) {
    // Rete non disponibile: NON si azzera l'archivio e NON si scrive.
    enterReadOnly('Cartella dati non raggiungibile: ' + e.message);
    return false;
  }
  let daScrivere = false;
  try {
    const store = parseStore(text);
    if (conservaMemoria && (DB.length || Object.keys(deletedIds).length)) {
      const unito = mergeStores(store, statoLocale());
      daScrivere = storeSignature(unito) !== storeSignature(store);
      applicaStore(unito);
    } else {
      applicaStore(store);
    }
    aggiornaSelettoreTipo();
    setStatus('saved', '● file locale');
  } catch (e) {
    enterReadOnly(e.message + ' Archivio aperto in sola lettura: nessuna scrittura verrà eseguita.');
    return false;
  }
  refreshViews();
  return daScrivere;
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
  versioneModifiche++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; persistDB(); }, 400);
}

/** Porta a termine il salvataggio programmato e quello in corso. */
async function scaricaSalvataggi() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await persistDB();
  } else {
    await saveChain;
  }
}

function modifichePendenti() {
  return versioneModifiche > versioneSalvata;
}

/** Chiusura della finestra: si salva quanto resta, poi si risponde al
 *  processo principale, che chiede conferma se qualcosa non è andato. */
let chiusuraInCorso = false;

/** Chiusura della finestra: si salva quanto resta; se qualcosa non va,
 *  decide l'utente in una finestra del tool. */
async function preparaChiusura() {
  if (chiusuraInCorso) return;          // secondo clic sulla X mentre si decide
  chiusuraInCorso = true;
  try {
    try { await scaricaSalvataggi(); } catch (_) { /* resta pendente, si segnala */ }
    if (!modifichePendenti()) {
      await releaseLock();
      await API.confermaChiusura('chiudi');
      return;
    }
    await API.confermaChiusura('attendi');
    const motivo = readOnly
      ? 'L’archivio è aperto in sola lettura: gli esami inseriti in questa sessione non sono stati scritti.'
      : !storageReady
        ? 'Nessuna cartella dati attiva: gli esami inseriti sono solo in memoria.'
        : 'L’ultimo salvataggio non è andato a buon fine (rete non raggiungibile o file occupato).';
    const scelta = await dialogo({
      tipo: 'avviso',
      titolo: 'Modifiche non salvate',
      messaggio: 'Alcune modifiche non risultano salvate sul file condiviso.',
      dettaglio: motivo + ' Chiudendo ora andranno perse.',
      pulsanti: [{ testo: 'Chiudi comunque', stile: 'pericolo' }, { testo: 'Resta aperto', stile: 'primario' }],
      predefinito: 1,
      annulla: 1
    });
    await API.confermaChiusura(scelta === 0 ? 'chiudi' : 'resta');
  } finally {
    chiusuraInCorso = false;
  }
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
  const versione = versioneModifiche;
  setStatus('saving', '● salvataggio...');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = parseStore(await API.readText(DATA_FILE));
      const merged = mergeStores(remote, statoLocale());
      await API.writeText(DATA_FILE, serializeStore(merged));

      const check = parseStore(await API.readText(DATA_FILE));
      // Fra lettura, scrittura e verifica l'utente può aver salvato un
      // altro esame. Sostituire la memoria con `merged` lo cancellava, e
      // il salvataggio successivo non l'avrebbe più trovato: si unisce.
      applicaStore(mergeStores(merged, statoLocale()));
      if (storeContains(check, merged)) {
        versioneSalvata = Math.max(versioneSalvata, versione);
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
    const before = storeSignature(statoLocale());
    const merged = mergeStores(remote, statoLocale());
    const after = storeSignature(merged);
    if (before === after) return;
    applicaStore(merged);
    aggiornaSelettoreTipo();
    if (personalizzazioneAperta()) { renderTipiEsame(); renderCategorieRichieste(); }
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
//  FINESTRE DI DIALOGO
//  Conferme e avvisi hanno lo stesso aspetto e le stesse animazioni del
//  resto del tool: niente conferme native del browser e niente finestre di
//  Windows dal processo principale. Esc e clic sullo sfondo annullano.
// ══════════════════════════════════════════════════════════════════
const ICONE_DIALOGO = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  avviso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  pericolo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
  errore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>'
};

let dialogoAperto = null;

/** Mostra la finestra e restituisce l'indice del pulsante scelto.
 *  opzioni: { tipo, titolo, messaggio, dettaglio,
 *             pulsanti: [{ testo, stile: 'primario'|'pericolo'|'' }],
 *             predefinito: indice con il fuoco, annulla: indice per Esc } */
function dialogo(opzioni) {
  return new Promise((risolvi) => {
    const o = el('modDialogo');
    const pulsanti = opzioni.pulsanti && opzioni.pulsanti.length ? opzioni.pulsanti : [{ testo: 'OK', stile: 'primario' }];
    const annulla = opzioni.annulla != null ? opzioni.annulla : 0;
    if (!o) { risolvi(annulla); return; }
    if (dialogoAperto) dialogoAperto.risolvi(dialogoAperto.annulla);

    const tipo = ICONE_DIALOGO[opzioni.tipo] ? opzioni.tipo : 'info';
    o.setAttribute('data-tipo', tipo);
    el('dlgIcona').innerHTML = ICONE_DIALOGO[tipo];
    el('dlgTitolo').textContent = opzioni.titolo || '';
    el('dlgMessaggio').textContent = opzioni.messaggio || '';
    const dettaglio = el('dlgDettaglio');
    dettaglio.textContent = opzioni.dettaglio || '';
    dettaglio.hidden = !opzioni.dettaglio;

    const scelte = el('dlgScelte');
    scelte.textContent = '';
    pulsanti.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm ' + (p.stile === 'pericolo' ? 'btn-danger' : p.stile === 'primario' ? 'btn-primary' : 'btn-outline');
      b.textContent = p.testo;
      b.setAttribute('data-act', 'dialogo-scelta');
      b.setAttribute('data-idx', String(i));
      scelte.appendChild(b);
    });

    const fuocoPrima = document.activeElement;
    dialogoAperto = {
      annulla: annulla,
      risolvi: (indice) => {
        dialogoAperto = null;
        chiudiOverlay(o);
        if (fuocoPrima && typeof fuocoPrima.focus === 'function' && document.contains(fuocoPrima)) {
          fuocoPrima.focus({ preventScroll: true });
        }
        risolvi(indice);
      }
    };
    apriOverlay(o);
    const fuoco = scelte.children[opzioni.predefinito != null ? opzioni.predefinito : pulsanti.length - 1];
    if (fuoco) setTimeout(() => fuoco.focus({ preventScroll: true }), 40);
  });
}

function sceltaDialogo(indice) {
  if (dialogoAperto && indice >= 0) dialogoAperto.risolvi(indice);
}

/** Conferma a due pulsanti: Annulla a sinistra, l'azione a destra. Per
 *  le azioni distruttive il fuoco parte su Annulla. */
async function conferma(opzioni) {
  const distruttiva = opzioni.tipo === 'pericolo';
  const scelta = await dialogo({
    tipo: opzioni.tipo, titolo: opzioni.titolo, messaggio: opzioni.messaggio, dettaglio: opzioni.dettaglio,
    pulsanti: [{ testo: opzioni.annulla || 'Annulla' },
               { testo: opzioni.conferma || 'Conferma', stile: distruttiva ? 'pericolo' : 'primario' }],
    predefinito: distruttiva ? 0 : 1,
    annulla: 0
  });
  return scelta === 1;
}

function avviso(opzioni) {
  return dialogo({ tipo: opzioni.tipo || 'info', titolo: opzioni.titolo, messaggio: opzioni.messaggio,
    dettaglio: opzioni.dettaglio, pulsanti: [{ testo: opzioni.pulsante || 'Ho capito', stile: 'primario' }] });
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

// ══ Ridisegnare solo quando serve ══════════════════════════════════
// Cambiare vista non deve ricostruire duecento righe di tabella o dieci
// grafici identici a quelli di un attimo prima. Misurato a CPU
// rallentata quattro volte: 271 ms di blocco per l'archivio e 306 per le
// statistiche, cioe' il ritardo fra il clic sulla scheda e la partenza
// dello scorrimento. Ora si ridisegna solo se dati, filtri o ordinamento
// sono cambiati davvero.
let firmaArchivio = null;
let firmaStatistiche = null;

/** Firma leggera dei dati: quanti esami, quanto recenti, piu' le
 *  impostazioni condivise che cambiano quel che si vede. */
function firmaDati() {
  let ultimo = 0, somma = 0;
  DB.forEach((r) => {
    if (r.updatedAt > ultimo) ultimo = r.updatedAt;
    somma = (somma + (r.updatedAt % 1000000007)) % 9007199254740;
  });
  return DB.length + ':' + ultimo + ':' + somma +
         ':' + (tipiEsame.updatedAt || 0) +
         ':' + (personalizzazione.updatedAt || 0);
}

function firmaArchivioOra() {
  return [firmaDati(), val('fOnco'), val('fPrima'), val('fTipo'), val('fClassTumore'),
          val('fMeta'), val('fSesso'), rawVal('fSearch').trim().toLowerCase(),
          sortKey, sortDir].join('¦');
}

function firmaStatisticheOra() {
  return [firmaDati(), val('sfDal'), val('sfAl'), val('sfTipo'), val('sfFocus'),
          (noteGrafici.updatedAt || 0)].join('¦');
}

/** Ridisegna l'archivio solo se e' cambiato qualcosa. */
function archivioSeServe() {
  if (firmaArchivioOra() === firmaArchivio) return;
  applyFilters();
}

/** Ridisegna le statistiche solo se e' cambiato qualcosa. */
function statisticheSeServe() {
  if (firmaStatisticheOra() === firmaStatistiche) return;
  renderStats();
}

const VIEW_ORDER = ['wizard', 'db', 'stats'];
let currentView = 'wizard';

function showView(name) {
  if (VIEW_ORDER.indexOf(name) === -1 || name === currentView) return;
  currentView = name;

  // Il contenuto della vista si costruisce PRIMA di muovere il binario.
  // Prima lo scorrimento partiva subito e poi la tabella dell'archivio
  // (oltre duecento righe) o i grafici delle statistiche bloccavano il
  // filo principale: misurato su una postazione lenta, un fotogramma da
  // 1133 ms in mezzo alla corsa. La vista scorreva mentre la si stava
  // ancora costruendo, e si vedeva. Facendolo prima, l'attesa e' tutta
  // all'inizio, ferma, e lo scorrimento poi e' pulito.
  if (name === 'stats') statisticheSeServe();
  if (name === 'db') archivioSeServe();

  // Quali sezioni animare si legge adesso, prima di toccare le classi
  // delle viste: dopo, ogni lettura costringerebbe il motore a rifare
  // subito l'impaginazione dell'intera pagina.
  const sezioni = sezioniVisibili(name);

  applyViewState();
  window.scrollTo(0, 0);
  applicaPop(sezioni);
  if (name === 'stats') avviaAnimazioniGrafici(true);
  if (name === 'db') animaArchivio();
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
    // Si può tornare indietro liberamente; andare avanti passa dalle
    // stesse convalide del pulsante Avanti.
    step.setAttribute('data-act', 'step');
    step.setAttribute('data-step', String(i));
    step.setAttribute('role', 'button');
    step.setAttribute('tabindex', '0');
    step.setAttribute('title', 'Passo ' + i + ' — ' + STEP_LABELS[i - 1]);
    if (i === currentStep) step.setAttribute('aria-disabled', 'true');
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
  const age = calcAge(val('w_dob'), val('w_data'));
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

/** Apre o chiude una sezione: la transizione (altezza, scivolamento,
 *  dissolvenza, 500 ms in entrambi i versi) è tutta nel CSS di
 *  .reveal-block, qui si cambia solo la classe. */
function mostraSezione(id, aperto) {
  const e = el(id);
  if (!e) return;
  if (aperto) {
    if (e.classList.contains('aperto')) return;
    e.classList.add('aperto');
  } else {
    e.classList.remove('aperto');
  }
}

function setOnco(v) {
  wOnco = v;
  toggleClass('tog_onco_si', 'toggle-item', v === 'si' ? ' active-yes' : '');
  toggleClass('tog_onco_sospetto', 'toggle-item', v === 'sospetto' ? ' active-inc' : '');
  // Il reperto sospetto colora la sezione di ambra come il suo toggle.
  // Chiudendo si lascia il colore com'è: la sezione si richiude con
  // quello, senza cambiare tinta a metà animazione.
  const sezione = el('oncoSection');
  if (sezione && v) {
    sezione.classList.toggle('esito-sospetto', v === 'sospetto');
    const titolo = sezione.querySelector('.onco-section-title');
    if (titolo) titolo.textContent = v === 'sospetto' ? 'Dettaglio reperto sospetto' : 'Dettaglio diagnosi';
  }
  mostraSezione('oncoSection', v === 'si' || v === 'sospetto');
  if (!v) { setClassTumore(null); setMetastasi(null); }
}

function setClassTumore(v) {
  wPrimo = (v === 'primo');
  toggleClass('tog_primo', 'toggle-item', wPrimo ? ' active-yes' : '');
  mostraSezione('sottoCategSection', wPrimo);
  if (!wPrimo) setSottocat(null);
}

function setSottocat(v) {
  wSottocat = v;
  ['unica', 'associata'].forEach((k) => {
    toggleClass('tog_' + k, 'toggle-item', v === k ? ' active-yes' : '');
  });
  mostraSezione('patAssocField', v === 'associata');
}

function setMetastasi(v) {
  wMetastasi = v;
  toggleClass('tog_meta_si', 'toggle-item', v === 'si' ? ' active-yes' : '');
  toggleClass('tog_meta_no', 'toggle-item', v === 'no' ? ' active-no' : '');
  mostraSezione('metaSection', v === 'si');
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
  const age = calcAge(dob, val('w_data'));

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
  ['oncoSection', 'sottoCategSection', 'patAssocField', 'metaSection']
    .forEach((id) => mostraSezione(id, false));
  editingId = null;
  aggiornaSelettoreTipo();
  modalitaTipoLibera(false);
  setOnco(null);
  fuItems = [];
  renderFUList();
  liveValidate1();
  liveValidate2();
  renderCronologia();
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

  aggiornaSelettoreTipo();
  modalitaTipoLibera(false);
  fuItems = r.followup.map((f) => ({ date: f.date, type: f.type, text: f.text }));
  renderFUList();
  setOnco(r.onco || null);
  setClassTumore(r.primo_riscontro ? 'primo' : null);
  setSottocat(r.sottocat || null);
  setMetastasi(r.metastasi || null);
  onNomeInput();
  updateAge();
  liveValidate2();
  renderCronologia();

  showView('wizard');
  goStep(1);
  notify('Esame caricato per la modifica.');
}

// ══════════════════════════════════════════════════════════════════
//  CRONOLOGIA DELLE RICHIESTE DEL PS
//  Le richieste già registrate diventano suggerimenti sotto il campo.
//  Un piccolo motore di parole chiave le confronta ignorando maiuscole,
//  accenti, punteggiatura, plurali e sinonimi clinici: "addominalgia" e
//  "dolori addominali" sono la stessa richiesta. Le richieste equivalenti
//  si raggruppano, e si ordinano per somiglianza con quanto si sta
//  scrivendo; a campo vuoto, per frequenza e recenza.
//  Nessun dato nuovo: tutto si ricava dall'archivio.
// ══════════════════════════════════════════════════════════════════
const CRONO_MAX = 12;          // suggerimenti a menu aperto
const CRONO_PER_CATEGORIA = 3;  // a campo vuoto, i più usati di ogni categoria
const CRONO_STATO_KEY = 'psonco-crono-aperta';

const PAROLE_VUOTE = new Set((
  'a ad al alla alle allo agli ai all che chi con col coi da dal dalla dalle dallo dai dagli ' +
  'dei del della delle dello degli di e ed gli i il in la le lo nei nel nella nelle negli o od ' +
  'per su sul sulla sulle sui tra fra un una uno si ha ho sono x pz pt paziente circa ecc riferito riferita'
).split(' '));

/** Concetti clinici: la prima voce è il nome mostrato, le altre sono
 *  modi diversi di scrivere la stessa cosa. */
const CONCETTI_RICHIESTA = [
  ['dolore addominale', 'addominalgia', 'dolore addome', 'algia addominale', 'dolenzia addominale', 'addome acuto'],
  ['dolore toracico', 'toracoalgia', 'dolore torace', 'dolore retrosternale'],
  ['dispnea', 'affanno', 'difficolta respiratoria', 'insufficienza respiratoria', 'desaturazione'],
  ['calo ponderale', 'dimagrimento', 'perdita di peso', 'calo di peso', 'perdita peso'],
  ['febbre', 'iperpiressia', 'piressia', 'febbricola', 'rialzo termico', 'febbre persistente'],
  ['cefalea', 'mal di testa', 'emicrania'],
  ['trauma', 'caduta', 'politrauma', 'incidente stradale', 'contusione'],
  ['ittero', 'subittero', 'iperbilirubinemia'],
  ['emottisi', 'sangue nell espettorato'],
  ['ematuria', 'sangue nelle urine'],
  ['colica renale', 'colica', 'idronefrosi', 'dolore lombare colico'],
  ['sanguinamento digestivo', 'melena', 'ematochezia', 'rettorragia', 'ematemesi'],
  ['tosse', 'tosse persistente', 'tosse secca'],
  ['massa palpabile', 'tumefazione', 'nodulo palpabile', 'neoformazione', 'massa'],
  ['anemia', 'anemizzazione', 'calo emoglobina', 'hb bassa'],
  ['deficit neurologico', 'deficit focale', 'ictus', 'stroke', 'afasia', 'emiparesi', 'stato confusionale'],
  ['vomito', 'emesi', 'nausea e vomito'],
  ['occlusione intestinale', 'subocclusione', 'alvo chiuso', 'stipsi ostinata'],
  ['astenia', 'stanchezza', 'spossatezza'],
  ['linfoadenopatia', 'adenopatia', 'linfonodi ingranditi', 'linfoadenomegalia'],
  ['versamento pleurico', 'versamento'],
  ['ascite', 'distensione addominale'],
  ['dolore osseo', 'lombalgia', 'rachialgia', 'dorsalgia'],
  ['crisi convulsiva', 'convulsioni', 'crisi epilettica'],
  ['sospetta neoplasia', 'sospetto tumore', 'sospetta lesione', 'lesione sospetta']
];

/** Categorie cliniche con l'esame TC generalmente richiesto. L'ordine
 *  conta: quando una richiesta tocca più categorie vince quella con più
 *  concetti e, a parità, la più specifica (un trauma prima di un sintomo
 *  sistemico). È un'indicazione orientativa, non una prescrizione: la
 *  scelta dell'esame resta del radiologo. */
const CATEGORIE_RICHIESTA = [
  { id: 'trauma', nome: 'Trauma', colore: '#8B1A1A', esami: ['TC total body'],
    concetti: ['trauma'] },
  { id: 'neuro', nome: 'Neurologico', colore: '#1A3F7A', esami: ['TC encefalo', 'TC encefalo senza mdc'],
    concetti: ['cefalea', 'deficit neurologico', 'crisi convulsiva'] },
  { id: 'torace', nome: 'Torace', colore: '#1A6040', esami: ['TC torace', 'TC torace con mdc'],
    concetti: ['dispnea', 'dolore toracico', 'emottisi', 'tosse', 'versamento pleurico'] },
  { id: 'addome', nome: 'Addome', colore: '#B86E00', esami: ['TC addome con mdc', 'TC addome'],
    concetti: ['dolore addominale', 'ittero', 'occlusione intestinale', 'ascite', 'sanguinamento digestivo', 'vomito'] },
  { id: 'uro', nome: 'Urologico', colore: '#6B1A7A', esami: ['Uro-TC', 'TC addome con mdc'],
    concetti: ['ematuria', 'colica renale'] },
  { id: 'osseo', nome: 'Muscoloscheletrico', colore: '#5A5850', esami: ['TC rachide', 'TC distrettuale'],
    concetti: ['dolore osseo'] },
  { id: 'sistemico', nome: 'Stadiazione / sistemico', colore: '#A82255', esami: ['TC total body'],
    concetti: ['calo ponderale', 'febbre', 'astenia', 'anemia', 'linfoadenopatia', 'sospetta neoplasia', 'massa palpabile'] }
];
const CATEGORIA_ALTRO = { id: 'altro', nome: 'Altre richieste', colore: '#8A8880', esami: [], concetti: [] };

/** Categoria prevalente fra i concetti riconosciuti. */
function categoriaDi(concetti) {
  let migliore = null, conta = 0;
  categorieEffettive().categorie.forEach((c) => {
    const n = concetti.filter((x) => c.concetti.indexOf(x) !== -1).length;
    if (n > conta) { migliore = c; conta = n; }
  });
  return migliore || CATEGORIA_ALTRO;
}

function normalizzaTesto(testo) {
  return String(testo == null ? '' : testo)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Radice grossolana: toglie le desinenze di genere e numero, così
 *  "addominale" e "addominali" coincidono. */
function radice(parola) {
  return parola.length > 4 ? parola.replace(/(zioni|zione|i|e|o|a)$/, '') : parola;
}

function paroleChiave(testo) {
  return normalizzaTesto(testo).split(' ').filter((p) => p && !PAROLE_VUOTE.has(p)).map(radice);
}

let cacheCategorie = { stamp: null, categorie: null, varianti: null };

/** Categorie e varianti effettive: le predefinite più quanto il reparto
 *  ha personalizzato (esame fisso, parole chiave aggiunte). Ricalcolate
 *  solo quando la personalizzazione cambia. */
function categorieEffettive() {
  const stamp = personalizzazione.updatedAt || 0;
  if (cacheCategorie.stamp === stamp && cacheCategorie.categorie) return cacheCategorie;

  const categorie = CATEGORIE_RICHIESTA.map((c) => {
    const fisso = personalizzazione.esamiCategoria[c.id] || '';
    const aggiunte = personalizzazione.parole.filter((p) => p.categoria === c.id).map((p) => p.testo);
    return Object.assign({}, c, {
      esameFisso: fisso,
      esami: fisso ? [fisso] : c.esami,
      concetti: c.concetti.concat(aggiunte)
    });
  });

  // ogni variante come sequenza di radici, dalla più lunga: "dolore
  // addominale" deve vincere su un eventuale "dolore" isolato
  const varianti = [];
  CONCETTI_RICHIESTA.forEach((voci) => {
    voci.forEach((v) => varianti.push({ nome: voci[0], parole: paroleChiave(v) }));
  });
  personalizzazione.parole.forEach((p) => varianti.push({ nome: p.testo, parole: paroleChiave(p.testo) }));
  varianti.sort((x, y) => y.parole.length - x.parole.length);

  cacheCategorie = { stamp: stamp, categorie: categorie, varianti: varianti };
  return cacheCategorie;
}

/** Concetti riconosciuti e parole rimaste, più una chiave che è uguale
 *  per due richieste equivalenti. */
function analizzaRichiesta(testo) {
  const parole = paroleChiave(testo);
  const usate = parole.map(() => false);
  const concetti = [];
  categorieEffettive().varianti.forEach((v) => {
    const n = v.parole.length;
    if (!n) return;
    for (let i = 0; i + n <= parole.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (usate[i + j] || parole[i + j] !== v.parole[j]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let j = 0; j < n; j++) usate[i + j] = true;
      if (concetti.indexOf(v.nome) === -1) concetti.push(v.nome);
    }
  });
  const termini = parole.filter((_p, i) => !usate[i]);
  // le stesse parole nella forma scritta, per mostrarle a chi configura
  const originali = normalizzaTesto(testo).split(' ').filter((p) => p && !PAROLE_VUOTE.has(p));
  const nonRiconosciute = originali.filter((p, i) => !usate[i] && p.length >= 3 && !/^[0-9]+$/.test(p));
  const normale = normalizzaTesto(testo);
  // l'ultima parola, se la si sta ancora scrivendo, vale anche come inizio
  const parziale = /[a-z0-9]$/i.test(String(testo || '')) && parole.length ? parole[parole.length - 1] : '';
  return {
    concetti: concetti,
    termini: termini,
    normale: normale,
    parziale: parziale,
    nonRiconosciute: nonRiconosciute,
    chiave: concetti.slice().sort().join('+') + '|' + termini.slice().sort().join('+')
  };
}

let indiceCrono = { firma: null, gruppi: [], df: new Map(), stat: {} };

/** Indice delle richieste in archivio, ricostruito solo quando cambia:
 *  gruppi di richieste equivalenti, frequenza delle parole e, per ogni
 *  categoria, quali tipi di esame sono stati eseguiti davvero. */
function indiceCronologia() {
  // Firma: numero di esami, ultima modifica e somma delle date di modifica.
  // Con le sole prime due, un'eliminazione e un arrivo remoto nello stesso
  // giro lasciavano l'indice vecchio.
  let ultimo = 0, somma = 0;
  DB.forEach((r) => {
    if (r.updatedAt > ultimo) ultimo = r.updatedAt;
    somma = (somma + (r.updatedAt % 1000000007)) % 9007199254740;
  });
  // anche la personalizzazione cambia categorie e concetti
  const firma = DB.length + ':' + ultimo + ':' + somma + ':' + (personalizzazione.updatedAt || 0);
  if (indiceCrono.firma === firma) return indiceCrono;

  const gruppi = new Map();
  const stat = {};
  DB.forEach((r) => {
    const testo = String(r.richiesta || '').trim();
    if (!testo) return;
    const an = analizzaRichiesta(testo);
    if (!an.concetti.length && !an.termini.length) return;
    let g = gruppi.get(an.chiave);
    if (!g) {
      g = { chiave: an.chiave, concetti: an.concetti, termini: an.termini, varianti: new Map(),
            conteggio: 0, ultima: 0, testo: testo, categoria: categoriaDi(an.concetti) };
      gruppi.set(an.chiave, g);
    }
    g.conteggio++;
    g.ultima = Math.max(g.ultima, r.updatedAt || 0);
    g.varianti.set(testo, (g.varianti.get(testo) || 0) + 1);

    // gli esami RMN già registrati non devono diventare l'esame proposto
    if (r.tipo_esame && !esameEscluso(r.tipo_esame)) {
      const s = stat[g.categoria.id] || (stat[g.categoria.id] = { tot: 0, tipi: new Map() });
      s.tot++;
      s.tipi.set(r.tipo_esame, (s.tipi.get(r.tipo_esame) || 0) + 1);
    }
  });

  const df = new Map();
  const lista = Array.from(gruppi.values());
  lista.forEach((g) => {
    // si propone la forma scritta più spesso
    let migliore = 0;
    g.varianti.forEach((n, t) => { if (n > migliore) { migliore = n; g.testo = t; } });
    g.normale = normalizzaTesto(g.testo);
    g.concetti.forEach((c) => df.set('c:' + c, (df.get('c:' + c) || 0) + 1));
    g.termini.forEach((t) => df.set('t:' + t, (df.get('t:' + t) || 0) + 1));
  });
  indiceCrono = { firma: firma, gruppi: lista, df: df, stat: stat };
  return indiceCrono;
}

/** Suggerimenti ordinati per somiglianza (le parole rare pesano di più).
 *  A campo vuoto: i più usati di ogni categoria. */
function suggerimentiRichiesta(testo) {
  const ind = indiceCronologia();
  const q = analizzaRichiesta(testo);
  const vuoto = !q.concetti.length && !q.termini.length;
  const peso = (f) => Math.log(1 + ind.gruppi.length / (1 + (ind.df.get(f) || 0)));
  const adesso = Date.now();

  let voci = [];
  ind.gruppi.forEach((g) => {
    if (!vuoto && g.normale === q.normale) return;      // è già quello che c'è scritto
    let punti = 0;
    if (vuoto) {
      punti = Math.log(1 + g.conteggio);
    } else {
      q.concetti.forEach((c) => { if (g.concetti.indexOf(c) !== -1) punti += 3 * peso('c:' + c); });
      q.termini.forEach((t) => {
        if (g.termini.indexOf(t) !== -1) {
          punti += peso('t:' + t);
        } else if (t === q.parziale && t.length >= 3) {
          const inizia = g.termini.some((x) => x.indexOf(t) === 0) ||
                         g.concetti.some((c) => normalizzaTesto(c).split(' ').some((p) => p.indexOf(t) === 0));
          if (inizia) punti += 0.6 * peso('t:' + t);
        }
      });
      // stessa categoria clinica senza parole in comune: vicina, ma dopo
      if (punti <= 0 && q.concetti.length && g.categoria === categoriaDi(q.concetti) && g.categoria !== CATEGORIA_ALTRO) {
        punti = 0.4;
      }
      if (punti <= 0) return;
      punti *= 1 + 0.15 * Math.log(1 + g.conteggio);
    }
    // recenza: fino a sei mesi pesa, poi non conta più
    const eta = adesso - (g.ultima || 0);
    punti += 0.3 * Math.max(0, 1 - eta / (180 * 86400000));
    voci.push({ g: g, punti: punti });
  });
  voci.sort((x, y) => y.punti - x.punti || y.g.conteggio - x.g.conteggio);

  if (vuoto) {
    const perCategoria = {};
    voci = voci.filter((v) => {
      const id = v.g.categoria.id;
      perCategoria[id] = (perCategoria[id] || 0) + 1;
      return perCategoria[id] <= CRONO_PER_CATEGORIA;
    });
  }
  return { analisi: q, vuoto: vuoto, voci: voci.slice(0, CRONO_MAX) };
}

/** Esame da proporre per una categoria: quello tipico, presente
 *  nell'elenco del reparto se c'è, e quello davvero più usato in
 *  archivio. Con almeno 5 casi e oltre metà delle richieste, vince
 *  l'archivio: riflette le abitudini reali del reparto. */
function esameConsigliato(categoria) {
  if (!categoria || !categoria.esami.length) return null;
  const tipi = tipiEsameCorrenti();
  const inElenco = (nome) => tipi.find((t) => normalizzaTesto(t) === normalizzaTesto(nome));
  const tipico = categoria.esami.map(inElenco).find(Boolean) || categoria.esami[0];

  let archivio = null;
  const s = indiceCronologia().stat[categoria.id];
  if (s && s.tot >= 5) {
    s.tipi.forEach((n, tipo) => { if (!archivio || n > archivio.n) archivio = { tipo: tipo, n: n }; });
    archivio.quota = archivio.n / s.tot;
    archivio.tot = s.tot;
    // un esame usato in meno del 40% dei casi non è un'abitudine del
    // reparto: mostrarlo confonderebbe più che aiutare
    if (archivio.quota < 0.4) archivio = null;
  }
  // l'esame fissato dal reparto vince su tutto, archivio compreso
  const scelto = categoria.esameFisso
    ? categoria.esameFisso
    : (archivio && archivio.quota >= 0.5 ? archivio.tipo : tipico);
  return { tipico: tipico, archivio: archivio, scelto: scelto, fisso: !!categoria.esameFisso };
}

function cronoAperta() {
  try { return localStorage.getItem(CRONO_STATO_KEY) === '1'; } catch (_) { return false; }
}

/** Apre o chiude il menu senza ridisegnarlo: così l'altezza si anima. */
function apriCronologia() {
  const aperta = !cronoAperta();
  try { localStorage.setItem(CRONO_STATO_KEY, aperta ? '1' : '0'); } catch (_) {}
  const corpo = el('cronoCorpo');
  const bottone = document.querySelector('.crono-apri');
  if (corpo) corpo.classList.toggle('aperto', aperta);
  if (bottone) bottone.setAttribute('aria-expanded', aperta ? 'true' : 'false');
  const box = el('richiestaCrono');
  if (box) box.classList.toggle('crono-aperta', aperta);
}

function etichettaCategoria(c) {
  return '<span class="crono-cat" style="--c:' + c.colore + '">' + esc(c.nome) + '</span>';
}

function chipRichiesta(v, classe) {
  return '<button type="button" class="crono-voce' + (classe ? ' ' + classe : '') +
    '" data-act="richiesta-usa" data-testo="' + esc(v.g.testo) + '" title="Usa questa richiesta">' +
    '<span class="crono-testo">' + esc(v.g.testo) + '</span>' +
    (v.g.conteggio > 1 ? '<span class="crono-n">×' + v.g.conteggio + '</span>' : '') +
    '</button>';
}

function renderCronologia() {
  const box = el('richiestaCrono');
  const campo = el('w_richiesta');
  if (!box || !campo) return;
  const s = suggerimentiRichiesta(campo.value);
  if (!s.voci.length && !s.analisi.concetti.length) { box.innerHTML = ''; return; }

  const aperta = cronoAperta();
  box.classList.toggle('crono-aperta', aperta);
  const n = s.voci.length;
  const conta = s.vuoto
    ? 'più usate'
    : (n ? n + (n === 1 ? ' simile' : ' simili') : 'nessuna simile');

  // esame suggerito per quanto è scritto nel campo
  const categoria = s.analisi.concetti.length ? categoriaDi(s.analisi.concetti) : null;
  const esame = esameConsigliato(categoria);
  const tipoAttuale = val('w_tipo_esame');
  let rigaEsame = '';
  if (esame) {
    const giaImpostato = normalizzaTesto(tipoAttuale) === normalizzaTesto(esame.scelto);
    rigaEsame = '<div class="crono-esame" title="Indicazione orientativa: la scelta dell’esame resta del radiologo">' +
      etichettaCategoria(categoria) +
      '<span>' + (esame.fisso ? 'esame del reparto' : 'esame tipico') + ' <b>' +
        esc(esame.fisso ? esame.scelto : esame.tipico) + '</b></span>' +
      (esame.archivio
        ? '<span class="crono-archivio">in archivio ' + esc(esame.archivio.tipo) + ' ' +
          pct(esame.archivio.n, esame.archivio.tot, 0) + ' su ' + esame.archivio.tot + '</span>'
        : '') +
      (giaImpostato
        ? '<span class="crono-ok">✓ impostato</span>'
        : '<button type="button" class="crono-imposta" data-act="crono-esame" data-tipo="' + esc(esame.scelto) +
          '">Imposta ' + esc(esame.scelto) + '</button>') +
      '</div>';
  }

  // suggerimenti raggruppati per categoria, nell'ordine del migliore
  const ordine = [];
  const perCat = new Map();
  s.voci.forEach((v) => {
    const c = v.g.categoria;
    if (!perCat.has(c)) { perCat.set(c, []); ordine.push(c); }
    perCat.get(c).push(v);
  });
  const gruppi = ordine.map((c) => {
    const e = esameConsigliato(c);
    return '<div class="crono-gruppo" style="--c:' + c.colore + '">' +
      '<div class="crono-gruppo-testa">' + etichettaCategoria(c) +
        (e ? '<span class="crono-gruppo-esame">' + esc(e.scelto) + '</span>' : '') + '</div>' +
      '<div class="crono-lista">' + perCat.get(c).map((v) => chipRichiesta(v)).join('') + '</div>' +
    '</div>';
  }).join('');

  box.innerHTML =
    '<div class="crono-testa">' +
      '<button type="button" class="crono-apri" data-act="crono-apri" aria-controls="cronoCorpo" aria-expanded="' +
        (aperta ? 'true' : 'false') + '">' +
        '<span class="crono-tit">Cronologia</span><span class="crono-conta">' + conta + '</span>' +
        '<span class="crono-freccia" aria-hidden="true">›</span>' +
      '</button>' +
      (s.analisi.concetti.length
        ? '<span class="crono-chiavi">' + s.analisi.concetti.map((c) => '<b>' + esc(c) + '</b>').join('') + '</span>'
        : '') +
      // a menu chiuso resta a portata di click la corrispondenza migliore
      (!s.vuoto && n ? '<span class="crono-rapida">' + chipRichiesta(s.voci[0], 'crono-migliore') + '</span>' : '') +
    '</div>' +
    rigaEsame +
    '<div class="crono-corpo' + (aperta ? ' aperto' : '') + '" id="cronoCorpo">' +
      '<div class="crono-interno">' +
        (gruppi || '<div class="crono-vuota">Nessuna richiesta simile in archivio.</div>') +
      '</div>' +
    '</div>';
}

/** Imposta il tipo di esame del passo 2: dall'elenco se c'è, altrimenti
 *  come testo libero. */
function impostaTipoEsame(tipo) {
  if (!tipo) return;
  const sel = el('w_tipo_sel');
  const campo = el('w_tipo_esame');
  const opzione = sel && Array.prototype.find.call(sel.options,
    (o) => o.value && normalizzaTesto(o.value) === normalizzaTesto(tipo));
  if (opzione) {
    modalitaTipoLibera(false);
    sel.value = opzione.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (campo) {
    modalitaTipoLibera(true);
    campo.value = tipo;
  }
  liveValidate2();
  renderCronologia();
  notify('Tipo di esame impostato: ' + tipo);
}

let timerCrono = null;
function pianificaCronologia() {
  clearTimeout(timerCrono);
  timerCrono = setTimeout(renderCronologia, 120);
}

function usaRichiesta(testo) {
  const campo = el('w_richiesta');
  if (!campo) return;
  campo.value = testo || '';
  liveValidate2();
  renderCronologia();
  campo.focus();
  campo.setSelectionRange(campo.value.length, campo.value.length);
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

  renderCronologia();
  setHtml('tipoEsameList', tipi.filter((t) => !esameEscluso(t)).map((t) => '<option value="' + esc(t) + '"></option>').join(''));
  setHtml('sedeList', sedi.map((s) => '<option value="' + esc(s) + '"></option>').join(''));
  setHtml('metaSedeList', metaSedi.map((s) => '<option value="' + esc(s) + '"></option>').join(''));

  setHtml('sediRapide', sedi.map((s) =>
    '<button type="button" class="sede-btn" data-act="pick" data-target="w_sede" data-value="' +
    esc(s) + '">' + esc(s) + '</button>').join(''));
  setHtml('metaSediRapide', metaSedi.map((s) =>
    '<button type="button" class="sede-btn sede-btn-meta" data-act="pick" data-target="w_meta_sede" data-value="' +
    esc(s) + '">' + esc(s) + '</button>').join(''));

  const fTipo = el('fTipo');
  if (fTipo) {
    fTipo.innerHTML = '<option value="">Tutti</option>' + optionsHtml(tipi, fTipo.value);
    refreshSelect('fTipo');
  }
  const sfTipo = el('sfTipo');
  if (sfTipo) {
    sfTipo.innerHTML = '<option value="">Tutti i tipi</option>' + optionsHtml(tipi, sfTipo.value);
    refreshSelect('sfTipo');
  }
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
    sMeta: DB.filter((r) => r.metastasi === 'si').length
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
  const fs = val('fSesso');
  const q = rawVal('fSearch').toLowerCase().trim();

  filtered = DB.filter((r) => {
    if (fo && r.onco !== fo) return false;
    if (fp && r.prima_onco !== fp) return false;
    if (ft && r.tipo_esame !== ft) return false;
    if (fct === 'primo' && !r.primo_riscontro) return false;
    if (fct === 'unica' && r.sottocat !== 'unica') return false;
    if (fct === 'associata' && r.sottocat !== 'associata') return false;
    if (fm && r.metastasi !== fm) return false;
    if (fs && r.sesso !== fs) return false;
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
  firmaArchivio = firmaArchivioOra();
}

function resetFilters() {
  ['fOnco', 'fPrima', 'fTipo', 'fClassTumore', 'fMeta', 'fSesso', 'fSearch'].forEach((id) => {
    const e = el(id);
    if (e) e.value = '';
  });
  // i menu personalizzati mostrano il valore del select nativo: vanno riallineati
  document.querySelectorAll('#view-db .sel-wrap').forEach((w) => syncSelect(w));
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

async function deleteSelected() {
  if (!selected.size) return;
  const ids = Array.from(selected);
  const n = ids.length;
  const ok = await conferma({
    tipo: 'pericolo',
    titolo: n === 1 ? 'Eliminare l’esame selezionato?' : 'Eliminare ' + n + ' esami selezionati?',
    messaggio: 'Gli esami spariscono dall’archivio condiviso, su entrambe le postazioni.',
    dettaglio: 'L’operazione non si può annullare.',
    conferma: n === 1 ? 'Elimina' : 'Elimina ' + n + ' esami'
  });
  if (!ok) return;
  markDeleted(ids);
  ids.forEach((id) => selected.delete(id));
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
      detRow('Data nascita / Età all\u2019esame', esc(fmtDate(r.dob)) + (age !== null ? ' (' + age + ' anni)' : '')) +
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
  apriOverlay(el('modDetail'));
}

async function deleteDetail() {
  const id = detailId;
  const r = id ? DB.find((p) => p.id === id) : null;
  if (!r) return;
  const paziente = (r.cognome + ' ' + r.nome).trim() || 'questo paziente';
  const ok = await conferma({
    tipo: 'pericolo',
    titolo: 'Eliminare definitivamente questo esame?',
    messaggio: paziente + (r.data ? ' · esame del ' + fmtDate(r.data) : '') + (r.tipo_esame ? ' · ' + r.tipo_esame : ''),
    dettaglio: 'L’esame sparisce dall’archivio condiviso, su entrambe le postazioni. L’operazione non si può annullare.',
    conferma: 'Elimina esame'
  });
  if (!ok) return;
  markDeleted([id]);
  selected.delete(id);
  if (detailId === id) detailId = null;
  scheduleSave();
  refreshViews();
  closeOverlay('modDetail');
  notify('Esame eliminato.');
}

function openAddFU(id) {
  fuTargetId = id;
  ['mfuDate', 'mfuText', 'mfuType'].forEach((k) => setFieldValue(el(k), ''));
  apriOverlay(el('modFU'));
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
    'Sesso', 'Data nascita', 'Età all\u2019esame', 'Data esame', 'Tipo esame', 'Richiesta PS',
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
    ['Primo riscontro', primo, pct(primo, onco + sosp, 1) + ' delle diagnosi onco.'],
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
    // Fuori dal documento il testo SVG non eredita il font della pagina
    // e finirebbe in un serif di sistema.
    clone.setAttribute('font-family', "'IBM Plex Sans','Segoe UI',Arial,sans-serif");

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

/** Periodo e filtri attivi, in chiaro: intestano report e presentazione. */
function descriviFiltri() {
  const dal = val('sfDal'), al = val('sfAl'), tipo = val('sfTipo');
  const periodo = (dal || al)
    ? 'Periodo ' + (dal ? fmtDate(dal) : 'inizio') + ' – ' + (al ? fmtDate(al) : 'oggi')
    : 'Archivio completo';
  const filtri = [];
  if (tipo) filtri.push(tipo);
  const focus = el('sfFocus');
  if (focus && focus.value !== 'all' && focus.selectedOptions[0]) {
    filtri.push(focus.selectedOptions[0].textContent.trim());
  }
  return {
    periodo: periodo,
    filtri: filtri.join(' · '),
    contesto: periodo + (filtri.length ? ' · ' + filtri.join(' · ') : ''),
    generato: new Date().toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' })
  };
}

/** Indicatori del periodo, gli stessi delle schede a schermo. */
function kpiPeriodo(set) {
  const conta = (f) => set.filter(f).length;
  return {
    tot: set.length,
    onco: conta((r) => r.onco === 'si'),
    sosp: conta((r) => r.onco === 'sospetto'),
    prima: conta((r) => r.onco === 'si' && r.prima_onco === 'si'),
    primo: conta((r) => r.primo_riscontro),
    meta: conta((r) => r.metastasi === 'si'),
    unica: conta((r) => r.sottocat === 'unica'),
    assoc: conta((r) => r.sottocat === 'associata')
  };
}

/** Denominatore di "% delle diagnosi onco.". Primo riscontro e metastasi
 *  si possono indicare sia su una diagnosi sia su un reperto sospetto:
 *  il loro insieme di partenza è oncologici + sospetti. Rapportarli ai
 *  soli oncologici gonfiava la percentuale e poteva superare il 100%. */
function baseDiagnosi(k) {
  return k.onco + k.sosp;
}

/** Spicchi della ciambella: si escludono a vicenda, quindi sommano al
 *  totale degli esami. Prima c'erano anche primo riscontro e metastasi,
 *  che sono sottoinsiemi delle diagnosi: il centro diceva 287 su 210. */
function segmentiDistribuzione(k) {
  return [
    { key: 'neg', label: 'Esami negativi', corto: 'negativi', value: Math.max(0, k.tot - k.onco - k.sosp), color: '#C8C6BE' },
    { key: 'onco', label: 'Diagnosi oncologiche', corto: 'oncologici', value: k.onco, color: '#6B1A7A' },
    { key: 'sosp', label: 'Sospetti', corto: 'sospetti', value: k.sosp, color: '#E8A020' }
  ].filter((s) => s.value > 0);
}

/** Sottoinsiemi delle diagnosi oncologiche, mostrati in legenda. */
function sottoinsiemiDistribuzione(k) {
  return [
    { key: 'primo', alias: 'onco', label: 'Primo riscontro', corto: 'primo risc.', value: k.primo, color: '#C2185B' },
    { key: 'meta', alias: 'onco', label: 'Metastasi', corto: 'metastasi', value: k.meta, color: '#8B1A1A' }
  ].filter((s) => s.value > 0);
}

/** Presentazione 16:9: copertina, indicatori, un grafico per diapositiva
 *  con legenda e lettura del dato, tabelle, note di metodo. */
async function exportPPTX() {
  const set = getStatsSubset();
  if (!set.length) { notify('Nessun esame nel periodo selezionato.'); return; }
  if (!IS_ELECTRON) { notify('Export disponibile solo nell’applicazione desktop.'); return; }

  try {
    const P = window.PptxWriter;
    const k = kpiPeriodo(set);
    const f = descriviFiltri();
    const piede = 'ER Oncology Archivist · Report statistico · ' + f.contesto;
    const nota = (chiave) => testoNota(chiave, set).testo;
    const hex = (c) => c.replace('#', '').toUpperCase();

    // I grafici SVG della vista statistiche diventano PNG. La legenda
    // non si rasterizza: in diapositiva è disegnata come testo vero.
    const grafici = {};
    const sorgenti = { donut: 'svgDonut', sede: 'svgBarseSede', mensile: 'svgMensile' };
    const chiavi = Object.keys(sorgenti);
    for (let i = 0; i < chiavi.length; i++) {
      const svg = document.querySelector('#' + sorgenti[chiavi[i]] + ' svg');
      if (!svg) continue;
      try {
        const g = await svgToPng(svg, 3);
        grafici[chiavi[i]] = { png: base64ToBytes(g.dataUrl.split(',')[1]), w: g.w, h: g.h };
      } catch (_) { /* grafico saltato */ }
    }

    const dia = [];

    dia.push({
      tipo: 'copertina',
      etichetta: 'Report statistico',
      titolo: 'Pronto Soccorso Oncologico',
      righe: ['Radiologia d’Urgenza · ' + f.contesto, k.tot + ' esami analizzati'],
      piede: 'Generato il ' + f.generato + ' con ER Oncology Archivist · Documento a uso interno'
    });

    dia.push({
      titolo: 'Sintesi del periodo',
      sottotitolo: f.contesto,
      piede: piede,
      kpi: [
        { valore: k.tot, etichetta: 'Esami nel periodo',
          nota: 'Base di calcolo di tutte le percentuali', colore: '18170F' },
        { valore: k.onco, etichetta: 'Diagnosi oncologiche',
          nota: pct(k.onco, k.tot, 1) + ' degli esami', colore: '6B1A7A' },
        { valore: k.sosp, etichetta: 'Sospetti',
          nota: pct(k.sosp, k.tot, 1) + ' degli esami', colore: 'B86E00' },
        { valore: k.primo, etichetta: 'Primo riscontro',
          nota: pct(k.primo, baseDiagnosi(k), 1) + ' delle diagnosi · unica patologia ' + k.unica +
                ', associata ' + k.assoc, colore: 'C2185B' },
        { valore: k.prima, etichetta: 'Prime diagnosi',
          nota: pct(k.prima, k.tot, 1) + ' degli esami', colore: 'A82255' },
        { valore: k.meta, etichetta: 'Metastasi',
          nota: pct(k.meta, baseDiagnosi(k), 1) + ' delle diagnosi oncologiche', colore: '8B1A1A' }
      ]
    });

    if (grafici.donut) {
      const seg = segmentiDistribuzione(k);
      const somma = seg.reduce((s, x) => s + x.value, 0) || 1;
      dia.push({
        titolo: 'Distribuzione degli esami',
        sottotitolo: 'Esito diagnostico degli esami del periodo',
        grafico: grafici.donut,
        legenda: seg.map((s) => ({
          colore: hex(s.color), etichetta: s.label,
          valore: s.value + '  ·  ' + Math.round(s.value / somma * 100) + '%'
        })).concat(sottoinsiemiDistribuzione(k).map((s) => ({
          colore: hex(s.color), etichetta: 'di cui ' + s.label.toLowerCase(),
          valore: s.value + '  ·  ' + Math.round(s.value / somma * 100) + '%'
        }))),
        didascalia: nota('donut'),
        piede: piede
      });
    }

    if (grafici.sede) {
      dia.push({
        titolo: 'Diagnosi per sede / organo',
        sottotitolo: 'Le dieci sedi più rappresentate fra i casi oncologici o sospetti',
        grafico: grafici.sede,
        legendaSotto: true,
        legenda: [{ colore: '6B1A7A', etichetta: 'Casi oncologici o sospetti' },
                  { colore: '8B1A1A', etichetta: 'di cui con metastasi' }],
        didascalia: nota('sede'),
        piede: piede
      });
    }

    if (grafici.mensile) {
      dia.push({
        titolo: 'Andamento mensile',
        sottotitolo: 'Esami totali, casi oncologici o sospetti e quota percentuale per mese',
        grafico: grafici.mensile,
        legendaSotto: true,
        legenda: [{ colore: 'C8C6BE', etichetta: 'Totale esami' },
                  { colore: '6B1A7A', etichetta: 'Oncologici o sospetti' },
                  { colore: 'E8A020', etichetta: 'Quota oncologica (linea)' }],
        didascalia: nota('mensile'),
        piede: piede
      });
    }

    const ct = conteggiTipo(set);
    const tipi = Object.keys(ct.tot).sort((a, b) => ct.tot[b] - ct.tot[a]).slice(0, 10);
    if (tipi.length) {
      dia.push({
        titolo: 'Resa oncologica per tipo di esame',
        sottotitolo: 'Esami eseguiti e quota con esito oncologico o sospetto',
        tabella: {
          intestazioni: ['Tipo di esame', 'Esami', 'Oncologici o sospetti', 'Resa'],
          righe: tipi.map((t) => [t, String(ct.tot[t]), String(ct.onco[t] || 0),
                                  pct(ct.onco[t] || 0, ct.tot[t], 1)])
        },
        didascalia: nota('heatmap'),
        piede: piede
      });
    }

    const cs = conteggiSede(set);
    if (cs.ordinate.length) {
      const prime = {};
      set.filter((r) => (r.onco === 'si' || r.onco === 'sospetto') && r.sede && r.prima_onco === 'si')
        .forEach((r) => { prime[r.sede] = (prime[r.sede] || 0) + 1; });
      dia.push({
        titolo: 'Prevalenza per sede',
        sottotitolo: 'Percentuale sul totale delle diagnosi oncologiche o sospette',
        tabella: {
          intestazioni: ['Sede', 'Casi', 'Prime diagnosi', 'Metastasi', '% sul totale'],
          righe: cs.ordinate.slice(0, 10).map((e) => [
            e[0], String(e[1]), String(prime[e[0]] || 0), String(cs.meta[e[0]] || 0),
            pct(e[1], k.onco + k.sosp, 1)])
        },
        didascalia: nota('tabSede'),
        piede: piede
      });
    }

    dia.push({
      tipo: 'copertina',
      etichetta: 'Note di metodo',
      titolo: 'Come leggere i dati',
      righe: [
        'Le percentuali degli esami sono calcolate sul totale del periodo; quelle di sede sulle diagnosi oncologiche o sospette.',
        'Le didascalie sono generate automaticamente dai numeri del periodo; quelle corrette a mano sono riportate come revisionate.',
        'Filtri applicati: ' + f.contesto + '.'
      ],
      piede: 'ER Oncology Archivist · Documento a uso interno, contiene dati clinici aggregati'
    });

    const file = P.build(dia);
    const ok = await sendFile('ps_onco_presentazione.pptx', window.ZipWriter.toBase64(file));
    if (ok) notify('Presentazione esportata (' + dia.length + ' diapositive).');
  } catch (e) {
    notify('Errore export PowerPoint: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
//  REPORT PDF (printToPDF di Electron: nessuna libreria esterna)
//  A4 orizzontale: copertina con indicatori, poi una sezione per
//  pagina, ognuna con la sua lettura del dato sotto al grafico.
// ══════════════════════════════════════════════════════════════════
function cloneChart(id) {
  const source = el(id);
  if (!source) return '';
  const clone = source.cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.remove('anima', 'ha-scelta');
  clone.querySelectorAll('.scelto').forEach((n) => n.classList.remove('scelto'));
  // Sfumature, maschere e filtri sono richiamati per id: toglierli
  // spegnerebbe il grafico nel report, duplicarli confonderebbe i
  // riferimenti. Si rinominano insieme a ogni url(#...) che li cita.
  const mappa = {};
  clone.querySelectorAll('[id]').forEach((n) => { mappa[n.id] = n.id + '-rep'; n.id = mappa[n.id]; });
  clone.querySelectorAll('*').forEach((n) => {
    ['fill', 'stroke', 'mask', 'filter', 'clip-path'].forEach((a) => {
      const v = n.getAttribute(a);
      if (!v || v.indexOf('url(#') !== 0) return;
      const rif = v.slice(5, -1);
      if (mappa[rif]) n.setAttribute(a, 'url(#' + mappa[rif] + ')');
    });
  });
  const box = document.createElement('div');
  box.appendChild(clone);
  return box.innerHTML;
}

/** Riquadro "Lettura del dato": la descrizione generata (o corretta). */
function notaReport(chiave, set) {
  const n = testoNota(chiave, set);
  if (!n.testo) return '';
  return '<div class="rep-lettura"><div class="rep-lettura-tit">Lettura del dato' +
    (n.manuale ? ' · revisionata' : '') + '</div><p>' + esc(n.testo) + '</p></div>';
}

function legendaReport(voci) {
  return '<div class="rep-legenda">' + voci.map((v) =>
    '<span><i class="' + (v[2] || '') + '" style="' + (v[0] ? 'background:' + v[0] : '') + '"></i>' +
    esc(v[1]) + '</span>').join('') + '</div>';
}

function buildReport(set) {
  const k = kpiPeriodo(set);
  const f = descriviFiltri();

  const kpi = [
    ['Esami nel periodo', k.tot, 'base di tutte le percentuali', '#18170F'],
    ['Diagnosi oncologiche', k.onco, pct(k.onco, k.tot, 1) + ' degli esami', '#6B1A7A'],
    ['Sospetti', k.sosp, pct(k.sosp, k.tot, 1) + ' degli esami', '#B86E00'],
    ['Primo riscontro', k.primo, pct(k.primo, k.onco, 1) + ' delle diagnosi · unica ' +
      k.unica + ', associata ' + k.assoc, '#C2185B'],
    ['Prime diagnosi', k.prima, pct(k.prima, k.tot, 1) + ' degli esami', '#A82255'],
    ['Metastasi', k.meta, pct(k.meta, k.onco, 1) + ' delle diagnosi onco.', '#8B1A1A']
  ];

  const sezione = (n, titolo, sotto) =>
    '<section class="rep-page">' +
    '<div class="rep-testata"><b>ER Oncology Archivist</b><span>' + esc(f.contesto) + '</span></div>' +
    '<div class="rep-sezione"><span class="n">' + n + '</span><h2>' + esc(titolo) + '</h2>' +
    (sotto ? '<p>' + esc(sotto) + '</p>' : '') + '</div>';

  const tabellaSede = document.querySelector('#tableSedeWrap table');

  // 01 — copertina, indicatori, distribuzione e sedi
  let html = '<section class="rep-page">' +
    '<div class="rep-copertina"><div>' +
      '<div class="rep-etichetta">Report statistico</div>' +
      '<h1>Pronto Soccorso Oncologico</h1>' +
      '<div class="rep-copertina-sub">Radiologia d’Urgenza · ' + esc(f.contesto) + '</div>' +
    '</div><div class="rep-copertina-dx"><strong>' + k.tot + '</strong>esami analizzati<br>' +
      'Generato il ' + esc(f.generato) + '</div></div>' +
    '<div class="rep-kpis">' + kpi.map((x) =>
      '<div class="rep-kpi" style="--k:' + x[3] + '"><div class="rep-kpi-n">' + esc(x[1]) + '</div>' +
      '<div class="rep-kpi-l">' + esc(x[0]) + '</div>' +
      '<div class="rep-kpi-p">' + esc(x[2]) + '</div></div>').join('') + '</div>' +
    '<div class="rep-due">' +
      '<div class="rep-blocco"><h3>Distribuzione generale</h3>' +
        '<div class="rep-grafico rep-donut">' + cloneChart('svgDonut') + '</div>' +
        notaReport('donut', set) + '</div>' +
      '<div class="rep-blocco"><h3>Diagnosi per sede / organo</h3>' +
        '<div class="rep-grafico">' + cloneChart('svgBarseSede') + '</div>' +
        legendaReport([['#6B1A7A', 'Casi oncologici o sospetti'], ['#8B1A1A', 'di cui con metastasi']]) +
        notaReport('sede', set) + '</div>' +
    '</div></section>';

  // 02 — andamento nel tempo
  html += sezione('02', 'Andamento mensile',
      'Esami totali, casi oncologici o sospetti e quota percentuale per mese') +
    '<div class="rep-blocco"><div class="rep-grafico rep-grafico-largo">' + cloneChart('svgMensile') + '</div>' +
    legendaReport([['#C8C6BE', 'Totale esami'], ['#6B1A7A', 'Oncologici o sospetti'],
                   ['#E8A020', 'Quota oncologica (linea)']]) +
    notaReport('mensile', set) + '</div></section>';

  // 03 — resa per tipo di esame
  html += sezione('03', 'Resa per tipo di esame',
      'Esami per mese e tipo; fra parentesi i casi oncologici o sospetti, il colore indica la quota') +
    '<div class="rep-blocco rep-blocco-lungo"><div class="rep-tabella rep-heatmap">' +
      cloneChart('svgHeatmap') + '</div>' +
    legendaReport([['', '0%', 'hm-0 hm-legend'], ['', 'meno del 10%', 'hm-1'], ['', '10–29%', 'hm-2'],
                   ['', '30–49%', 'hm-3'], ['', '50% e oltre', 'hm-4']]) +
    notaReport('heatmap', set) + '</div></section>';

  // 04 — prevalenza per sede
  html += sezione('04', 'Prevalenza per sede',
      'Percentuale sul totale delle diagnosi oncologiche o sospette') +
    '<div class="rep-blocco rep-blocco-lungo"><div class="rep-tabella zebra">' +
      (tabellaSede ? tabellaSede.outerHTML.replace('data-table tab-graf', 'data-table') : '') + '</div>' +
    notaReport('tabSede', set) + '</div></section>';

  // 05 — dettaglio mensile
  html += sezione('05', 'Dettaglio mensile per tipo di esame',
      'Quota = casi oncologici o sospetti sul totale del mese') +
    '<div class="rep-blocco rep-blocco-lungo"><div class="rep-tabella zebra">' +
      tabellaMensileHtml() + '</div>' +
    notaReport('tabMensile', set) + '</div></section>';

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
  const set = getStatsSubset();
  if (!set.length) { notify('Nessun esame nel periodo selezionato.'); return; }
  const root = el('printRoot');
  if (!root) return;
  root.innerHTML = buildReport(set);
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

// ══════════════════════════════════════════════════════════════════
//  GRAFICI SVG — animati e interattivi
//
//  Ogni segno (spicchio, barra, mese, cella) porta data-graf e data-k:
//  al passaggio del puntatore compare un'etichetta, il click lo
//  seleziona e apre sotto al grafico una spiegazione generata dai
//  numeri del periodo. Un secondo click sullo stesso segno la richiude.
//
//  Le animazioni vivono nel CSS sotto la classe .anima del contenitore,
//  che avviaAnimazioniGrafici() aggiunge dopo il pop delle schede. Senza
//  quella classe (stampa, PNG della presentazione) ogni grafico è già
//  nel suo stato finale: nessun keyframe definisce lo stato di arrivo.
// ══════════════════════════════════════════════════════════════════
function svgDefs(svg, figli) {
  svg.appendChild(svgEl('defs', {}, figli));
}

/** Sfumatura lineare: stops = [[offset, colore, opacità], ...] */
function sfumatura(id, x2, y2, stops) {
  return svgEl('linearGradient', { id: id, x1: 0, y1: 0, x2: x2, y2: y2 },
    stops.map((s) => svgEl('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] })));
}

/** Duotone: metà chiara e metà piena, con il taglio netto a metà. */
function duotone(id, colore, verticale) {
  return sfumatura(id, verticale ? 0 : 1, verticale ? 1 : 0,
    [['50%', colore, 0.42], ['50%', colore, 1]]);
}

/** Alone morbido: la sagoma sopra una sua copia sfocata. */
function alone(id, deviazione) {
  return svgEl('filter', { id: id, x: '-20%', y: '-40%', width: '140%', height: '180%' }, [
    svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: deviazione, result: 'sfocato' }),
    svgEl('feMerge', {}, [svgEl('feMergeNode', { in: 'sfocato' }), svgEl('feMergeNode', { in: 'SourceGraphic' })])
  ]);
}

/** Rende un elemento (SVG o HTML) un segno cliccabile del grafico. */
function marcaGrafico(e, graf, k, titolo, valore, indice) {
  e.setAttribute('data-act', 'grafico');
  e.setAttribute('data-graf', graf);
  e.setAttribute('data-k', k);
  e.setAttribute('data-tip', titolo);
  e.setAttribute('data-tip2', valore);
  e.setAttribute('tabindex', '0');
  e.setAttribute('role', 'button');
  e.setAttribute('aria-pressed', 'false');
  e.setAttribute('aria-label', titolo + ': ' + valore);
  if (indice != null) e.style.setProperty('--i', String(indice));
  return e;
}

const r2 = (v) => Math.round(v * 100) / 100;

/** Colore mescolato col bianco. La sfumatura degli spicchi deve restare
 *  opaca: con l'opacità il bordo smussato, che si sovrappone al
 *  riempimento, si vedeva come una seconda banda più scura. */
function schiarisci(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0');
  return '#' + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
}

// ── Ciambella ──────────────────────────────────────────────────────
// Spicchi separati da un piccolo spazio e con gli angoli smussati, su
// sfumatura verticale e con ombra, come nel riferimento. Si apre con un
// giro completo: una maschera circolare che si srotola in senso orario.
function drawDonut(containerId, segments, centerLabel, sottoinsiemi) {
  const box = el(containerId);
  if (!box) return;
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) { chartEmpty(box, 'Nessun dato.'); return; }

  const W = 220, c = W / 2, R = 94, ri = 64, ARR = 5;
  const svg = svgEl('svg', {
    viewBox: '0 0 ' + W + ' ' + W, width: W, height: W,
    class: 'graf-donut', 'data-n': total, 'data-l': centerLabel || 'totale'
  });
  svgDefs(svg, [
    svgEl('filter', { id: 'gd-ombra', x: '-25%', y: '-25%', width: '150%', height: '160%' }, [
      svgEl('feDropShadow', { dx: 0, dy: 6, stdDeviation: 5, 'flood-color': '#18170F', 'flood-opacity': 0.16 })
    ]),
    svgEl('mask', { id: 'gd-maschera', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: W }, [
      svgEl('circle', {
        class: 'graf-sweep', cx: c, cy: c, r: (R + ri) / 2, fill: 'none', stroke: '#fff',
        'stroke-width': R - ri + 34, pathLength: 1, 'stroke-dasharray': '1 1',
        transform: 'rotate(-90 ' + c + ' ' + c + ')'
      })
    ])
  ].concat(segments.map((s, i) => sfumatura('gd-f' + i, 0, 1, [['0%', s.color, 1], ['100%', schiarisci(s.color, 0.2), 1]]))));

  const gruppo = svgEl('g', { mask: 'url(#gd-maschera)', filter: 'url(#gd-ombra)' });
  const pt = (r, a) => r2(c + r * Math.cos(a)) + ' ' + r2(c + r * Math.sin(a));
  const PAD = segments.length > 1 ? 0.05 : 0;
  let a = -Math.PI / 2;

  segments.forEach((seg, i) => {
    const sweep = seg.value / total * 2 * Math.PI;
    const a0 = a + PAD / 2, a1 = a + sweep - PAD / 2;
    const mezzo = (a0 + a1) / 2;
    a += sweep;
    const g = marcaGrafico(svgEl('g', { class: 'graf-seg' }), 'donut', seg.key, seg.label,
      seg.value + ' esami · ' + pct(seg.value, total, 1), i);
    g.style.setProperty('--dx', r2(Math.cos(mezzo) * 6) + 'px');
    g.style.setProperty('--dy', r2(Math.sin(mezzo) * 6) + 'px');

    if (segments.length === 1) {
      g.appendChild(svgEl('circle', { cx: c, cy: c, r: (R + ri) / 2, fill: 'none',
        stroke: 'url(#gd-f' + i + ')', 'stroke-width': R - ri }));
    } else {
      // Sagoma rimpicciolita di ARR su ogni lato e ripassata con un tratto
      // largo 2*ARR a giunti tondi: torna alla misura piena, smussata.
      const ro = R - ARR, rin = ri + ARR;
      const da = ARR / ((ro + rin) / 2);
      const b0 = a0 + da;
      const b1 = Math.max(b0 + 0.002, a1 - da);
      const grande = (b1 - b0) > Math.PI ? 1 : 0;
      const d = 'M ' + pt(ro, b0) + ' A ' + ro + ' ' + ro + ' 0 ' + grande + ' 1 ' + pt(ro, b1) +
        ' L ' + pt(rin, b1) + ' A ' + rin + ' ' + rin + ' 0 ' + grande + ' 0 ' + pt(rin, b0) + ' Z';
      g.appendChild(svgEl('path', {
        d: d, fill: 'url(#gd-f' + i + ')', stroke: 'url(#gd-f' + i + ')',
        'stroke-width': ARR * 2, 'stroke-linejoin': 'round'
      }));
    }
    gruppo.appendChild(g);
  });
  svg.appendChild(gruppo);

  svg.appendChild(svgEl('text', {
    class: 'graf-centro-n', x: c, y: c + 4, 'text-anchor': 'middle', 'font-size': 30,
    'font-weight': 600, fill: '#18170F', 'font-family': 'IBM Plex Mono,monospace'
  }, [String(total)]));
  svg.appendChild(svgEl('text', {
    class: 'graf-centro-l', x: c, y: c + 24, 'text-anchor': 'middle', 'font-size': 11, fill: '#6B6A62'
  }, [centerLabel || 'totale']));

  // Legenda HTML: ogni riga è cliccabile quanto lo spicchio.
  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  const riga = (s, i, sotto) => {
    const row = document.createElement('div');
    row.className = 'dl-row' + (sotto ? ' dl-sub' : '');
    marcaGrafico(row, 'donut', s.key, s.label, s.value + ' esami · ' + pct(s.value, total, 1), i);
    row.setAttribute('data-v', String(s.value));
    row.setAttribute('data-corto', s.corto || s.label);
    if (s.alias) row.setAttribute('data-alias', s.alias);
    const dot = document.createElement('div');
    dot.className = 'dl-dot' + (sotto ? ' dl-anello' : '');
    if (sotto) dot.style.borderColor = s.color; else dot.style.background = s.color;
    const txt = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'dl-label';
    lbl.textContent = (sotto ? 'di cui ' + s.label.toLowerCase() : s.label);
    const num = document.createElement('div');
    num.className = 'dl-num';
    num.textContent = s.value + ' — ' + pct(s.value, total, 1);
    num.style.color = s.color;
    txt.appendChild(lbl);
    txt.appendChild(num);
    row.appendChild(dot);
    row.appendChild(txt);
    legend.appendChild(row);
  };
  segments.forEach((s, i) => riga(s, i, false));
  (sottoinsiemi || []).forEach((s, i) => riga(s, segments.length + i, true));

  box.textContent = '';
  box.appendChild(svg);
  box.appendChild(legend);
}

/** Al centro della ciambella il valore dello spicchio scelto. */
function aggiornaCentroDonut(box, k) {
  const svg = box.querySelector('svg.graf-donut');
  if (!svg) return;
  const n = svg.querySelector('.graf-centro-n');
  const l = svg.querySelector('.graf-centro-l');
  let valore = svg.getAttribute('data-n');
  let etichetta = svg.getAttribute('data-l');
  if (k !== null) {
    const voce = Array.prototype.find.call(box.querySelectorAll('.dl-row'),
      (e) => e.getAttribute('data-k') === k);
    if (voce) { valore = voce.getAttribute('data-v'); etichetta = voce.getAttribute('data-corto'); }
  }
  if (n) n.textContent = valore;
  if (l) l.textContent = etichetta;
}

// ── Barre orizzontali (sedi) ───────────────────────────────────────
function drawHBars(containerId, items) {
  const box = el(containerId);
  if (!box) return;
  if (!items.length) { chartEmpty(box, 'Nessuna diagnosi oncologica nel periodo.'); return; }

  const W = 540, ROW_H = 32, PAD_L = 120, PAD_R = 96, PAD_T = 6, BAR_H = 18;
  const H = PAD_T * 2 + ROW_H * items.length;
  const maxVal = Math.max.apply(null, items.map((i) => i.value).concat([1]));
  const TW = W - PAD_L - PAD_R;
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', class: 'graf-barre',
    style: 'max-width:' + W + 'px;' });
  svgDefs(svg, [duotone('gs-onco', '#6B1A7A', true), duotone('gs-meta', '#8B1A1A', true)]);

  [0.25, 0.5, 0.75, 1].forEach((f) => {
    const x = PAD_L + TW * f;
    svg.appendChild(svgEl('line', { x1: x, y1: PAD_T, x2: x, y2: H - PAD_T,
      stroke: '#E0DED7', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
  });

  items.forEach((item, i) => {
    const y = PAD_T + i * ROW_H;
    const by = y + (ROW_H - BAR_H) / 2;
    const bw = Math.max(3, Math.round(item.value / maxVal * TW));
    const bw2 = item.value2 ? Math.max(3, Math.round(item.value2 / maxVal * TW)) : 0;
    const g = marcaGrafico(svgEl('g', { class: 'graf-riga' }), 'sede', item.label, item.label,
      item.value + ' casi · ' + item.pct + (item.value2 ? ' · ' + item.value2 + ' con metastasi' : ''), i);
    g.appendChild(svgEl('rect', { class: 'graf-fondo', x: 0, y: y + 1, width: W, height: ROW_H - 2,
      rx: 7, fill: '#A82255', 'fill-opacity': 0 }));
    g.appendChild(svgEl('rect', { class: 'graf-barra-x', x: PAD_L, y: by, width: bw, height: BAR_H,
      rx: 5, fill: 'url(#gs-onco)' }));
    if (bw2) {
      g.appendChild(svgEl('rect', { class: 'graf-barra-x', x: PAD_L, y: by, width: bw2, height: BAR_H,
        rx: 5, fill: 'url(#gs-meta)' }));
    }
    const corto = item.label.length > 17 ? item.label.slice(0, 16) + '…' : item.label;
    g.appendChild(svgEl('text', { class: 'graf-etichetta', x: PAD_L - 10, y: y + ROW_H / 2 + 4,
      'text-anchor': 'end', 'font-size': 11.5, fill: '#18170F' }, [corto]));
    g.appendChild(svgEl('text', { class: 'graf-valore', x: PAD_L + TW + 10, y: y + ROW_H / 2 + 4,
      'font-size': 11, fill: '#6B6A62', 'font-family': 'IBM Plex Mono,monospace' },
      [item.value + (item.pct ? ' (' + item.pct + ')' : '')]));
    svg.appendChild(g);
  });

  box.textContent = '';
  box.appendChild(svg);
}

// ── Andamento mensile ──────────────────────────────────────────────
/** Curva monotona (Fritsch–Carlson): morbida come la "natural" del
 *  riferimento, ma senza uscire sopra il 100% o sotto lo 0%. */
function curvaMonotona(p) {
  const n = p.length;
  if (n < 2) return n ? 'M' + p[0].x + ',' + p[0].y : '';
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1].x - p[i].x;
    m[i] = (p[i + 1].y - p[i].y) / dx[i];
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = 'M' + r2(p[0].x) + ',' + r2(p[0].y);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ' C' + r2(p[i].x + h) + ',' + r2(p[i].y + t[i] * h) + ' ' +
      r2(p[i + 1].x - h) + ',' + r2(p[i + 1].y - t[i + 1] * h) + ' ' + r2(p[i + 1].x) + ',' + r2(p[i + 1].y);
  }
  return d;
}

function drawMensileChart(containerId, mesi, mesiTot, mesiOnco) {
  const box = el(containerId);
  if (!box) return;
  if (!mesi.length) { chartEmpty(box, 'Nessun dato nel periodo selezionato.'); return; }

  const n = mesi.length;
  const PAD_L = 34, PAD_R = 42, PAD_T = 30, PAD_B = 46, CH = 170;
  const W = Math.max(PAD_L + n * 48 + PAD_R, 640);
  const passo = (W - PAD_L - PAD_R) / n;
  const BAR_W = Math.min(38, passo * 0.62);
  const H = PAD_T + CH + PAD_B;
  const base = PAD_T + CH;
  const maxVal = Math.max.apply(null, mesi.map((m) => mesiTot[m] || 0).concat([1]));
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', class: 'graf-mensile',
    style: 'display:block;max-height:400px;' });
  svgDefs(svg, [
    duotone('gm-tot', '#B5B3AB', false),
    duotone('gm-onco', '#6B1A7A', false),
    sfumatura('gm-area', 0, 1, [['5%', '#E8A020', 0.34], ['95%', '#E8A020', 0]]),
    alone('gm-alone', 3.5)
  ]);

  // griglia tratteggiata; a sinistra i conteggi, a destra la quota
  [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    const y = PAD_T + CH * (1 - f);
    svg.appendChild(svgEl('line', { x1: PAD_L, y1: y, x2: W - PAD_R, y2: y, stroke: '#E0DED7',
      'stroke-width': 1, 'stroke-dasharray': f === 0 ? '' : '3 3' }));
    if (f > 0) {
      svg.appendChild(svgEl('text', { x: PAD_L - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 9,
        fill: '#A09E97' }, [String(Math.round(maxVal * f))]));
    }
    if (f === 0.5 || f === 1) {
      svg.appendChild(svgEl('text', { x: W - PAD_R + 6, y: y + 3.5, 'font-size': 9, fill: '#C98A12' },
        [Math.round(f * 100) + '%']));
    }
  });

  const punti = [];
  mesi.forEach((m, i) => {
    const cx = PAD_L + passo * (i + 0.5);
    const x = cx - BAR_W / 2;
    const tot = mesiTot[m] || 0;
    const onco = mesiOnco[m] || 0;
    const hTot = Math.max(2, Math.round(tot / maxVal * CH));
    const hOnco = onco ? Math.max(2, Math.round(onco / maxVal * CH)) : 0;
    const quota = tot ? onco / tot * 100 : 0;

    const g = marcaGrafico(svgEl('g', { class: 'graf-mese' }), 'mensile', m, fmtMese(m),
      tot + ' esami · ' + onco + ' onco. o sospetti (' + pct(onco, tot, 1) + ')', i);
    g.appendChild(svgEl('rect', { class: 'graf-fondo', x: r2(cx - passo / 2 + 2), y: PAD_T - 8,
      width: r2(passo - 4), height: CH + 8, rx: 7, fill: '#A82255', 'fill-opacity': 0 }));
    g.appendChild(svgEl('rect', { class: 'graf-barra-y', x: r2(x), y: base - hTot, width: r2(BAR_W),
      height: hTot, rx: 4, fill: 'url(#gm-tot)' }));
    if (hOnco) {
      g.appendChild(svgEl('rect', { class: 'graf-barra-y', x: r2(x), y: base - hOnco, width: r2(BAR_W),
        height: hOnco, rx: 4, fill: 'url(#gm-onco)' }));
    }
    const ly = base + 14;
    g.appendChild(svgEl('text', { class: 'graf-asse', x: r2(cx), y: ly, 'text-anchor': 'end',
      'font-size': 9.5, fill: '#6B6A62', transform: 'rotate(-35 ' + r2(cx + 4) + ' ' + ly + ')' },
      [fmtMeseBreve(m)]));
    svg.appendChild(g);
    if (tot > 0) punti.push({ x: cx, y: PAD_T + CH * (1 - quota / 100), quota: quota });
  });

  if (punti.length > 1) {
    const d = curvaMonotona(punti);
    const ultimo = punti[punti.length - 1];
    svg.appendChild(svgEl('path', { class: 'graf-area', fill: 'url(#gm-area)',
      d: d + ' L' + r2(ultimo.x) + ',' + base + ' L' + r2(punti[0].x) + ',' + base + ' Z' }));
    svg.appendChild(svgEl('path', { class: 'graf-linea', d: d, fill: 'none', stroke: '#E8A020',
      'stroke-width': 2.5, 'stroke-linecap': 'round', pathLength: 1, 'stroke-dasharray': '1 1',
      filter: 'url(#gm-alone)' }));
  }
  punti.forEach((p, i) => {
    const c = svgEl('circle', { class: 'graf-punto', cx: r2(p.x), cy: r2(p.y), r: 4.5, fill: '#E8A020',
      stroke: '#fff', 'stroke-width': 2 });
    c.style.setProperty('--i', String(i));
    svg.appendChild(c);
    // Etichetta sopra il punto, con un alone bianco che la stacca dalle
    // barre: non si confonde più con quello che c'è sotto.
    const t = svgEl('text', { class: 'graf-pct', x: r2(p.x), y: r2(Math.max(PAD_T - 12, p.y - 11)),
      'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 600, fill: '#B57607',
      'font-family': 'IBM Plex Mono,monospace', stroke: '#fff', 'stroke-width': 3,
      'stroke-linejoin': 'round', 'paint-order': 'stroke' }, [Math.round(p.quota) + '%']);
    t.style.setProperty('--i', String(i));
    svg.appendChild(t);
  });

  box.textContent = '';
  box.appendChild(svg);
}

// ── Heatmap ────────────────────────────────────────────────────────
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

  // intestazioni intere, che vanno a capo: troncate non si leggevano
  let html = '<table class="heatmap-table"><thead><tr><th class="hm-head hm-head-left">Mese</th>';
  tipi.forEach((t) => { html += '<th class="hm-head">' + esc(t) + '</th>'; });
  html += '</tr></thead><tbody>';

  mesi.slice().reverse().forEach((m, ri) => {
    html += '<tr><td class="hm-month">' + esc(fmtMeseBreve(m)) + '</td>';
    tipi.forEach((t, ci) => {
      const cell = (matrix[m] || {})[t];
      const i = Math.min(40, ri + ci);
      if (!cell || !cell.tot) {
        html += '<td class="hm-cella hm-vuota" style="--i:' + i + '">—</td>';
        return;
      }
      html += '<td class="hm-cella ' + heatClass(cell.tot, cell.onco) + '" data-act="grafico" data-graf="heatmap"' +
        ' data-k="' + esc(m + '|' + t) + '" data-tip="' + esc(t + ' · ' + fmtMese(m)) + '"' +
        ' data-tip2="' + esc(cell.tot + ' esami · ' + cell.onco + ' onco. o sospetti (' + pct(cell.onco, cell.tot, 0) + ')') + '"' +
        ' tabindex="0" role="button" aria-pressed="false" style="--i:' + i + '">' +
        cell.tot + '<span class="hm-sub"> (' + cell.onco + ')</span></td>';
    });
    html += '</tr>';
  });
  box.innerHTML = html + '</tbody></table>';
}

// ── Selezione e spiegazione sotto al grafico ───────────────────────
const GRAF_BOX = { donut: 'svgDonut', sede: 'svgBarseSede', mensile: 'svgMensile', heatmap: 'svgHeatmap',
                   tabMensile: 'tableMensileBody', tabSede: 'tableSedeBody' };
let grafScelto = { donut: null, sede: null, mensile: null, heatmap: null, tabMensile: null, tabSede: null };
// le righe delle tabelle raccontano gli stessi dati dei grafici sopra
const GRAF_ALIAS = { tabMensile: 'mensile', tabSede: 'sede' };

function selezionaGrafico(graf, k) {
  if (!GRAF_BOX[graf]) return;
  grafScelto[graf] = grafScelto[graf] === k ? null : k;
  applicaScelta(graf);
}

function applicaScelta(graf) {
  const k = grafScelto[graf];
  const box = el(GRAF_BOX[graf]);
  if (box) {
    const segni = Array.prototype.slice.call(box.querySelectorAll('[data-k]'));
    // "di cui primo riscontro" e "di cui metastasi" accendono anche lo
    // spicchio delle diagnosi oncologiche a cui appartengono
    const scelto = segni.find((e) => e.getAttribute('data-k') === k);
    const alias = scelto ? scelto.getAttribute('data-alias') : null;
    box.classList.toggle('ha-scelta', k !== null);
    segni.forEach((e) => {
      const kk = e.getAttribute('data-k');
      const acceso = k !== null && (kk === k || kk === alias);
      e.classList.toggle('scelto', acceso);
      if (e.getAttribute('role') === 'button') e.setAttribute('aria-pressed', acceso ? 'true' : 'false');
    });
    if (graf === 'donut') aggiornaCentroDonut(box, k);
  }

  const det = el('det-' + graf);
  if (!det) return;
  if (k === null) { det.classList.remove('aperto'); return; }
  const d = dettaglioGrafico(GRAF_ALIAS[graf] || graf, k, getStatsSubset());
  det.innerHTML =
    '<div class="det-corpo"><div class="det-testa">' +
      '<span class="det-punto" style="background:' + d.colore + '"></span>' +
      '<strong>' + esc(d.titolo) + '</strong>' +
      '<button type="button" class="det-chiudi" data-act="grafico-chiudi" data-graf="' + graf +
        '" aria-label="Chiudi la spiegazione">&times;</button>' +
    '</div><p>' + esc(d.testo) + '</p></div>';
  det.classList.add('aperto');
}

function chiudiSceltaGrafico(graf) {
  if (!GRAF_BOX[graf]) return;
  grafScelto[graf] = null;
  applicaScelta(graf);
}

/** Dopo un nuovo calcolo le selezioni non valgono più. */
function azzeraSceltaGrafici() {
  Object.keys(grafScelto).forEach((g) => {
    grafScelto[g] = null;
    const det = el('det-' + g);
    if (det) det.classList.remove('aperto');
  });
}

function piuFrequente(righe, campo) {
  const c = {};
  righe.forEach((r) => { if (r[campo]) c[r[campo]] = (c[r[campo]] || 0) + 1; });
  const k = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
  return k ? { nome: k, n: c[k] } : null;
}

function conSegno(v, decimali) {
  const t = decimali ? Math.abs(v).toFixed(decimali).replace('.', ',') : String(Math.abs(v));
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + t;
}

/** Spiegazione breve dell'elemento cliccato, dai numeri del periodo. */
function dettaglioGrafico(graf, k, set) {
  const kp = kpiPeriodo(set);
  const oncoTot = kp.onco + kp.sosp;
  const isOnco = (r) => r.onco === 'si' || r.onco === 'sospetto';

  if (graf === 'donut') {
    if (k === 'neg') {
      const neg = Math.max(0, kp.tot - oncoTot);
      return { titolo: 'Esami negativi', colore: '#C8C6BE',
        testo: neg + ' esami su ' + kp.tot + ' (' + pct(neg, kp.tot, 1) +
          ') si sono chiusi senza reperto oncologico né sospetto.' };
    }
    if (k === 'onco') {
      const rs = set.filter((r) => r.onco === 'si');
      const top = piuFrequente(rs, 'sede');
      return { titolo: 'Diagnosi oncologiche', colore: '#6B1A7A',
        testo: rs.length + ' esami con diagnosi oncologica (' + pct(rs.length, kp.tot, 1) + ' del periodo). ' +
          'Prime diagnosi: ' + kp.prima + '; con metastasi: ' + rs.filter((r) => r.metastasi === 'si').length + '.' +
          (top ? ' Sede più frequente: ' + top.nome + ' (' + top.n + ').' : '') };
    }
    if (k === 'sosp') {
      const rs = set.filter((r) => r.onco === 'sospetto');
      const top = piuFrequente(rs, 'sede');
      return { titolo: 'Sospetti', colore: '#E8A020',
        testo: rs.length + ' reperti sospetti (' + pct(rs.length, kp.tot, 1) +
          ' del periodo), da approfondire con follow-up o ulteriori accertamenti.' +
          (top ? ' Sede più indicata: ' + top.nome + ' (' + top.n + ').' : '') };
    }
    if (k === 'primo') {
      return { titolo: 'Primo riscontro', colore: '#C2185B',
        testo: kp.primo + ' tumori di primo riscontro, ' + pct(kp.primo, kp.onco, 1) +
          ' delle diagnosi oncologiche: ' + kp.unica + ' con unica patologia, ' + kp.assoc +
          ' con patologie associate.' };
    }
    if (k === 'meta') {
      const top = piuFrequente(set.filter((r) => r.metastasi === 'si'), 'meta_sede');
      return { titolo: 'Metastasi', colore: '#8B1A1A',
        testo: kp.meta + ' lesioni metastatiche, ' + pct(kp.meta, kp.onco, 1) + ' delle diagnosi oncologiche.' +
          (top ? ' Sede di metastasi più indicata: ' + top.nome + ' (' + top.n + ').' : '') };
    }
  }

  if (graf === 'sede') {
    const rs = set.filter((r) => isOnco(r) && r.sede === k);
    const prime = rs.filter((r) => r.prima_onco === 'si').length;
    const meta = rs.filter((r) => r.metastasi === 'si').length;
    const sosp = rs.filter((r) => r.onco === 'sospetto').length;
    const tipo = piuFrequente(rs, 'tipo_esame');
    return { titolo: k, colore: '#6B1A7A',
      testo: rs.length + ' casi, ' + pct(rs.length, oncoTot, 1) + ' delle diagnosi oncologiche o sospette. ' +
        'Prime diagnosi ' + prime + ', metastasi ' + meta + ', sospetti ' + sosp + '.' +
        (tipo ? ' Esame più usato: ' + tipo.nome + ' (' + tipo.n + ').' : '') };
  }

  if (graf === 'mensile') {
    const c = conteggiMese(set);
    const tot = c.tot[k] || 0, on = c.onco[k] || 0;
    const i = c.mesi.indexOf(k);
    let testo = tot + ' esami, ' + on + ' oncologici o sospetti (' + pct(on, tot, 1) + ').';
    if (i > 0) {
      const p = c.mesi[i - 1];
      const tp = c.tot[p] || 0, op = c.onco[p] || 0;
      const dq = (tot ? on / tot : 0) * 100 - (tp ? op / tp : 0) * 100;
      testo += ' Rispetto a ' + fmtMese(p) + ': ' + conSegno(tot - tp) + ' esami, quota ' +
        conSegno(dq, 1) + ' punti.';
    }
    const tipo = piuFrequente(set.filter((r) => r.data && r.data.slice(0, 7) === k), 'tipo_esame');
    if (tipo) testo += ' Esame più frequente: ' + tipo.nome + ' (' + tipo.n + ').';
    return { titolo: fmtMese(k), colore: '#E8A020', testo: testo };
  }

  if (graf === 'heatmap') {
    const sep = k.indexOf('|');
    const m = k.slice(0, sep), t = k.slice(sep + 1);
    const rs = set.filter((r) => r.data && r.data.slice(0, 7) === m && r.tipo_esame === t);
    const on = rs.filter(isOnco).length;
    const ct = conteggiTipo(set);
    return { titolo: t + ' · ' + fmtMese(m), colore: '#A82255',
      testo: rs.length + ' esami, ' + on + ' oncologici o sospetti (' + pct(on, rs.length, 1) + '). ' +
        'Sull’intero periodo ' + t + ' ha una resa del ' + pct(ct.onco[t] || 0, ct.tot[t] || 0, 1) +
        ' su ' + (ct.tot[t] || 0) + ' esami.' };
  }
  return { titolo: '', colore: '#A82255', testo: '' };
}

// ── Etichetta al passaggio del puntatore ───────────────────────────
let grafTip = null;

function setupGrafici() {
  grafTip = document.createElement('div');
  grafTip.className = 'graf-tip';
  grafTip.setAttribute('role', 'tooltip');
  document.body.appendChild(grafTip);

  const vista = el('view-stats');
  if (!vista) return;
  vista.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest ? ev.target.closest('[data-tip]') : null;
    if (!t) { nascondiTip(); return; }
    mostraTip(t, ev.clientX, ev.clientY);
  });
  vista.addEventListener('mousemove', (ev) => {
    if (grafTip.classList.contains('visibile')) posizionaTip(ev.clientX, ev.clientY);
  });
  vista.addEventListener('mouseleave', nascondiTip);
  window.addEventListener('scroll', nascondiTip, { passive: true });
  // da tastiera: Invio o spazio selezionano come il click
  vista.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const t = ev.target.closest ? ev.target.closest('[data-act="grafico"]') : null;
    if (!t) return;
    ev.preventDefault();
    selezionaGrafico(t.getAttribute('data-graf'), t.getAttribute('data-k'));
  });
}

function mostraTip(t, x, y) {
  grafTip.textContent = '';
  const a = document.createElement('strong');
  a.textContent = t.getAttribute('data-tip');
  const b = document.createElement('span');
  b.textContent = t.getAttribute('data-tip2') || '';
  grafTip.appendChild(a);
  grafTip.appendChild(b);
  grafTip.classList.add('visibile');
  posizionaTip(x, y);
}

function posizionaTip(x, y) {
  const r = grafTip.getBoundingClientRect();
  let left = x + 14, top = y + 16;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 12;
  grafTip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
}

function nascondiTip() {
  if (grafTip) grafTip.classList.remove('visibile');
}

// ── Animazioni all'apertura della pagina ───────────────────────────
const GRAF_ANIMATI = ['statsCards', 'svgDonut', 'svgBarseSede', 'svgMensile', 'svgHeatmap',
                      'tableMensileWrap', 'tableSedeWrap'];
let timerAnima = null;

/** Riavvia le animazioni dei grafici. Con dopoPop ognuna parte quando
 *  la scheda che la contiene ha finito di comparire. */
function avviaAnimazioniGrafici(dopoPop) {
  if (PREFS.reduceMotion) return;
  clearTimeout(timerAnima);
  const grafici = GRAF_ANIMATI.map((id) => el(id)).filter(Boolean);

  // Spegnere e riaccendere la classe grafico per grafico, leggendo ogni
  // volta offsetWidth per far ripartire l'animazione, costava otto
  // impaginazioni di fila nel fotogramma del cambio vista. Si spengono
  // tutte, si rifà il layout una volta sola, si riaccendono tutte.
  grafici.forEach((box) => box.classList.remove('anima'));
  void document.body.offsetWidth;

  let ultimo = 0;
  grafici.forEach((box) => {
    let ritardo = 0;
    if (dopoPop) {
      const sez = box.classList.contains('pop-section') ? box : box.closest('.pop-section');
      ritardo = (parseFloat(sez ? sez.style.getPropertyValue('--pop-delay') : '') || 0) + 260;
    }
    ultimo = Math.max(ultimo, ritardo);
    box.style.setProperty('--ritardo', ritardo + 'ms');
    box.classList.add('anima');
  });
  contaNumeri(dopoPop);
  // tolta la classe, restano gli stati finali: nessuno scatto, e il
  // report e le diapositive clonano grafici già fermi
  timerAnima = setTimeout(() => GRAF_ANIMATI.forEach((id) => {
    const b = el(id);
    if (b) b.classList.remove('anima');
  }), ultimo + 2600);
}

/** I numeri delle schede salgono da zero al loro valore. */
function contaNumeri(dopoPop) {
  const box = el('statsCards');
  if (!box) return;
  const ritardo = dopoPop ? (parseFloat(box.style.getPropertyValue('--pop-delay')) || 0) + 180 : 0;
  contaTesto(box.querySelectorAll('.sb-num[data-n]'), ritardo, (n) => parseInt(n.getAttribute('data-n'), 10));
}

/** Porta ogni numero da zero al suo valore. Senza lettore conta solo i
 *  testi fatti di sole cifre. Se nel frattempo il testo viene riscritto
 *  da un nuovo calcolo, il conteggio si ferma e lascia quello. */
function contaTesto(nodi, ritardo, valore) {
  Array.prototype.forEach.call(nodi, (n) => {
    const testo = n.textContent.trim();
    if (!valore && !/^[0-9]+$/.test(testo)) return;
    const fine = valore ? valore(n) : parseInt(testo, 10);
    if (!(fine > 0)) return;
    const t0 = performance.now() + ritardo;
    let scritto = '0';
    n.textContent = scritto;
    const passo = (ora) => {
      if (n.textContent !== scritto) return;
      const p = Math.min(1, Math.max(0, (ora - t0) / 900));
      scritto = String(Math.round(fine * (1 - Math.pow(1 - p, 3))));
      n.textContent = scritto;
      if (p < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  });
}

/** Apertura dell'archivio: i contatori salgono e le prime righe entrano
 *  a cascata, ciascuno dopo il pop della propria scheda. */
function animaArchivio() {
  if (PREFS.reduceMotion) return;
  const vista = el('view-db');
  const body = el('tblBody');
  if (!vista || !body) return;
  const ritardoDi = (sez) => (sez ? parseFloat(sez.style.getPropertyValue('--pop-delay')) || 0 : 0);
  contaTesto(vista.querySelectorAll('.stats-row .sc-n'), ritardoDi(vista.querySelector('.stats-row')) + 160);

  const base = ritardoDi(vista.querySelector('.tbl-wrap')) + 220;
  const righe = Array.prototype.slice.call(body.querySelectorAll('tr'), 0, 24);
  // come in popSections: si toglie a tutte, si rifa' il layout una volta
  // sola, poi si riscrive a tutte
  righe.forEach((r) => r.classList.remove('riga-entra'));
  void body.offsetWidth;
  righe.forEach((r, i) => {
    r.style.setProperty('--i', String(i));
    r.style.setProperty('--ritardo', base + 'ms');
    r.classList.add('riga-entra');
  });
  setTimeout(() => righe.forEach((r) => r.classList.remove('riga-entra')), base + righe.length * 24 + 600);
}

// ══════════════════════════════════════════════════════════════════
//  STATISTICHE
// ══════════════════════════════════════════════════════════════════
function resetStatsFilters() {
  ['sfDal', 'sfAl', 'sfTipo'].forEach((id) => setFieldValue(el(id), ''));
  const focus = el('sfFocus');
  if (focus) focus.value = 'all';
  renderStats();
  avviaAnimazioniGrafici(false);
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
  const baseOnco = onco + sospetti;

  cards.innerHTML =
    '<div class="stat-big"><div class="sb-num" data-n="' + tot + '">' + tot + '</div>' +
      '<div class="sb-label">Esami nel periodo</div>' +
      '<div class="sb-sub">Base di calcolo per tutte le percentuali</div></div>' +
    '<div class="stat-big"><div class="sb-num sb-onco" data-n="' + onco + '">' + onco + '</div>' +
      '<div class="sb-pct">' + pct(onco, tot, 1) + ' degli esami</div>' +
      '<div class="sb-label">Diagnosi oncologiche</div>' +
      '<div class="sb-sub">Prime diagnosi: <strong>' + prima + '</strong> (' + pct(prima, tot, 1) +
      ' tot. · ' + pct(prima, onco, 1) + ' onco.)<br>Sospetti: <strong>' + sospetti +
      '</strong> (' + pct(sospetti, tot, 1) + ' degli esami)</div></div>' +
    '<div class="stat-big"><div class="sb-num sb-onco" data-n="' + primo + '">' + primo + '</div>' +
      '<div class="sb-pct">' + pct(primo, baseOnco, 1) + ' delle diagnosi onco.</div>' +
      '<div class="sb-label">Primo riscontro</div>' +
      '<div class="sb-sub">Unica patologia: <strong>' + unica + '</strong> · Con comorbidità: <strong>' +
      assoc + '</strong></div></div>' +
    '<div class="stat-big"><div class="sb-num sb-red" data-n="' + meta + '">' + meta + '</div>' +
      '<div class="sb-pct">' + pct(meta, baseOnco, 1) + ' delle diagnosi onco.</div>' +
      '<div class="sb-label">Metastasi</div>' +
      '<div class="sb-sub">Primitive: <strong>' + Math.max(0, baseOnco - meta) + '</strong> (' +
      pct(Math.max(0, baseOnco - meta), baseOnco, 1) + ' delle onco.)</div></div>';

  const mesiTot = {}, mesiOnco = {};
  set.forEach((r) => {
    if (!r.data) return;
    const m = r.data.slice(0, 7);
    mesiTot[m] = (mesiTot[m] || 0) + 1;
    if (r.onco === 'si' || r.onco === 'sospetto') mesiOnco[m] = (mesiOnco[m] || 0) + 1;
  });
  const mesiSorted = Object.keys(mesiTot).sort().slice(-24);

  const kd = { tot: tot, onco: onco, sosp: sospetti, primo: primo, meta: meta };
  drawDonut('svgDonut', segmentiDistribuzione(kd), 'esami', sottoinsiemiDistribuzione(kd));

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
  renderNote(set);
  azzeraSceltaGrafici();
  firmaStatistiche = firmaStatisticheOra();
}

/** Attributi che rendono una riga di tabella un segno cliccabile, come
 *  gli elementi dei grafici. */
function attrGrafico(graf, k, tip, tip2, i) {
  return ' data-act="grafico" data-graf="' + graf + '" data-k="' + esc(k) + '" data-tip="' + esc(tip) +
    '" data-tip2="' + esc(tip2) + '" tabindex="0" role="button" aria-pressed="false" style="--i:' + i + '"';
}

/** Quota come barra duotone, colorata per fascia come la heatmap. */
function barraQuota(ratio, testo, i) {
  const fascia = ratio >= 0.3 ? 'alta' : ratio >= 0.1 ? 'media' : 'bassa';
  return '<div class="tg-quota tg-' + fascia + '"><div class="tg-track"><div class="tg-bar" style="width:' +
    Math.round(ratio * 100) + '%;--i:' + i + '"></div></div><span>' + esc(testo) + '</span></div>';
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
    tipi.map((t) => '<th class="st-head">' + esc(t) + '</th>').join('') +
    '<th class="st-head">Totale</th><th class="st-head">Onco.</th>' +
    '<th class="st-head st-head-left">Quota</th>';

  body.innerHTML = mesi.slice().reverse().map((m, i) => {
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
    const quota = pct(oncoM, totM, 1);
    return '<tr' + attrGrafico('tabMensile', m, fmtMese(m),
        totM + ' esami · ' + oncoM + ' onco. o sospetti (' + quota + ')', Math.min(i, 20)) + '>' +
      '<td class="st-month">' + esc(fmtMese(m)) + '</td>' +
      tipi.map((t) => {
        const tv = rigaTot[t] || 0, ov = rigaOnco[t] || 0;
        if (!tv) return '<td class="st-cell st-faint">—</td>';
        return '<td class="st-cell">' + tv + '<span class="st-onco"> (' + ov + ')</span></td>';
      }).join('') +
      '<td class="st-cell st-strong">' + totM + '</td>' +
      '<td class="st-cell v-onco">' + oncoM + '</td>' +
      '<td class="st-cell">' + barraQuota(ratio, quota, Math.min(i, 20)) + '</td></tr>';
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
  const totale = onco + sospetti;
  const pillola = (n, casi, tipo) => n
    ? '<span class="tg-pill tg-' + tipo + '">' + n + ' <em>' + pct(n, casi, 0) + '</em></span>'
    : '<span class="tg-zero">0</span>';

  body.innerHTML = sediSorted.map((entry, i) => {
    const sede = entry[0], casi = entry[1];
    const ps = sediPrima[sede] || 0;
    const ms = sediMeta[sede] || 0;
    return '<tr' + attrGrafico('tabSede', sede, sede,
        casi + ' casi · ' + pct(casi, totale, 1) + (ms ? ' · ' + ms + ' con metastasi' : ''), Math.min(i, 20)) + '>' +
      '<td class="sd-name">' + esc(sede) + '</td>' +
      '<td class="sd-c"><span class="tg-num">' + casi + '</span></td>' +
      '<td class="sd-c">' + pillola(ps, casi, 'onco') + '</td>' +
      '<td class="sd-c">' + pillola(ms, casi, 'meta') + '</td>' +
      '<td class="sd-bar-cell"><div class="sd-bar-wrap"><div class="sd-bar-track">' +
      '<div class="sd-bar" style="width:' + Math.round(casi / max * 100) + '%;--i:' + Math.min(i, 20) + '"></div></div>' +
      '<span class="sd-bar-val">' + pct(casi, totale, 1) + '</span></div></td></tr>';
  }).join('') +
    '<tr class="sd-total"><td class="sd-name">Totale</td>' +
    '<td class="sd-c"><span class="tg-num">' + totale + '</span></td>' +
    '<td class="sd-c">' + pillola(prima, totale, 'onco') + '</td>' +
    '<td class="sd-c">' + pillola(meta, totale, 'meta') + '</td>' +
    '<td class="sd-bar-cell"><span class="tg-num">100%</span></td></tr>';
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

// Con Eulero semi-implicito questa molla è stabile solo finché il passo
// resta sotto 2*massa/smorzamento = 16.7 ms. Un fotogramma a 60 Hz cade
// esattamente sul limite: la velocità cambiava segno crescendo ad ogni
// giro, le pillole schizzavano a scale enormi (anche negative), il testo
// usciva dalla barra e le schede non si lasciavano più cliccare. Si
// integra a passi fissi molto più corti del limite.
const DOCK_PASSO = 1 / 240;    // s — passo fisso d'integrazione
const DOCK_RITARDO_MAX = 0.05; // s — ritardo massimo recuperato in un giro

let dockItems = [];
let dockMouseX = Infinity;
let dockRaf = null;
let dockLastTs = 0;
let dockResiduo = 0;

function setupDock() {
  const dock = el('navDock');
  if (!dock) return;
  dockItems = Array.prototype.slice.call(dock.querySelectorAll('.dock-item'))
    .map((e) => ({ e: e, valore: 1, velocita: 0 }));

  dock.addEventListener('pointermove', (ev) => {
    if (PREFS.reduceMotion) { resetDock(); return; }
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
  dockResiduo = 0;
  dockRaf = requestAnimationFrame(dockTick);
}

/** Riporta subito le pillole a riposo: serve quando si spegne il moto
 *  ridotto a puntatore fermo sul dock, che altrimenti le lascerebbe
 *  ingrandite per sempre. */
function resetDock() {
  dockMouseX = Infinity;
  dockResiduo = 0;
  if (dockRaf !== null) { cancelAnimationFrame(dockRaf); dockRaf = null; }
  dockItems.forEach((it) => {
    it.valore = 1;
    it.velocita = 0;
    it.e.style.transform = '';
  });
}

function dockTick(ts) {
  // Il tempo trascorso si consuma a passi fissi; il resto si riporta al
  // giro dopo, così l'animazione non dipende dalla cadenza dello schermo.
  const trascorso = dockLastTs ? (ts - dockLastTs) / 1000 : DOCK_PASSO;
  dockLastTs = ts;
  dockResiduo = Math.min(dockResiduo + Math.max(trascorso, 0), DOCK_RITARDO_MAX);
  const passi = Math.floor(dockResiduo / DOCK_PASSO);
  dockResiduo -= passi * DOCK_PASSO;

  // offsetLeft/offsetWidth ignorano le transform: i centri restano quelli
  // a riposo e la magnificazione non si dà da mangiare da sola.
  const dock = el('navDock');
  const base = dock ? dock.getBoundingClientRect().left : 0;

  let inMovimento = false;
  dockItems.forEach((it) => {
    const centro = base + it.e.offsetLeft + it.e.offsetWidth / 2;
    const d = Math.abs(dockMouseX - centro);
    // interpolazione lineare come il loro useTransform([-dist,0,dist])
    const t = d >= DOCK_DISTANCE || !isFinite(d) ? 0 : 1 - d / DOCK_DISTANCE;
    const obiettivo = 1 + (DOCK_SCALE_MAX - 1) * t;

    for (let i = 0; i < passi; i++) {
      const a = (DOCK_SPRING.rigidita * (obiettivo - it.valore)
                 - DOCK_SPRING.smorzamento * it.velocita) / DOCK_SPRING.massa;
      it.velocita += a * DOCK_PASSO;
      it.valore += it.velocita * DOCK_PASSO;
    }

    // La molla è sovrasmorzata e non supera mai gli estremi: il vincolo
    // non si vede, ma garantisce che nessun conto storto possa più
    // stendere una pillola sopra il resto della barra.
    if (!isFinite(it.valore)) { it.valore = obiettivo; it.velocita = 0; }
    if (it.valore < 1) { it.valore = 1; if (it.velocita < 0) it.velocita = 0; }
    if (it.valore > DOCK_SCALE_MAX) { it.valore = DOCK_SCALE_MAX; if (it.velocita > 0) it.velocita = 0; }

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
//  MODALITÀ DI ESAME
//  L'elenco dei tipi di esame vive nel file condiviso, non nelle
//  preferenze: è una tassonomia di reparto, deve essere uguale su
//  entrambe le postazioni. Si unisce come i record, last-write-wins
//  sul proprio updatedAt.
// ══════════════════════════════════════════════════════════════════
// Al PS di Desio non si esegue risonanza magnetica: nessun tipo RMN.
/** Modalità che il PS non esegue: non si propongono, non si aggiungono e
 *  spariscono dagli elenchi salvati. Gli esami già registrati restano. */
function esameEscluso(tipo) {
  const t = String(tipo == null ? '' : tipo).trim();
  return /^(rmn|rm|mri)(\s|-|$)/i.test(t) || /risonanza/i.test(t) || /^angio-?rm(\s|$)/i.test(t);
}

const TIPI_PREDEFINITI = [
  'TC torace', 'TC addome con mdc', 'TC addome senza mdc',
  'TC total body', 'TC encefalo', 'Ecografia addome', 'RX torace'
];

/** Elenco effettivo: quello configurato, o i predefiniti se mai toccato,
 *  più i tipi già presenti in archivio che non fossero in elenco. */
function tipiEsameCorrenti() {
  const base = ((tipiEsame.lista && tipiEsame.lista.length)
    ? tipiEsame.lista.slice()
    : TIPI_PREDEFINITI.slice()).filter((t) => !esameEscluso(t));
  const visti = new Set(base.map((t) => t.toLowerCase()));
  DB.forEach((r) => {
    if (r.tipo_esame && !esameEscluso(r.tipo_esame) && !visti.has(r.tipo_esame.toLowerCase())) {
      visti.add(r.tipo_esame.toLowerCase());
      base.push(r.tipo_esame);
    }
  });
  return base;
}

function salvaTipiEsame(lista) {
  tipiEsame = { lista: lista, updatedAt: Date.now() };
  scheduleSave();
  aggiornaSelettoreTipo();
  renderTipiEsame();
  renderCategorieRichieste();      // gli esami proposti si scelgono da questo elenco
  updateSuggests();
}

/** Riempie il menu a tendina del passo 2 con l'elenco corrente. */
function aggiornaSelettoreTipo() {
  const sel = el('w_tipo_sel');
  if (!sel) return;
  const attuale = val('w_tipo_esame');
  const lista = tipiEsameCorrenti();
  sel.innerHTML = '<option value="">— seleziona —</option>' +
    lista.map((t) => '<option value="' + esc(t) + '"' +
      (t === attuale ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
  if (attuale && lista.indexOf(attuale) === -1) {
    // valore scritto a mano e non in elenco: si mostra comunque
    const extra = document.createElement('option');
    extra.value = attuale;
    extra.textContent = attuale + '  (a mano)';
    extra.selected = true;
    sel.appendChild(extra);
  }
  refreshSelect('w_tipo_sel');
}

/** Passa fra elenco e scrittura libera. */
function modalitaTipoLibera(libera) {
  const host = el('tipoSelHost');
  const campo = el('w_tipo_esame');
  const bottone = el('btnTipoModifica');
  if (!host || !campo || !bottone) return;
  host.classList.toggle('nascosto', libera);
  campo.classList.toggle('nascosto', !libera);
  bottone.textContent = libera ? 'Elenco' : 'Modifica';
  bottone.title = libera
    ? 'Torna a scegliere dall’elenco dei tipi di esame'
    : 'Scrivi un tipo di esame a mano';
  if (libera) campo.focus();
}

// ── finestra di gestione ──────────────────────────────────────────
function apriTipiEsame() {
  apriPersonalizzazione('tipi');
}

function renderTipiEsame() {
  const wrap = el('tipiLista');
  if (!wrap) return;
  const lista = ((tipiEsame.lista && tipiEsame.lista.length)
    ? tipiEsame.lista
    : TIPI_PREDEFINITI).filter((t) => !esameEscluso(t));

  if (!lista.length) {
    wrap.innerHTML = '<div class="tipi-vuoto">Nessun tipo in elenco.</div>';
    return;
  }
  wrap.innerHTML = lista.map((t, i) =>
    '<div class="tipo-voce">' +
      '<span class="tipo-num">' + (i + 1) + '</span>' +
      '<span class="tipo-nome">' + esc(t) + '</span>' +
      '<button type="button" class="tipo-btn" data-act="tipi-su" data-idx="' + i +
        '" title="Sposta su"' + (i === 0 ? ' disabled' : '') + '>&#8593;</button>' +
      '<button type="button" class="tipo-btn" data-act="tipi-giu" data-idx="' + i +
        '" title="Sposta giù"' + (i === lista.length - 1 ? ' disabled' : '') + '>&#8595;</button>' +
      '<button type="button" class="tipo-btn tipo-del" data-act="tipi-elimina" data-idx="' + i +
        '" title="Rimuovi">&times;</button>' +
    '</div>').join('');
}

function aggiungiTipoEsame() {
  const campo = el('tipiNuovo');
  if (!campo) return;
  const nome = String(campo.value || '').trim().slice(0, 200);
  if (!nome) { notify('Scrivi il nome del tipo di esame.'); return; }
  if (esameEscluso(nome)) { notify('La risonanza magnetica non si esegue in PS: tipo non aggiunto.'); return; }
  const lista = (tipiEsame.lista && tipiEsame.lista.length)
    ? tipiEsame.lista.slice() : TIPI_PREDEFINITI.slice();
  if (lista.some((t) => t.toLowerCase() === nome.toLowerCase())) {
    notify('Questo tipo è già in elenco.');
    return;
  }
  lista.push(nome);
  campo.value = '';
  salvaTipiEsame(lista);
  notify('Aggiunto: ' + nome);
}

function spostaTipoEsame(i, delta) {
  const lista = (tipiEsame.lista && tipiEsame.lista.length)
    ? tipiEsame.lista.slice() : TIPI_PREDEFINITI.slice();
  const j = i + delta;
  if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return;
  const tmp = lista[i]; lista[i] = lista[j]; lista[j] = tmp;
  salvaTipiEsame(lista);
}

async function eliminaTipoEsame(i) {
  const lista = (tipiEsame.lista && tipiEsame.lista.length)
    ? tipiEsame.lista.slice() : TIPI_PREDEFINITI.slice();
  if (i < 0 || i >= lista.length) return;
  const nome = lista[i];
  const usato = DB.filter((r) => r.tipo_esame === nome).length;
  if (usato) {
    const ok = await conferma({
      tipo: 'avviso',
      titolo: 'Rimuovere «' + nome + '» dall’elenco?',
      messaggio: 'È usato in ' + usato + (usato === 1 ? ' esame' : ' esami') + ' già registrati.',
      dettaglio: 'Gli esami registrati non cambiano: il tipo non verrà più proposto nel menu.',
      conferma: 'Rimuovi'
    });
    if (!ok) return;
  }
  // l'elenco può essere cambiato mentre la finestra era aperta
  const attuale = (tipiEsame.lista && tipiEsame.lista.length) ? tipiEsame.lista.slice() : TIPI_PREDEFINITI.slice();
  const k = attuale.indexOf(nome);
  if (k === -1) return;
  attuale.splice(k, 1);
  salvaTipiEsame(attuale);
}

async function ripristinaTipiEsame() {
  const ok = await conferma({
    tipo: 'avviso',
    titolo: 'Ripristinare i tipi di esame predefiniti?',
    messaggio: 'L’elenco torna a: ' + TIPI_PREDEFINITI.join(', ') + '.',
    dettaglio: 'I tipi aggiunti dal reparto vengono tolti dall’elenco; gli esami già registrati non cambiano.',
    conferma: 'Ripristina'
  });
  if (!ok) return;
  salvaTipiEsame(TIPI_PREDEFINITI.slice());
  notify('Elenco ripristinato.');
}

// ══════════════════════════════════════════════════════════════════
//  PERSONALIZZAZIONE
//  Un'unica sezione per ciò che il reparto adatta a sé: i tipi di esame
//  (sopra) e le categorie della cronologia, cioè l'esame proposto per
//  ciascuna e le parole chiave che la riconoscono. Vive nel file
//  condiviso con la stessa unione last-write-wins dei tipi di esame.
// ══════════════════════════════════════════════════════════════════
const PAROLE_UTENTE_MAX = 200;

function personalizzazioneVuota() {
  return { updatedAt: 0, esamiCategoria: {}, parole: [] };
}

/** Il file è condiviso e non fidato: solo categorie esistenti, testi brevi. */
function normalizzaPersonalizzazione(raw) {
  const p = personalizzazioneVuota();
  p.updatedAt = num(raw.updatedAt);
  const ids = CATEGORIE_RICHIESTA.map((c) => c.id);
  if (raw.esamiCategoria && typeof raw.esamiCategoria === 'object') {
    ids.forEach((id) => {
      const v = raw.esamiCategoria[id];
      if (typeof v === 'string' && v.trim() && !esameEscluso(v)) p.esamiCategoria[id] = str(v.trim(), 200);
    });
  }
  if (Array.isArray(raw.parole)) {
    raw.parole.slice(0, PAROLE_UTENTE_MAX).forEach((w) => {
      if (w && typeof w.testo === 'string' && w.testo.trim() && ids.indexOf(w.categoria) !== -1) {
        p.parole.push({ testo: str(w.testo.trim(), 60), categoria: w.categoria });
      }
    });
  }
  return p;
}

function categoriaPredefinita(id) {
  return CATEGORIE_RICHIESTA.find((c) => c.id === id) || null;
}

/** Ogni modifica crea una nuova versione datata, che l'unione riconosce. */
function salvaPersonalizzazione(modifica) {
  const p = {
    updatedAt: Date.now(),
    esamiCategoria: Object.assign({}, personalizzazione.esamiCategoria),
    parole: personalizzazione.parole.slice()
  };
  modifica(p);
  personalizzazione = p;
  scheduleSave();
  renderCategorieRichieste();
  renderCronologia();
}

let persTab = 'tipi';
let persCategoria = 'trauma';

function personalizzazioneAperta() {
  const o = el('modPersonalizza');
  return !!(o && o.classList.contains('open') && !o.classList.contains('in-chiusura'));
}

/** Apre la pagina di personalizzazione sopra il tool. Dal pulsante del
 *  rail fa da interruttore: un secondo click la richiude. */
function apriPersonalizzazione(tab) {
  const o = el('modPersonalizza');
  if (!o) return;
  if (!tab && personalizzazioneAperta()) { closeOverlay('modPersonalizza'); return; }
  if (railAperto) toggleRail(null);
  if (tab) persTab = tab;
  renderTipiEsame();
  renderCategorieRichieste(false);
  mostraTabPersonalizzazione(persTab, true);
  apriOverlay(o);
  const b = el('railPersonalizza');
  if (b) b.setAttribute('aria-expanded', 'true');
  const attivo = o.querySelector('.pg-tab[aria-selected="true"]');
  if (attivo) attivo.focus({ preventScroll: true });
}

function mostraTabPersonalizzazione(tab, senzaAnimazione) {
  if (tab !== 'tipi' && tab !== 'categorie') return;
  const cambia = tab !== persTab;
  persTab = tab;
  const o = el('modPersonalizza');
  if (!o) return;
  o.querySelectorAll('.pg-tab').forEach((t) => {
    t.setAttribute('aria-selected', t.getAttribute('data-tab') === tab ? 'true' : 'false');
  });
  o.querySelectorAll('.pg-sezione').forEach((s) => {
    const sua = s.getAttribute('data-tab') === tab;
    s.hidden = !sua;
    s.classList.remove('pg-entra');
    if (sua && cambia && !senzaAnimazione && !PREFS.reduceMotion) {
      void s.offsetWidth;
      s.classList.add('pg-entra');
    }
  });
}

function selezionaCategoria(id) {
  if (!categoriaPredefinita(id)) return;
  const cambia = id !== persCategoria;
  persCategoria = id;
  if (persTab !== 'categorie') mostraTabPersonalizzazione('categorie');
  renderCategorieRichieste(cambia);
}

function aggiornaContatoriPersonalizzazione() {
  const tipi = el('persContaTipi');
  const cat = el('persContaCat');
  if (tipi) tipi.textContent = String((tipiEsame.lista && tipiEsame.lista.length ? tipiEsame.lista : TIPI_PREDEFINITI).length);
  if (cat) cat.textContent = String(CATEGORIE_RICHIESTA.length);
}

/** Elenco delle categorie a sinistra, dettaglio di quella scelta a destra. */
function renderCategorieRichieste(animaDettaglio) {
  aggiornaContatoriPersonalizzazione();
  const lista = el('categorieLista');
  const dettaglio = el('categoriaDettaglio');
  if (!lista || !dettaglio) return;
  const categorie = categorieEffettive().categorie;
  if (!categoriaPredefinita(persCategoria)) persCategoria = categorie[0].id;

  lista.innerHTML = categorie.map((c) => {
    const e = esameConsigliato(c);
    const aggiunte = personalizzazione.parole.filter((w) => w.categoria === c.id).length;
    const scelta = c.id === persCategoria;
    return '<button type="button" class="pg-cat' + (scelta ? ' scelta' : '') + '" role="tab" aria-selected="' +
        scelta + '" data-act="pers-categoria" data-cat="' + c.id + '" style="--c:' + c.colore + '">' +
      '<span class="pg-cat-nome">' + esc(c.nome) + '</span>' +
      '<span class="pg-cat-conta">' + c.concetti.length + (aggiunte ? ' · +' + aggiunte : '') + '</span>' +
      '<span class="pg-cat-esame">' + esc(e ? e.scelto : '—') + (c.esameFisso ? '' : ' · auto') + '</span>' +
    '</button>';
  }).join('');

  const c = categorie.find((x) => x.id === persCategoria);
  const base = categoriaPredefinita(c.id);
  const fisso = personalizzazione.esamiCategoria[c.id] || '';
  const automatico = esameConsigliato(Object.assign({}, c, { esameFisso: '', esami: base.esami }));
  const elenco = tipiEsameCorrenti().slice();
  if (fisso && elenco.indexOf(fisso) === -1) elenco.push(fisso);
  const opzioni = '<option value="">Automatico — ' + esc(automatico ? automatico.scelto : '—') + '</option>' +
    elenco.map((t) => '<option value="' + esc(t) + '"' + (t === fisso ? ' selected' : '') + '>' +
      esc(t) + '</option>').join('');
  const aggiunte = personalizzazione.parole
    .map((w, i) => ({ w: w, i: i }))
    .filter((x) => x.w.categoria === c.id);

  // quanto si stava scrivendo nel campo resta, anche dopo una modifica
  const campoPrima = dettaglio.querySelector('.pers-nuova');
  const bozza = campoPrima && campoPrima.getAttribute('data-cat') === c.id ? campoPrima.value : '';

  let notaAuto = '';
  if (automatico) {
    notaAuto = automatico.archivio
      ? 'In automatico: <b>' + esc(automatico.scelto) + '</b>. In archivio questa categoria usa ' +
        esc(automatico.archivio.tipo) + ' nel ' + pct(automatico.archivio.n, automatico.archivio.tot, 0) +
        ' dei ' + automatico.archivio.tot + ' casi.'
      : 'In automatico: <b>' + esc(automatico.scelto) + '</b>, l’esame tipico della categoria.';
  }

  dettaglio.style.setProperty('--c', c.colore);
  dettaglio.innerHTML =
    '<div class="pg-det-testa">' + etichettaCategoria(c) +
      '<span class="pg-det-sub">' + (fisso ? 'esame fissato dal reparto' : 'esame automatico') + '</span></div>' +
    '<div class="pg-campo">' +
      '<div class="pers-etichetta">Esame proposto nella cronologia</div>' +
      '<select class="pers-esame" data-cat="' + c.id + '" aria-label="Esame proposto per ' + esc(c.nome) + '">' +
        opzioni + '</select>' +
      '<div class="pg-nota">' + notaAuto + ' Un esame scelto qui vale sempre, anche sull’archivio.</div>' +
    '</div>' +
    '<div class="pg-campo">' +
      '<div class="pers-etichetta">Parole chiave predefinite</div>' +
      '<div class="pers-parole">' + base.concetti.map((w) => '<span class="pers-parola">' + esc(w) + '</span>').join('') + '</div>' +
      '<div class="pg-nota">Riconosciute anche nei loro sinonimi (per esempio affanno per dispnea).</div>' +
    '</div>' +
    '<div class="pg-campo">' +
      '<div class="pers-etichetta">Parole chiave del reparto</div>' +
      '<div class="pers-parole">' + (aggiunte.length
        ? aggiunte.map((x) => '<span class="pers-parola utente">' + esc(x.w.testo) +
            '<button type="button" data-act="pers-parola-elimina" data-idx="' + x.i +
            '" aria-label="Rimuovi ' + esc(x.w.testo) + '">&times;</button></span>').join('')
        : '<span class="pg-vuoto">Nessuna per ora.</span>') + '</div>' +
      '<div class="tipi-aggiungi pers-aggiungi">' +
        '<input type="text" class="pers-nuova" data-cat="' + c.id + '" maxlength="60" autocomplete="off" ' +
          'placeholder="Nuova parola chiave per ' + esc(c.nome) + '" value="' + esc(bozza) + '">' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="pers-parola-aggiungi" data-cat="' + c.id +
          '">Aggiungi</button>' +
      '</div>' +
      '<div class="pg-nota">Sinonimi, abbreviazioni o diagnosi che il PS scrive spesso nelle richieste. ' +
        'Maiuscole, accenti e plurali non contano.</div>' +
    '</div>';

  dettaglio.querySelectorAll('select.pers-esame').forEach(avvolgiSelect);
  if (animaDettaglio && !PREFS.reduceMotion) {
    dettaglio.classList.remove('pg-entra');
    void dettaglio.offsetWidth;
    dettaglio.classList.add('pg-entra');
  }
  renderProva();
}

/** Prova dal vivo: cosa riconosce la cronologia in una richiesta. */
function renderProva() {
  const campo = el('persProva');
  const esito = el('persProvaEsito');
  if (!campo || !esito) return;
  const testo = campo.value.trim();
  if (!testo) {
    esito.innerHTML = '<span class="pg-nota">Scrivi una richiesta come la scriverebbe il PS: vedi quali parole ' +
      'vengono riconosciute, in quale categoria finisce e quale esame viene proposto.</span>';
    return;
  }
  const an = analizzaRichiesta(testo);
  const cat = an.concetti.length ? categoriaDi(an.concetti) : CATEGORIA_ALTRO;
  const esame = esameConsigliato(cat);
  const nomeScelta = (categoriaPredefinita(persCategoria) || {}).nome || '';

  esito.innerHTML =
    '<div class="pg-prova-riga"><span class="pers-etichetta">Riconosciute</span>' +
      (an.concetti.length
        ? an.concetti.map((x) => '<b class="pg-chip-ok">' + esc(x) + '</b>').join('')
        : '<span class="pg-nota">nessuna</span>') +
    '</div>' +
    (an.nonRiconosciute.length
      ? '<div class="pg-prova-riga"><span class="pers-etichetta">Non riconosciute</span>' +
          an.nonRiconosciute.map((p) => '<button type="button" class="pg-termine" data-act="pers-termine" data-testo="' +
            esc(p) + '" title="Prepara come parola chiave di ' + esc(nomeScelta) + '">' + esc(p) + ' +</button>').join('') +
        '</div>'
      : '') +
    '<div class="pg-prova-riga"><span class="pers-etichetta">Risultato</span>' +
      (cat !== CATEGORIA_ALTRO
        ? '<button type="button" class="pg-prova-cat" data-act="pers-categoria" data-cat="' + cat.id + '">' +
            etichettaCategoria(cat) + '</button><span class="pg-prova-esame">&rarr; <b>' +
            esc(esame ? esame.scelto : '—') + '</b></span>'
        : '<span class="pg-nota">nessuna categoria: finirebbe in Altre richieste</span>') +
    '</div>';
}

/** Una parola non riconosciuta della prova va nel campo di aggiunta
 *  della categoria scelta, pronta da confermare. */
function usaTermineProva(testo) {
  if (persTab !== 'categorie') mostraTabPersonalizzazione('categorie');
  const campo = document.querySelector('#categoriaDettaglio .pers-nuova');
  if (!campo) return;
  campo.value = testo || '';
  campo.focus();
  campo.select();
}

function impostaEsameCategoria(id, tipo) {
  if (!categoriaPredefinita(id)) return;
  salvaPersonalizzazione((p) => {
    if (tipo) p.esamiCategoria[id] = str(tipo, 200);
    else delete p.esamiCategoria[id];
  });
  const c = categoriaPredefinita(id);
  notify(tipo ? c.nome + ': esame proposto ' + tipo : c.nome + ': esame proposto automatico');
}

function aggiungiParolaChiave(id) {
  const c = categoriaPredefinita(id);
  if (!c) return;
  const campo = document.querySelector('.pers-nuova[data-cat="' + c.id + '"]');
  if (!campo) return;
  const testo = String(campo.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const radici = paroleChiave(testo);
  if (!radici.length || normalizzaTesto(testo).length < 3) {
    notify('Scrivi una parola chiave di almeno 3 lettere.');
    return;
  }
  // una parola già riconosciuta, qui o altrove, non si duplica: in due
  // categorie diverse renderebbe la classificazione ambigua
  const firma = radici.join(' ');
  const esistente = categorieEffettive().varianti.find((v) => v.parole.join(' ') === firma);
  if (esistente) {
    const dove = categoriaDi([esistente.nome]);
    notify('«' + testo + '» è già riconosciuta' +
      (dove !== CATEGORIA_ALTRO ? ' in ' + dove.nome : '') + ' (come ' + esistente.nome + ').');
    return;
  }
  if (personalizzazione.parole.length >= PAROLE_UTENTE_MAX) {
    notify('Raggiunto il limite di ' + PAROLE_UTENTE_MAX + ' parole chiave aggiunte.');
    return;
  }
  campo.value = '';
  salvaPersonalizzazione((p) => p.parole.push({ testo: testo, categoria: c.id }));
  notify('Aggiunta a ' + c.nome + ': ' + testo);
  const nuovo = document.querySelector('.pers-nuova[data-cat="' + c.id + '"]');
  if (nuovo) nuovo.focus();
}

function eliminaParolaChiave(i) {
  if (!(i >= 0 && i < personalizzazione.parole.length)) return;
  const testo = personalizzazione.parole[i].testo;
  salvaPersonalizzazione((p) => p.parole.splice(i, 1));
  notify('Rimossa: ' + testo);
}

async function ripristinaCategorie() {
  const aggiunte = personalizzazione.parole.length;
  const fissati = Object.keys(personalizzazione.esamiCategoria).length;
  const ok = await conferma({
    tipo: 'avviso',
    titolo: 'Ripristinare le categorie predefinite?',
    messaggio: 'Tutte le categorie tornano all’esame automatico e alle sole parole chiave predefinite.',
    dettaglio: 'Si perdono ' + aggiunte + (aggiunte === 1 ? ' parola chiave aggiunta' : ' parole chiave aggiunte') +
      ' e ' + fissati + (fissati === 1 ? ' esame fissato' : ' esami fissati') + ' dal reparto.',
    conferma: 'Ripristina'
  });
  if (!ok) return;
  salvaPersonalizzazione((p) => { p.esamiCategoria = {}; p.parole = []; });
  notify('Categorie ripristinate.');
}

// ══════════════════════════════════════════════════════════════════
//  DESCRIZIONI DEI GRAFICI
//  Sotto ogni grafico una frase costruita dai numeri effettivi del
//  periodo. Sono un punto di partenza, non una verità: chi legge i
//  referti può correggerle, e il testo corretto vive nel file condiviso
//  così vale per entrambe le postazioni e finisce nei report.
// ══════════════════════════════════════════════════════════════════
const NOTE_CHIAVI = ['donut', 'sede', 'mensile', 'heatmap', 'tabMensile', 'tabSede'];
let notaInModifica = null;

function elenca(voci, congiunzione) {
  if (!voci.length) return '';
  if (voci.length === 1) return voci[0];
  return voci.slice(0, -1).join(', ') + ' ' + (congiunzione || 'e') + ' ' + voci[voci.length - 1];
}

/** Conteggi per sede, riusati da più descrizioni. */
function conteggiSede(set) {
  const tot = {}, meta = {};
  set.filter((r) => (r.onco === 'si' || r.onco === 'sospetto') && r.sede).forEach((r) => {
    tot[r.sede] = (tot[r.sede] || 0) + 1;
    if (r.metastasi === 'si') meta[r.sede] = (meta[r.sede] || 0) + 1;
  });
  const ordinate = Object.keys(tot).map((k) => [k, tot[k]]).sort((a, b) => b[1] - a[1]);
  return { tot: tot, meta: meta, ordinate: ordinate };
}

function conteggiMese(set) {
  const tot = {}, onco = {};
  set.forEach((r) => {
    if (!r.data) return;
    const m = r.data.slice(0, 7);
    tot[m] = (tot[m] || 0) + 1;
    if (r.onco === 'si' || r.onco === 'sospetto') onco[m] = (onco[m] || 0) + 1;
  });
  return { tot: tot, onco: onco, mesi: Object.keys(tot).sort() };
}

function conteggiTipo(set) {
  const tot = {}, onco = {};
  set.forEach((r) => {
    if (!r.tipo_esame) return;
    tot[r.tipo_esame] = (tot[r.tipo_esame] || 0) + 1;
    if (r.onco === 'si' || r.onco === 'sospetto') onco[r.tipo_esame] = (onco[r.tipo_esame] || 0) + 1;
  });
  return { tot: tot, onco: onco };
}

/** Testo generato dai numeri del periodo. */
function generaNota(chiave, set) {
  const tot = set.length;
  if (!tot) return 'Nessun esame nel periodo selezionato.';

  const onco = set.filter((r) => r.onco === 'si').length;
  const sosp = set.filter((r) => r.onco === 'sospetto').length;
  const primo = set.filter((r) => r.primo_riscontro).length;
  const meta = set.filter((r) => r.metastasi === 'si').length;
  const oncoTot = onco + sosp;

  if (chiave === 'donut') {
    let t = 'Nel periodo sono stati registrati ' + tot + ' esami. ' +
      onco + ' hanno prodotto una diagnosi oncologica (' + pct(onco, tot, 1) + ')';
    t += sosp ? ' e ' + sosp + ' sono risultati sospetti (' + pct(sosp, tot, 1) + ').' : '.';
    if (oncoTot) {
      const parti = [];
      if (primo) parti.push(primo + ' sono primi riscontri (' + pct(primo, oncoTot, 0) + ' delle diagnosi)');
      if (meta) parti.push(meta + ' presentano metastasi (' + pct(meta, oncoTot, 0) + ')');
      if (parti.length) t += ' Fra queste, ' + elenca(parti) + '.';
    }
    return t;
  }

  if (chiave === 'sede') {
    const c = conteggiSede(set);
    if (!c.ordinate.length) return 'Nessuna diagnosi oncologica con sede indicata nel periodo.';
    const prima = c.ordinate[0];
    let t = 'Le diagnosi con sede indicata si distribuiscono su ' + c.ordinate.length +
      (c.ordinate.length === 1 ? ' sede.' : ' sedi. ');
    if (c.ordinate.length > 1) {
      t += 'La più rappresentata è ' + prima[0] + ' con ' + prima[1] +
        (prima[1] === 1 ? ' caso' : ' casi') + ' (' + pct(prima[1], oncoTot, 1) + ' delle diagnosi)';
      const seguito = c.ordinate.slice(1, 3).map((e) => e[0] + ' (' + e[1] + ')');
      t += seguito.length ? ', seguita da ' + elenca(seguito) + '.' : '.';
    }
    const conMeta = c.ordinate.filter((e) => c.meta[e[0]]);
    if (conMeta.length) {
      const top = conMeta.sort((a, b) => c.meta[b[0]] - c.meta[a[0]])[0];
      t += ' Le metastasi si concentrano su ' + top[0] + ' (' + c.meta[top[0]] +
           ' su ' + c.tot[top[0]] + ').';
    }
    return t;
  }

  if (chiave === 'mensile') {
    const c = conteggiMese(set);
    if (!c.mesi.length) return 'Nessun esame con data valida nel periodo.';
    if (c.mesi.length === 1) {
      const m = c.mesi[0];
      return 'Un solo mese nel periodo: ' + fmtMese(m) + ', con ' + c.tot[m] +
        ' esami e ' + (c.onco[m] || 0) + ' diagnosi oncologiche o sospette (' +
        pct(c.onco[m] || 0, c.tot[m], 1) + ').';
    }
    const volumi = c.mesi.map((m) => c.tot[m]);
    const minV = Math.min.apply(null, volumi);
    const maxV = Math.max.apply(null, volumi);
    const meseMax = c.mesi[volumi.indexOf(maxV)];
    // mese con la quota oncologica più alta, fra quelli con almeno 3 esami
    const significativi = c.mesi.filter((m) => c.tot[m] >= 3);
    let t = 'Il volume mensile va da ' + minV + ' a ' + maxV + ' esami, con il massimo a ' +
      fmtMese(meseMax) + '. ';
    if (significativi.length) {
      const quote = significativi.map((m) => ({ m: m, q: (c.onco[m] || 0) / c.tot[m] }));
      quote.sort((a, b) => b.q - a.q);
      t += 'La quota oncologica più alta è a ' + fmtMese(quote[0].m) + ' (' +
        pct(c.onco[quote[0].m] || 0, c.tot[quote[0].m], 1) + ')';
      if (quote.length > 1) {
        t += ', la più bassa a ' + fmtMese(quote[quote.length - 1].m) + ' (' +
          pct(c.onco[quote[quote.length - 1].m] || 0, c.tot[quote[quote.length - 1].m], 1) + ')';
      }
      t += '. ';
    }
    // confronto fra prima e seconda metà del periodo
    if (c.mesi.length >= 4) {
      const meta1 = c.mesi.slice(0, Math.floor(c.mesi.length / 2));
      const meta2 = c.mesi.slice(Math.floor(c.mesi.length / 2));
      const somma = (arr, dove) => arr.reduce((s, m) => s + (dove[m] || 0), 0);
      const q1 = somma(meta1, c.onco) / Math.max(1, somma(meta1, c.tot));
      const q2 = somma(meta2, c.onco) / Math.max(1, somma(meta2, c.tot));
      const delta = (q2 - q1) * 100;
      if (Math.abs(delta) >= 3) {
        t += 'Nella seconda metà del periodo la quota oncologica ' +
          (delta > 0 ? 'sale' : 'scende') + ' di ' + Math.abs(delta).toFixed(1).replace('.', ',') +
          ' punti rispetto alla prima.';
      } else {
        t += 'La quota oncologica resta sostanzialmente stabile lungo il periodo.';
      }
    }
    return t.trim();
  }

  if (chiave === 'heatmap') {
    const c = conteggiTipo(set);
    const tipi = Object.keys(c.tot).filter((k) => c.tot[k] >= 3);
    if (!tipi.length) return 'Troppo pochi esami per tipo per un confronto significativo.';
    const rese = tipi.map((k) => ({ k: k, r: (c.onco[k] || 0) / c.tot[k], n: c.tot[k] }));
    rese.sort((a, b) => b.r - a.r);
    const alto = rese[0];
    let t = 'Considerando i tipi con almeno 3 esami, la resa oncologica più alta è di ' +
      alto.k + ': ' + (c.onco[alto.k] || 0) + ' su ' + alto.n + ' (' +
      pct(c.onco[alto.k] || 0, alto.n, 1) + ').';
    if (rese.length > 1) {
      const basso = rese[rese.length - 1];
      t += ' La più bassa è di ' + basso.k + ' (' + pct(c.onco[basso.k] || 0, basso.n, 1) +
           ' su ' + basso.n + ' esami).';
    }
    return t;
  }

  if (chiave === 'tabMensile') {
    const c = conteggiMese(set);
    const tipi = Object.keys(conteggiTipo(set).tot).length;
    return 'Conteggi mese per mese incrociati con ' + tipi +
      (tipi === 1 ? ' tipo di esame' : ' tipi di esame') + ', su ' + c.mesi.length +
      (c.mesi.length === 1 ? ' mese' : ' mesi') +
      '. Fra parentesi i casi oncologici o sospetti; l’ultima colonna è la loro quota sul mese.';
  }

  if (chiave === 'tabSede') {
    const c = conteggiSede(set);
    if (!c.ordinate.length) return 'Nessuna diagnosi oncologica con sede indicata nel periodo.';
    const primeTre = c.ordinate.slice(0, 3);
    const somma = primeTre.reduce((s, e) => s + e[1], 0);
    return 'Su ' + oncoTot + ' diagnosi oncologiche o sospette, ' + c.ordinate.length +
      (c.ordinate.length === 1 ? ' sede è rappresentata' : ' sedi sono rappresentate') +
      '. Le prime ' + primeTre.length + ' (' + elenca(primeTre.map((e) => e[0])) +
      ') coprono il ' + pct(somma, oncoTot, 1) + ' del totale.';
  }

  return '';
}

/** Testo effettivo: quello corretto a mano se c'è, altrimenti il generato. */
function testoNota(chiave, set) {
  const salvata = noteGrafici[chiave];
  if (salvata && salvata.testo) return { testo: salvata.testo, manuale: true };
  return { testo: generaNota(chiave, set), manuale: false };
}

function renderNote(set) {
  NOTE_CHIAVI.forEach((chiave) => {
    const host = el('nota-' + chiave);
    if (!host) return;
    if (notaInModifica === chiave) return;   // non si sovrascrive mentre si scrive
    const n = testoNota(chiave, set);
    host.className = 'chart-nota' + (n.manuale ? ' manuale' : '');
    host.innerHTML =
      '<p class="nota-testo">' + esc(n.testo) + '</p>' +
      '<div class="nota-azioni">' +
        (n.manuale ? '<span class="nota-badge" title="Testo corretto a mano">modificata</span>' : '') +
        '<button type="button" class="nota-btn" data-act="nota-modifica" data-nota="' + chiave +
          '" title="Correggi la descrizione">Modifica</button>' +
        (n.manuale ? '<button type="button" class="nota-btn" data-act="nota-auto" data-nota="' +
          chiave + '" title="Torna al testo generato">Rigenera</button>' : '') +
      '</div>';
  });
}

function modificaNota(chiave) {
  const host = el('nota-' + chiave);
  if (!host) return;
  notaInModifica = chiave;
  const n = testoNota(chiave, getStatsSubset());
  host.className = 'chart-nota in-modifica';
  host.innerHTML =
    '<textarea class="nota-edit" id="notaEdit" rows="3" maxlength="1200"></textarea>' +
    '<div class="nota-azioni">' +
      '<button type="button" class="nota-btn" data-act="nota-annulla" data-nota="' + chiave + '">Annulla</button>' +
      '<button type="button" class="nota-btn nota-ok" data-act="nota-salva" data-nota="' + chiave + '">Salva</button>' +
    '</div>';
  const ta = el('notaEdit');
  if (ta) { ta.value = n.testo; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function salvaNota(chiave) {
  const ta = el('notaEdit');
  if (!ta) return;
  const testo = String(ta.value || '').trim().slice(0, 1200);
  const auto = generaNota(chiave, getStatsSubset());
  notaInModifica = null;
  if (!testo || testo === auto) {
    delete noteGrafici[chiave];      // uguale al generato: non vale la pena fissarlo
  } else {
    noteGrafici[chiave] = { testo: testo, updatedAt: Date.now() };
  }
  noteGrafici.updatedAt = Date.now();
  scheduleSave();
  renderNote(getStatsSubset());
  notify('Descrizione aggiornata.');
}

function annullaNota() {
  notaInModifica = null;
  renderNote(getStatsSubset());
}

function rigeneraNota(chiave) {
  delete noteGrafici[chiave];
  noteGrafici.updatedAt = Date.now();
  notaInModifica = null;
  scheduleSave();
  renderNote(getStatsSubset());
  notify('Descrizione rigenerata dai dati.');
}

// ══════════════════════════════════════════════════════════════════
//  SELETTORE A RULLI — data di nascita
//  Per una data di nascita il calendario a mese è scomodo: servono
//  decine di click per arrivare al 1948. Qui si scorrono tre colonne,
//  giorno · mese · anno, e si conferma.
// ══════════════════════════════════════════════════════════════════
let rulliCampo = null;
let rulliScelta = { g: 1, m: 1, a: 1970 };

const ANNO_MIN = 1900;

function annoMax() { return new Date().getFullYear(); }

function giorniNelMese(m, a) { return new Date(a, m, 0).getDate(); }

function apriRulli(campo) {
  const pannello = el('rulliPanel');
  if (!pannello || !campo) return;
  chiudiCalendario();
  rulliCampo = campo;

  const iso = campo.getAttribute('data-iso') || '';
  if (iso) {
    const p = iso.split('-');
    rulliScelta = { g: parseInt(p[2], 10), m: parseInt(p[1], 10), a: parseInt(p[0], 10) };
  } else {
    rulliScelta = { g: 1, m: 1, a: 1960 };
  }

  renderRulli();
  pannello.classList.add('open');

  const r = campo.getBoundingClientRect();
  const larghezza = pannello.offsetWidth || 268;
  const altezza = pannello.offsetHeight || 300;
  let x = r.left;
  let y = r.bottom + 6;
  if (x + larghezza > window.innerWidth - 12) x = window.innerWidth - larghezza - 12;
  if (y + altezza > window.innerHeight - 12) y = Math.max(12, r.top - altezza - 6);
  pannello.style.left = Math.max(12, x) + 'px';
  pannello.style.top = y + 'px';

  // ogni colonna si posiziona sulla voce scelta
  requestAnimationFrame(centraRulli);
}

function chiudiRulli() {
  const p = el('rulliPanel');
  if (p) p.classList.remove('open');
  rulliCampo = null;
}

function vociRullo(tipo, voci, scelto) {
  return voci.map((v) =>
    '<button type="button" class="rullo-voce' + (v.val === scelto ? ' scelta' : '') +
    '" data-act="rullo-scegli" data-tipo="' + tipo + '" data-val="' + v.val + '">' +
    esc(v.txt) + '</button>').join('');
}

function vociGiorni(maxG) {
  const giorni = [];
  for (let i = 1; i <= maxG; i++) giorni.push({ val: i, txt: String(i).padStart(2, '0') });
  return giorni;
}

function ecoRulli() {
  const eta = calcAge(isoRulli(), val('w_data'));
  return fmtDate(isoRulli()) + (eta !== null ? ' · ' + eta + ' anni' : '');
}

/** Costruzione completa del pannello: solo all'apertura. */
function renderRulli() {
  const pannello = el('rulliPanel');
  if (!pannello) return;

  const maxG = giorniNelMese(rulliScelta.m, rulliScelta.a);
  if (rulliScelta.g > maxG) rulliScelta.g = maxG;

  const colonna = (tipo, voci, scelto, etichetta) =>
    '<div class="rullo-col"><div class="rullo-tit">' + etichetta + '</div>' +
    '<div class="rullo" data-tipo="' + tipo + '">' + vociRullo(tipo, voci, scelto) + '</div></div>';

  const mesi = MESI_LUNGHI.map((n, i) => ({ val: i + 1, txt: n }));
  const anni = [];
  for (let a = annoMax(); a >= ANNO_MIN; a--) anni.push({ val: a, txt: String(a) });

  pannello.innerHTML =
    '<div class="rulli-head">Data di nascita</div>' +
    '<div class="rulli-corpo">' +
      colonna('g', vociGiorni(maxG), rulliScelta.g, 'Giorno') +
      colonna('m', mesi, rulliScelta.m, 'Mese') +
      colonna('a', anni, rulliScelta.a, 'Anno') +
    '</div>' +
    '<div class="rulli-piede">' +
      '<span class="rulli-eco">' + esc(ecoRulli()) + '</span>' +
      '<button type="button" class="cal-azione" data-act="rulli-annulla">Annulla</button>' +
      '<button type="button" class="cal-azione rulli-ok" data-act="rulli-conferma">Conferma</button>' +
    '</div>';
}

/** Porta le colonne sulla voce scelta, senza animazione. */
function centraRulli() {
  const pannello = el('rulliPanel');
  if (!pannello) return;
  pannello.querySelectorAll('.rullo').forEach((r) => {
    const sel = r.querySelector('.rullo-voce.scelta');
    if (sel) r.scrollTop = sel.offsetTop - r.clientHeight / 2 + sel.offsetHeight / 2;
  });
}

/** Aggiorna le colonne sul posto. Prima ogni scelta ridisegnava il
 *  pannello: lo scorrimento ripartiva da zero e la colonna degli anni
 *  scorreva di nuovo fino al valore a ogni click. Ora cambia solo la
 *  voce evidenziata; i giorni si ricostruiscono solo se il mese ne ha
 *  un numero diverso, e mantenendo la posizione. */
function sincronizzaRulli(centra) {
  const pannello = el('rulliPanel');
  const colG = pannello && pannello.querySelector('.rullo[data-tipo="g"]');
  if (!colG) { renderRulli(); centraRulli(); return; }

  const maxG = giorniNelMese(rulliScelta.m, rulliScelta.a);
  if (rulliScelta.g > maxG) rulliScelta.g = maxG;
  if (colG.children.length !== maxG) {
    const pos = colG.scrollTop;
    colG.innerHTML = vociRullo('g', vociGiorni(maxG), rulliScelta.g);
    colG.scrollTop = pos;
  }
  pannello.querySelectorAll('.rullo').forEach((r) => {
    const scelto = rulliScelta[r.getAttribute('data-tipo')];
    r.querySelectorAll('.rullo-voce').forEach((v) => {
      v.classList.toggle('scelta', parseInt(v.getAttribute('data-val'), 10) === scelto);
    });
  });
  const eco = pannello.querySelector('.rulli-eco');
  if (eco) eco.textContent = ecoRulli();
  if (centra) centraRulli();
}

function isoRulli() {
  const due = (n) => String(n).padStart(2, '0');
  return rulliScelta.a + '-' + due(rulliScelta.m) + '-' + due(rulliScelta.g);
}

function scegliRullo(tipo, valore) {
  const n = parseInt(valore, 10);
  if (!isFinite(n)) return;
  if (tipo === 'g') rulliScelta.g = n;
  else if (tipo === 'm') rulliScelta.m = n;
  else if (tipo === 'a') rulliScelta.a = n;
  // la voce cliccata è già sotto gli occhi: nessuna colonna si sposta
  sincronizzaRulli(false);
}

function confermaRulli() {
  if (!rulliCampo) return;
  const campo = rulliCampo;
  setDateField(campo, isoRulli());
  chiudiRulli();
  campo.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Digitazione: le barre le mette il programma, si scrivono solo cifre. */
function formattaDigitazioneData(campo) {
  const cifre = String(campo.value || '').replace(/[^0-9]/g, '').slice(0, 8);
  let testo = cifre;
  if (cifre.length > 4) testo = cifre.slice(0, 2) + '/' + cifre.slice(2, 4) + '/' + cifre.slice(4);
  else if (cifre.length > 2) testo = cifre.slice(0, 2) + '/' + cifre.slice(2);
  campo.value = testo;
  return cifre.length === 8 ? parseDataItaliana(testo) : '';
}

// ══════════════════════════════════════════════════════════════════
//  SELECT PERSONALIZZATI
//  Ispirati al select di Uiverse (3bdel3ziz-T): freccia che ruota e
//  opzioni che scendono. Il <select> nativo resta nel DOM e continua a
//  essere la fonte del valore: val() e gli eventi change non cambiano,
//  e senza JavaScript il campo funziona comunque.
// ══════════════════════════════════════════════════════════════════
let selAperto = null;

/** Avvolge un select nativo nel menu personalizzato, una volta sola.
 *  Serve anche per i select creati dopo l'avvio. */
function avvolgiSelect(nativo) {
  if (nativo.closest('.sel-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'sel-wrap';
  nativo.parentNode.insertBefore(wrap, nativo);
  wrap.appendChild(nativo);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sel-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span class="sel-valore"></span>' +
    '<svg class="sel-freccia" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m6 9 6 6 6-6"/></svg>';

  const lista = document.createElement('div');
  lista.className = 'sel-opzioni';
  lista.setAttribute('role', 'listbox');

  wrap.appendChild(trigger);
  wrap.appendChild(lista);

  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSelect(wrap, !wrap.classList.contains('aperto'));
  });
  trigger.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggleSelect(wrap, true);
    } else if (ev.key === 'Escape') {
      toggleSelect(wrap, false);
    }
  });

  // Se il codice cambia il valore da solo (reset filtri, caricamento
  // di un esame), l'etichetta deve seguirlo.
  nativo.addEventListener('change', () => syncSelect(wrap));
  syncSelect(wrap);
}

function setupSelects() {
  document.querySelectorAll('select').forEach(avvolgiSelect);

  document.addEventListener('click', () => toggleSelect(null, false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') toggleSelect(null, false);
  });
}

/** Riallinea etichetta e opzioni al contenuto del select nativo. */
function syncSelect(wrap) {
  const nativo = wrap.querySelector('select');
  const valore = wrap.querySelector('.sel-valore');
  const lista = wrap.querySelector('.sel-opzioni');
  if (!nativo || !valore || !lista) return;

  const scelta = nativo.options[nativo.selectedIndex];
  valore.textContent = scelta ? scelta.textContent : '';
  valore.classList.toggle('vuoto', !scelta || scelta.value === '');

  lista.textContent = '';
  Array.prototype.forEach.call(nativo.options, (opt, i) => {
    const voce = document.createElement('button');
    voce.type = 'button';
    voce.className = 'sel-opzione' + (i === nativo.selectedIndex ? ' scelta' : '');
    voce.setAttribute('role', 'option');
    voce.setAttribute('aria-selected', i === nativo.selectedIndex ? 'true' : 'false');
    voce.textContent = opt.textContent;
    voce.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (nativo.selectedIndex !== i) {
        nativo.selectedIndex = i;
        nativo.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        syncSelect(wrap);
      }
      toggleSelect(wrap, false);
    });
    lista.appendChild(voce);
  });
}

function toggleSelect(wrap, apri) {
  if (selAperto && selAperto !== wrap) {
    selAperto.classList.remove('aperto');
    const t = selAperto.querySelector('.sel-trigger');
    if (t) t.setAttribute('aria-expanded', 'false');
    selAperto = null;
  }
  if (!wrap) return;
  wrap.classList.toggle('aperto', !!apri);
  const t = wrap.querySelector('.sel-trigger');
  if (t) t.setAttribute('aria-expanded', apri ? 'true' : 'false');
  selAperto = apri ? wrap : null;
}

/** Da chiamare quando le opzioni di un select vengono ricostruite. */
function refreshSelect(id) {
  const nativo = el(id);
  if (!nativo) return;
  const wrap = nativo.closest('.sel-wrap');
  if (wrap) syncSelect(wrap);
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

    // La data di nascita usa i rulli: sul calendario a mese servirebbero
    // decine di click per arrivare agli anni Quaranta.
    const conRulli = campo.id === 'w_dob';
    const apri = () => (conRulli ? apriRulli(campo) : apriCalendario(campo));
    campo.addEventListener('focus', apri);
    campo.addEventListener('click', apri);

    // Digitando si scrivono solo cifre: le barre le mette il programma.
    campo.addEventListener('input', () => {
      const iso = formattaDigitazioneData(campo);
      campo.setAttribute('data-iso', iso);
      if (!iso) return;
      if (conRulli) {
        const p = iso.split('-');
        rulliScelta = { g: +p[2], m: +p[1], a: +p[0] };
        if (rulliCampo === campo) sincronizzaRulli(true);
      } else {
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
      if (ev.key === 'Escape') { chiudiCalendario(); chiudiRulli(); campo.blur(); }
      if (ev.key === 'Enter') { chiudiCalendario(); chiudiRulli(); }
    });
  });

  document.addEventListener('click', (ev) => {
    if (ev.target.closest('#calPanel') || ev.target.closest('#rulliPanel') ||
        ev.target.closest('input[data-date]')) return;
    chiudiCalendario();
    chiudiRulli();
  });
  window.addEventListener('resize', () => { chiudiCalendario(); chiudiRulli(); });
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
  // a moto ridotto le pillole del dock tornano subito a riposo: senza il
  // ciclo d'animazione nessuno le rimetterebbe a posto
  if (PREFS.reduceMotion) resetDock();
  document.querySelectorAll('[data-act="pref"]').forEach((btn) => {
    const chiave = btn.getAttribute('data-pref');
    btn.setAttribute('aria-checked', PREFS[chiave] ? 'true' : 'false');
  });
  // il pannello cambia larghezza: il fondino delle schede va riallineato
  setTimeout(moveTabHighlight, 60);
}

function togglePref(chiave) {
  if (!(chiave in PREFS_DEFAULT)) return;
  PREFS[chiave] = !PREFS[chiave];
  savePrefs();
  applyPrefs();
  if (chiave === 'dense') moveTabHighlight();
}

let railAperto = null;

/** Apre o chiude il pannello laterale. Cliccando l'icona già attiva si
 *  richiude, e il contenuto della pagina torna a larghezza piena. */
function toggleRail(pan) {
  // un pannello laterale non si apre sopra la pagina di personalizzazione
  if (pan && personalizzazioneAperta()) closeOverlay('modPersonalizza');
  const chiudi = !pan || railAperto === pan;
  railAperto = chiudi ? null : pan;

  // Il cambio di larghezza avviene in un colpo solo: il dock e lo stato
  // scivolano nella nuova posizione (FLIP), il contenuto rientra con una
  // breve dissolvenza che nasconde il riadattamento del testo.
  const mobili = [el('navDock'), document.querySelector('.nav-right')].filter(Boolean);
  const prima = mobili.map((e) => e.getBoundingClientRect().left);
  document.body.classList.toggle('rail-aperto', !chiudi);
  const pannello = el('railPannello');
  if (pannello) pannello.classList.toggle('aperto', !chiudi);
  const piede = document.querySelector('.app-footer');
  if (piede) piede.classList.toggle('rail-aperto', !chiudi);
  if (!PREFS.reduceMotion) {
    // Una lettura per tutti, poi le scritture, poi una sola
    // riappacificazione: letture e scritture alternate obbligavano il
    // motore a rifare l'impaginazione due volte per ogni elemento, e
    // qui la pagina ha appena cambiato larghezza.
    const dopo = mobili.map((e) => e.getBoundingClientRect().left);
    const vp = el('viewsPort');
    if (vp) vp.classList.remove('rientra');
    const scostati = [];
    mobili.forEach((e, i) => {
      const dx = prima[i] - dopo[i];
      if (!dx) return;
      e.style.transition = 'none';
      e.style.transform = 'translateX(' + dx + 'px)';
      scostati.push(e);
    });
    void document.body.offsetWidth;
    scostati.forEach((e) => {
      e.style.transition = 'transform .5s cubic-bezier(.22,1,.36,1)';
      e.style.transform = '';
      setTimeout(() => { e.style.transition = ''; }, 540);
    });
    if (vp) vp.classList.add('rientra');
  }
  // Solo i pulsanti con un pannello: Reparto apre una pagina e non ha
  // data-pan, e a pannelli chiusi "null === null" lo segnava selezionato.
  document.querySelectorAll('.rail-btn[data-pan]').forEach((b) => {
    b.setAttribute('aria-selected', b.getAttribute('data-pan') === railAperto ? 'true' : 'false');
  });
  document.querySelectorAll('.pan').forEach((sez) => {
    const suo = sez.getAttribute('data-pan') === railAperto;
    sez.classList.remove('attivo');
    if (suo) {
      // le voci del pannello entrano a cascata da destra
      Array.prototype.forEach.call(sez.children, (c, i) => c.style.setProperty('--i', String(Math.min(i, 12))));
      void sez.offsetWidth;
      sez.classList.add('attivo');
    }
  });

  if (railAperto === 'info' || railAperto === 'archivio') refreshSettingsInfo();
  // il fondino è relativo al dock: si riallinea subito
  requestAnimationFrame(moveTabHighlight);
}

/** Compatibilità con i vecchi punti di chiamata: chiudere il menu. */
function toggleSettings(forza) {
  if (forza === false) toggleRail(null);
}

function refreshSettingsInfo() {
  const info = el('smInfo');
  const percorso = el('panPercorso');
  const righe = ['ER Oncology Archivist ' + (appInfo.version || ''),
                 'Electron ' + (appInfo.electron || '—')];
  if (IS_ELECTRON) {
    righe.push(dataFolder ? 'Cartella: ' + dataFolder : 'Cartella dati non ancora scelta');
    if (readOnly) righe.push('Sola lettura');
  } else {
    righe.push('Modalità browser — i dati non vengono salvati');
  }
  if (info) {
    info.textContent = '';
    righe.forEach((r) => {
      const d = document.createElement('div');
      d.textContent = r;
      info.appendChild(d);
    });
  }
  if (percorso) {
    percorso.textContent = IS_ELECTRON
      ? (dataFolder ? 'Cartella corrente: ' + dataFolder : 'Nessuna cartella dati configurata.')
      : 'Modalità browser: i dati non vengono salvati.';
  }
}

/** Copia di sicurezza dell'archivio su chiavetta USB.
 *  La ricerca dell'unità, la conferma e la scrittura avvengono nel
 *  processo principale: il renderer non tocca mai un percorso. */
/** Copia di sicurezza dell'archivio su chiavetta USB. Il processo
 *  principale rileva le unità e scrive; scelta e avvertenza sono finestre
 *  del tool. Il renderer passa solo una lettera di unità, che il processo
 *  principale accetta solo se è davvero rimovibile. */
async function safetyNet() {
  if (!IS_ELECTRON) { notify('Disponibile solo nell’applicazione desktop.'); return; }
  if (!storageReady) { notify('Serve prima una cartella dati leggibile.'); return; }
  notify('Cerco un’unità rimovibile…');
  try {
    const unita = await API.unitaRimovibili();
    if (!unita || !unita.length) {
      await avviso({ tipo: 'info', titolo: 'Nessuna chiavetta USB rilevata',
        messaggio: 'Inserisci una chiavetta e riprova.',
        dettaglio: 'Le unità protette in scrittura non vengono proposte.' });
      return;
    }
    let scelta = unita[0];
    if (unita.length > 1) {
      const indice = await dialogo({
        tipo: 'info',
        titolo: 'Su quale unità salvare la copia?',
        messaggio: 'Sono collegate ' + unita.length + ' unità rimovibili.',
        pulsanti: [{ testo: 'Annulla' }].concat(unita.map((u) => ({ testo: u.lettera + '  ' + u.etichetta, stile: 'primario' }))),
        predefinito: 1,
        annulla: 0
      });
      if (indice < 1) { notify('Copia annullata.'); return; }
      scelta = unita[indice - 1];
    }
    // sono dati sanitari: la conferma deve essere esplicita e informata
    const ok = await conferma({
      tipo: 'avviso',
      titolo: 'Copiare l’archivio su ' + scelta.lettera + ' (' + scelta.etichetta + ')?',
      messaggio: 'Il file contiene dati sanitari in chiaro: nomi, date di nascita e diagnosi.',
      dettaglio: 'Conserva la chiavetta come si conserva una cartella clinica, e cancellala quando non serve più.',
      conferma: 'Copia'
    });
    if (!ok) { notify('Copia annullata.'); return; }

    const r = await API.safetyNet(scelta.lettera);
    if (!r || r.stato === 'nessuna-unita') {
      notify('La chiavetta non è più disponibile: reinseriscila e riprova.');
    } else if (r.stato === 'senza-cartella') {
      notify('Cartella dati non configurata.');
    } else if (r.stato === 'ok') {
      notify('Copia salvata su ' + r.unita + ' (' + r.esami + ' esami).');
      refreshSettingsInfo();
    } else {
      await avviso({ tipo: 'errore', titolo: 'Copia non riuscita', messaggio: r.messaggio || 'Errore sconosciuto.' });
    }
  } catch (e) {
    await avviso({ tipo: 'errore', titolo: 'Copia non riuscita', messaggio: e.message });
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
// ══════════════════════════════════════════════════════════════════
//  INTRO — la sequenza, in un posto solo
//
//  Ogni voce e' un millisecondo dall'inizio dell'intro, o una durata.
//  Le durate che servono anche al CSS gli vengono passate da
//  scriviTempiIntro() come proprieta' --t-*: prima meta' dei ritardi
//  stava qui e meta' scritta a mano nel CSS, e cambiarne uno sfasava
//  silenziosamente l'altro.
//
//  Il totale e' volutamente contenuto: e' uno strumento che si apre
//  molte volte per turno, un'intro lunga e' attrito.
// ══════════════════════════════════════════════════════════════════
const INTRO = {
  // atto I — il logo si disegna al centro
  tracciaDur: 650,        // il tracciato si scrive
  riempi: 250,            // quando entra il riempimento
  riempiDur: 450,
  posaDur: 620,           // il logo si assesta alla sua scala finale

  // atto II — il logo scivola a sinistra, il titolo si compone
  slitta: 760,            // quando il logo parte verso sinistra
  slittaDur: 700,
  glifo: 900,             // primo glifo
  glifoPasso: 12,         // sfalsamento fra un glifo e il successivo
  glifoDur: 340,

  // atto III — il sottotitolo
  sotto: 1600,
  sottoDur: 600,

  attesa: 2750,           // quando parte l'uscita
  volo: 800               // volo del logo verso la barra
};
const INTRO_FLIGHT = INTRO.volo;
const VELO_DURATA = 950;          // risalita della banda, come nel CSS
const BARRA_PASSO = 55;           // cascata del contenuto della barra
const POP_STEP = 90;              // cascata fra una sezione e la successiva
const ATTESA_AVVIO = 1500;        // quanto si aspetta l'archivio prima di partire

let introTimer = null;
let introClosed = false;
let hexCells = null;

/** Segna l'intro in corso sui soli contenitori interessati: barra,
 *  colonna delle icone, pie' di pagina. Sul body costerebbe un
 *  ricalcolo di stile dell'intera pagina, due volte per ogni avvio. */
function segnaIntro(attiva) {
  ['nav', '#sideRail', '.app-footer'].forEach((sel) => {
    const e = document.querySelector(sel);
    if (e) e.classList.toggle('intro-in-corso', attiva);
  });
}

/** Prepara la scena, ferma. L'animazione non parte da qui: parte da
 *  avviaQuandoPronto(), a costruzione dell'interfaccia finita.
 *  Ritorna false se l'intro e' disattivata. */
function preparaIntro() {
  const stage = el('splashStage');
  const screen = el('splashScreen');
  if (!stage || !screen) return false;

  // Chi apre il programma venti volte al giorno l'intro non la vuole.
  if (PREFS.skipIntro || PREFS.reduceMotion) {
    screen.classList.add('closing');
    stage.classList.add('settled');
    if (el('navLogo')) el('navLogo').classList.add('landed');
    introClosed = true;
    return false;
  }

  segnaIntro(true);

  scriviTempiIntro(stage);
  preparaLogoIntro();
  preparaTitoloIntro();

  screen.addEventListener('click', closeIntro);
  document.addEventListener('keydown', introKeyHandler);
  return true;
}

/** Il via all'animazione.
 *
 *  Sta qui la differenza fra un'intro fluida e una a scatti: quando
 *  parte, il filo principale dev'essere libero. Costruire l'interfaccia
 *  (il primo impaginamento di tutta la pagina, l'archivio, i grafici)
 *  costa qualche decimo di secondo pieno, e prima quel lavoro cadeva in
 *  mezzo all'atto I: misurato a CPU rallentata quattro volte, un
 *  fotogramma da 306 ms proprio mentre il logo si disegna.
 *  Ora si aspetta: la scena resta ferma sul fondo scuro mentre tutto si
 *  costruisce, e l'animazione comincia dopo. L'attesa non si vede,
 *  perche' non c'e' ancora niente da guardare. */
function avviaQuandoPronto(dati) {
  const stage = el('splashStage');
  if (!stage || introClosed) return;

  let partito = false;
  const via = () => {
    if (partito || introClosed) return;
    partito = true;
    // La misura va presa ora, a pagina impaginata: e' la larghezza vera
    // del titolo che decide di quanto il logo parte spostato.
    misuraSpostamentoLogo(stage);
    void stage.offsetWidth;
    stage.classList.add('playing');
    introTimer = setTimeout(closeIntro, INTRO.attesa);
  };

  // L'impaginazione si forza qui, a scena ferma: cosi' il primo
  // fotogramma dell'intro non se la trova davanti. Poi due giri di
  // fotogramma, perche' le animazioni CSS non avanzano finche' la
  // finestra non viene davvero dipinta (Electron la crea con show:false).
  const pronto = () => {
    if (partito || introClosed) return;
    void document.body.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(via));
  };

  Promise.resolve(dati).catch(() => {}).then(pronto);
  // Se la cartella e' su una share lenta, non si aspetta all'infinito.
  setTimeout(pronto, ATTESA_AVVIO);
  // Rete di sicurezza: se la finestra restasse nascosta i fotogrammi non
  // arriverebbero mai. Meglio un'intro non vista che restare fermi qui.
  setTimeout(via, ATTESA_AVVIO + 900);
}

/** I tempi della sequenza arrivano al CSS da qui: unica fonte. */
function scriviTempiIntro(stage) {
  const ms = (n) => n + 'ms';
  stage.style.setProperty('--t-traccia-dur', ms(INTRO.tracciaDur));
  stage.style.setProperty('--t-riempi', ms(INTRO.riempi));
  stage.style.setProperty('--t-riempi-dur', ms(INTRO.riempiDur));
  stage.style.setProperty('--t-posa-dur', ms(INTRO.posaDur));
  stage.style.setProperty('--t-slitta', ms(INTRO.slitta));
  stage.style.setProperty('--t-slitta-dur', ms(INTRO.slittaDur));
  stage.style.setProperty('--t-glifo-dur', ms(INTRO.glifoDur));
  stage.style.setProperty('--t-sotto', ms(INTRO.sotto));
  stage.style.setProperty('--t-sotto-dur', ms(INTRO.sottoDur));
}

/** pathLength=1 normalizza la lunghezza del tracciato a 1, cosi'
 *  stroke-dashoffset funziona su qualunque geometria. E' anche cio' che
 *  rende superfluo getTotalLength(), che sui tracciati compositi (le
 *  lettere con i fori) restituiva valori sbagliati. */
function preparaLogoIntro() {
  document.querySelectorAll('.splash-logo-svg-wrap path').forEach((path) => {
    path.setAttribute('pathLength', '1');
    path.classList.add('splash-logo-path');
  });
}

/** Il titolo si compone da sinistra a destra, nel verso di lettura.
 *  L'ordine e' quello delle ascisse vere, non quello dei nodi: le
 *  lettere con un foro (R, o, a, d) sono tracciati compositi e nel
 *  documento stanno in un ordine che sull'asse x torna indietro dodici
 *  volte su cinquanta. Seguendo i nodi, il titolo si ricomponeva a
 *  chiazze, con parole gia' piene e lettere precedenti ancora vuote.
 *  I tracciati che condividono la stessa ascissa entrano insieme, che
 *  e' quello che si vuole: il contorno e il suo foro sono una lettera
 *  sola. */
function preparaTitoloIntro() {
  const glifi = Array.prototype.slice.call(document.querySelectorAll('.splash-glyph'));
  const voci = glifi.map((g, i) => {
    let x = null;
    // getBBox non esiste sugli elementi non resi: in quel caso si ricade
    // sull'ordine dei nodi, che e' comunque una sequenza sensata.
    try { x = g.getBBox().x; } catch (_) { x = null; }
    return { g: g, x: isFinite(x) ? x : i, doc: i };
  });
  voci.sort((a, b) => (a.x - b.x) || (a.doc - b.doc));

  let passo = -1;
  let xPrec = null;
  voci.forEach((voce) => {
    // stessa ascissa, stesso turno
    if (xPrec === null || Math.abs(voce.x - xPrec) > 0.01) passo++;
    xPrec = voce.x;
    voce.g.style.setProperty('--d', (INTRO.glifo + passo * INTRO.glifoPasso) + 'ms');
  });
}

/** Il logo parte al centro della finestra e scivola al suo posto.
 *  Logo e titolo stanno gia' nelle posizioni finali: quello che si
 *  anima e' solo lo scostamento della riga, pari a meta' dell'ingombro
 *  del titolo. Cosi' nessuno dei due si muove per via del layout. */
function misuraSpostamentoLogo(stage) {
  const riga = document.querySelector('.splash-logo-row');
  const titolo = el('splashTitleWrap');
  if (!riga || !titolo) return;
  const largo = titolo.getBoundingClientRect().width;
  riga.style.setProperty('--spostamento', (largo / 2).toFixed(1) + 'px');
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

/** Atterraggio. Il logo volante resta fermo al suo posto, sopra il
 *  velo, finché la banda non si è dissolta sulla barra: il logo della
 *  barra, sotto, sarebbe ancora coperto. Solo allora i due si scambiano
 *  in un fotogramma: coincidono al pixel, quindi non si vede nulla. */
function finishIntro() {
  const navLogo = el('navLogo');
  if (navLogo) navLogo.classList.add('landed');

  if (hexCells) {
    const durata = revealFromHex();
    hexCells = null;
    setTimeout(chiudiSplash, durata);
  } else {
    chiudiSplash();
    popBarra();
    popSections(currentView);
  }
}

/** Il logo volante sparisce di colpo e lo splash, ormai trasparente,
 *  si toglie di mezzo. */
function chiudiSplash() {
  const screen = el('splashScreen');
  const logoBtn = el('splashLogo');
  if (logoBtn) logoBtn.classList.add('atterrato');
  if (screen) screen.classList.add('closing');

  // Finita la dissolvenza la scena si toglie proprio dalla pagina.
  // Spegnerne le animazioni con una classe costava un ricalcolo di
  // stile su tutti e 51 i glifi del titolo nel bel mezzo della
  // risalita (misurato: 312 ms a CPU rallentata otto volte); e i
  // tracciati resterebbero li' per sempre, a farsi riesaminare ad ogni
  // ricalcolo dell'applicazione. Non servono piu' a nessuno.
  setTimeout(() => {
    const s = el('splashScreen');
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }, 700);
}

/** Il contenuto della barra compare a cascata: titolo, dock, singole
 *  voci del dock, stato, icone del pannello laterale, piè di pagina. */
function popBarra() {
  const elementi = [].concat(
    [document.querySelector('.nav-title > span:not(.nav-logo)'),
     document.querySelector('.nav-sub'),
     el('navDock')],
    Array.prototype.slice.call(document.querySelectorAll('.dock-item')),
    [document.querySelector('.nav-right')],
    Array.prototype.slice.call(document.querySelectorAll('.rail-btn')),
    [document.querySelector('.app-footer')]
  ).filter(Boolean);

  if (PREFS.reduceMotion) { segnaIntro(false); return; }

  elementi.forEach((e) => e.classList.remove('pop-barra'));
  void document.body.offsetWidth;
  elementi.forEach((e, i) => {
    e.style.setProperty('--pop-delay', (i * BARRA_PASSO) + 'ms');
    e.classList.add('pop-barra');
  });

  // Il fondino vive dentro il dock, quindi compariva insieme al
  // contenitore: una pillola scura su una barra ancora vuota, per i
  // tre quarti di secondo che le schede impiegavano ad arrivare. Si
  // accende quando l'ultima scheda e' al suo posto, e scivola sotto
  // quella attiva. Non gli si mette 'pop-barra': quell'animazione
  // scrive transform, che qui porta la posizione orizzontale.
  const fondino = el('navTabHighlight');
  let ultimaScheda = -1;
  elementi.forEach((e, i) => { if (e.classList.contains('dock-item')) ultimaScheda = i; });
  if (fondino && ultimaScheda >= 0) {
    fondino.classList.remove('ready');
    setTimeout(() => fondino.classList.add('ready'), ultimaScheda * BARRA_PASSO + 260);
  }
  // il fill "both" tiene nascosto ciascun elemento fino al suo turno:
  // si può togliere subito la classe che li nascondeva tutti
  segnaIntro(false);

  // A fine animazione la classe va via: il fill terrebbe transform:none
  // per sempre, e le icone del pannello perderebbero l'ingrandimento al
  // passaggio del puntatore.
  setTimeout(() => elementi.forEach((e) => {
    e.classList.remove('pop-barra');
    e.style.removeProperty('--pop-delay');
  }), elementi.length * BARRA_PASSO + 560);
}

/** Fa comparire a cascata le sezioni della vista indicata.
 *  Riavvia sempre da zero: senza togliere la classe, riattivarla non
 *  fa ripartire l'animazione. */
function popSections(view) {
  applicaPop(sezioniVisibili(view));
}

/** Sola lettura: quali sezioni della vista sono davvero a schermo.
 *  Separata da applicaPop() perche' chi sta per cambiare mezza pagina
 *  (la risalita del velo) possa leggere prima e scrivere dopo, in una
 *  sola impaginazione invece di due. */
function sezioniVisibili(view) {
  if (PREFS.reduceMotion) return [];
  const root = el('view-' + view);
  if (!root) return [];
  const sezioni = Array.prototype.slice.call(root.querySelectorAll('.pop-section'));

  // Tre passate distinte: prima si legge, poi si toglie, poi si riscrive.
  // Alternare letture e scritture sullo stesso elemento obbligava il
  // motore a rifare il layout ad ogni giro del ciclo, e su una vista da
  // cinquemila nodi erano quasi cinquecento millisecondi di blocco in
  // mezzo al cambio di vista.
  // Si toglie prima la classe a tutte, poi si leggono le visibilita'.
  // Quell'unica lettura e' anche la riappacificazione che fa ripartire
  // l'animazione: leggere prima e riappacificare dopo erano due passate
  // di layout invece di una.
  sezioni.forEach((e) => e.classList.remove('popping'));
  // le sezioni non visibili (step del wizard nascosti) non contano
  return sezioni.filter((e) => e.offsetParent !== null);
}

/** Sola scrittura: fa entrare a cascata le sezioni gia' scelte. */
function applicaPop(visibili) {
  visibili.forEach((e, i) => {
    e.style.setProperty('--pop-delay', (i * POP_STEP) + 'ms');
    e.classList.add('popping');
  });
}


/** Arma il velo che copre l'applicazione. Si prepara mentre il logo
 *  vola, così a fine volo la risalita parte senza scatti. */
function buildHexVeil() {
  const veil = el('hexReveal');
  if (!veil || PREFS.reduceMotion) return null;
  veil.classList.remove('revealing');
  veil.classList.add('armed');
  return true;
}

/** La banda risale dal bordo inferiore trascinando la pagina, vira al
 *  nero salendo e si ferma sull'altezza della barra, dove si dissolve
 *  sulla barra vera. Consolidata la barra, il suo contenuto compare a
 *  cascata. */
function revealFromHex() {
  const veil = el('hexReveal');
  if (!veil) { popBarra(); popSections(currentView); return 0; }

  // ── prima tutte le letture ──
  // Le classi qui sotto cambiano mezza pagina: leggere dopo averle
  // messe costringerebbe il motore a rifare subito l'impaginazione, in
  // mezzo al fotogramma in cui parte la risalita.
  const nav = document.querySelector('nav');
  const altezzaNav = nav ? nav.getBoundingClientRect().height : 52;
  const H = window.innerHeight;
  const sezioni = sezioniVisibili(currentView);

  // ── poi tutte le scritture ──
  veil.style.setProperty('--velo-corsa', Math.round(H - altezzaNav) + 'px');
  // la pagina parte dal fondo della finestra e arriva sotto la barra.
  // La proprieta' sta sulla vista e non sul body: una variabile che
  // cambia sul body si eredita ovunque, e ovunque va ricalcolata.
  const porta = el('viewsPort');
  if (porta) porta.style.setProperty('--salita', Math.round(H - altezzaNav) + 'px');

  void veil.offsetWidth;
  veil.classList.add('revealing');
  if (porta) porta.classList.add('sale');

  // le schede arrivano trascinate dalla banda, con la loro molla
  applicaPop(sezioni);
  // la banda diventa barra al 62% della corsa: da lì la barra si popola
  setTimeout(popBarra, Math.round(VELO_DURATA * 0.62) + 30);

  setTimeout(() => {
    veil.classList.remove('armed', 'revealing');
    if (porta) { porta.classList.remove('sale'); porta.style.removeProperty('--salita'); }
  }, VELO_DURATA + 60);
  return VELO_DURATA;
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
  // un secondo click sul toggle attivo lo spegne e richiude la sua sezione
  'set-onco': (t) => { const v = t.getAttribute('data-val'); setOnco(wOnco === v ? null : v); },
  'set-class': (t) => setClassTumore(wPrimo ? null : t.getAttribute('data-val')),
  'set-sottocat': (t) => { const v = t.getAttribute('data-val'); setSottocat(wSottocat === v ? null : v); },
  'set-meta': (t) => { const v = t.getAttribute('data-val'); setMetastasi(wMetastasi === v ? null : v); },
  'grafico': (t) => selezionaGrafico(t.getAttribute('data-graf'), t.getAttribute('data-k')),
  'grafico-chiudi': (t) => chiudiSceltaGrafico(t.getAttribute('data-graf')),
  'rail': (t) => toggleRail(t.getAttribute('data-pan')),
  'pref': (t) => togglePref(t.getAttribute('data-pref')),
  'nota-modifica': (t) => modificaNota(t.getAttribute('data-nota')),
  'nota-salva': (t) => salvaNota(t.getAttribute('data-nota')),
  'nota-annulla': () => annullaNota(),
  'nota-auto': (t) => rigeneraNota(t.getAttribute('data-nota')),
  'rullo-scegli': (t) => scegliRullo(t.getAttribute('data-tipo'), t.getAttribute('data-val')),
  'rulli-conferma': () => confermaRulli(),
  'rulli-annulla': () => chiudiRulli(),
  'cal-pick': (t) => scegliData(t.getAttribute('data-iso')),
  'cal-mese': (t) => { if (!calMese) return; calMese.setMonth(calMese.getMonth() + (parseInt(t.getAttribute('data-delta'), 10) || 0)); renderCalendario(); },
  'cal-oggi': () => scegliData(isoDiOggi()),
  'cal-vuota': () => scegliData(''),
  'tipi-aggiungi': () => aggiungiTipoEsame(),
  'tipi-su': (t) => spostaTipoEsame(parseInt(t.getAttribute('data-idx'), 10), -1),
  'tipi-giu': (t) => spostaTipoEsame(parseInt(t.getAttribute('data-idx'), 10), 1),
  'tipi-elimina': (t) => eliminaTipoEsame(parseInt(t.getAttribute('data-idx'), 10)),
  'tipi-ripristina': () => ripristinaTipiEsame(),
  'tipo-modifica': () => modalitaTipoLibera(el('tipoSelHost').classList.contains('nascosto') ? false : true),
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
  'export-open': () => apriOverlay(el('modExport')),
  'export-xlsx': (t) => { closeOverlay('modExport'); exportExcel(t.getAttribute('data-anon') === '1'); },
  'export-csv': (t) => { closeOverlay('modExport'); exportCSV(t.getAttribute('data-anon') === '1'); },
  'export-pdf': () => { closeOverlay('modExport'); exportPDF(); },
  'export-pptx': () => { closeOverlay('modExport'); exportPPTX(); },
  'welcome-select': () => welcomeSelectFolder(),
  'select-folder': () => selectFolder(),
  'reload': async () => {
    if (!IS_ELECTRON || !dataFolder) return;
    await scaricaSalvataggi();
    activateFolder(true);
  },
  'safety-net': () => safetyNet(),
  'richiesta-usa': (t) => usaRichiesta(t.getAttribute('data-testo')),
  'crono-apri': () => apriCronologia(),
  'dialogo-scelta': (t) => sceltaDialogo(parseInt(t.getAttribute('data-idx'), 10)),
  'personalizza-apri': () => apriPersonalizzazione(),
  'pers-tab': (t) => mostraTabPersonalizzazione(t.getAttribute('data-tab')),
  'pers-categoria': (t) => selezionaCategoria(t.getAttribute('data-cat')),
  'pers-termine': (t) => usaTermineProva(t.getAttribute('data-testo')),
  'pers-parola-aggiungi': (t) => aggiungiParolaChiave(t.getAttribute('data-cat')),
  'pers-parola-elimina': (t) => eliminaParolaChiave(parseInt(t.getAttribute('data-idx'), 10)),
  'pers-ripristina': () => ripristinaCategorie(),
  'crono-esame': (t) => impostaTipoEsame(t.getAttribute('data-tipo')),
  'pick': (t) => {
    const target = el(t.getAttribute('data-target'));
    if (target) { target.value = t.getAttribute('data-value') || ''; }
  }
};

function wireEvents() {
  setupGrafici();
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
  on('w_tipo_sel', 'change', () => {
    const campo = el('w_tipo_esame');
    if (campo) campo.value = val('w_tipo_sel');
    liveValidate2();
    renderCronologia();
  });
  on('tipiNuovo', 'keydown', (ev) => { if (ev.key === 'Enter') aggiungiTipoEsame(); });
  on('persProva', 'input', renderProva);
  on('modPersonalizza', 'change', (ev) => {
    if (ev.target.classList.contains('pers-esame')) {
      impostaEsameCategoria(ev.target.getAttribute('data-cat'), ev.target.value);
    }
  });
  on('modPersonalizza', 'keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.classList.contains('pers-nuova')) {
      ev.preventDefault();
      aggiungiParolaChiave(ev.target.getAttribute('data-cat'));
    }
  });
  on('w_richiesta', 'input', () => { liveValidate2(); pianificaCronologia(); });

  ['fOnco', 'fPrima', 'fClassTumore', 'fMeta', 'fSesso', 'fTipo'].forEach((id) => on(id, 'change', applyFilters));
  on('fSearch', 'input', applyFilters);
  ['sfDal', 'sfAl', 'sfTipo', 'sfFocus'].forEach((id) => on(id, 'change', () => {
    renderStats();
    avviaAnimazioniGrafici(false);
  }));

  on('chkAll', 'change', (ev) => toggleAll(ev.target.checked));
  const tbody = el('tblBody');
  if (tbody) {
    tbody.addEventListener('change', (ev) => {
      if (ev.target.classList.contains('rchk')) toggleRow(ev.target);
    });
  }

  document.querySelectorAll('.overlay').forEach((m) => {
    m.addEventListener('click', (ev) => { if (ev.target === m) chiudiOverlay(m); });
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      // con una finestra di dialogo aperta, Esc chiude solo quella
      if (dialogoAperto) { chiudiOverlay(el('modDialogo')); return; }
      toggleRail(null);
      document.querySelectorAll('.overlay.open').forEach(chiudiOverlay);
    }
  });

  window.addEventListener('resize', moveTabHighlight);

  // chiusura della finestra: salvataggi e lock passano da preparaChiusura
  if (IS_ELECTRON && typeof API.onRichiestaChiusura === 'function') {
    API.onRichiestaChiusura(preparaChiusura);
  }
  window.addEventListener('pagehide', releaseLock);
}

// ══════════════════════════════════════════════════════════════════
//  AVVIO — dopo che tutte le dichiarazioni globali esistono
// ══════════════════════════════════════════════════════════════════
function boot() {
  setupSelects();
  aggiornaSelettoreTipo();
  setupCalendari();
  setupNavLogo();
  setupSettings();
  setupDock();              // prima dell'intro: i cloni devono essere "puliti"

  // La scena iniziale esiste subito e copre lo schermo, ma resta ferma.
  preparaIntro();

  // Tutto il resto dell'avvio avviene qui, dietro allo splash fermo:
  // nessuna animazione in corso, nessun fotogramma da perdere.
  wireEvents();
  applyViewState();
  buildProgress();
  renderFUList();
  liveValidate1();
  liveValidate2();

  // checkServer legge l'archivio e ridisegna tabella e grafici: e' il
  // pezzo piu' pesante dell'avvio, e l'intro lo aspetta.
  avviaQuandoPronto(checkServer());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
