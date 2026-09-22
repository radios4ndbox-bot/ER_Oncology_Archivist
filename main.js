'use strict';

/* ══════════════════════════════════════════════════════════════════
   ER Oncology Archivist — processo principale Electron
   ------------------------------------------------------------------
   Regole di sicurezza applicate:
   · contextIsolation ON, nodeIntegration OFF, sandbox ON
   · il renderer NON riceve mai un percorso arbitrario: la cartella dati
     è stato del solo processo principale e i nomi file sono su allowlist
   · nessuna navigazione fuori dall'app, nessuna finestra secondaria
   · scritture atomiche (tmp + rename) per non corrompere il file su
     share di rete
   ══════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, dialog, Menu, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const url = require('url');
const { execFile } = require('child_process');

// ── Costanti ──────────────────────────────────────────────────────
const DATA_FILE = 'ER OA Archive.json';
const LOCK_FILE = 'ER OA Archive.lock';
/** Nomi usati fino alla 2.3.0: si migrano da soli alla prima apertura. */
const DATA_FILE_VECCHIO = 'ps_onco_data.json';
const LOCK_FILE_VECCHIO = 'ps_onco.lock';
/** Unici nomi file che il renderer può nominare. Nessun path, nessun
 *  separatore: il path traversal è strutturalmente impossibile. */
const ALLOWED_FILES = new Set([DATA_FILE, LOCK_FILE]);
const CONFIG_FILE = 'psonco-config.json';
/** Il backup e' un file solo, sempre lo stesso, sovrascritto ad ogni
 *  giro: nella cartella scelta e sulla chiavetta. Una copia sola non si
 *  puo' sbagliare, non riempie il disco e non lascia in giro vecchi
 *  archivi con dati sanitari di cui nessuno si ricorda piu'. */
const BACKUP_FILE = 'backup_ER_OA.json';
const GIORNI_BACKUP = 15;
const INTERVALLO_BACKUP = GIORNI_BACKUP * 24 * 60 * 60 * 1000;
/** Ogni ora si guarda se sono passati i quindici giorni: il programma
 *  puo' restare aperto per giorni di fila. */
const CONTROLLO_BACKUP = 60 * 60 * 1000;
/** Il primo controllo non cade sull'avvio, che ha gia' da fare. */
const PRIMO_CONTROLLO = 45 * 1000;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;   // 64 MB
const MAX_EXPORT_CHARS = 96 * 1024 * 1024; // 96 MB di base64
const IS_DEV = !app.isPackaged;
/** Modalità sviluppo: si attiva SOLO con `npm run dev` su un'app non
 *  impacchettata. Nel .exe distribuito app.isPackaged è true, quindi
 *  niente di quanto segue può attivarsi. */
const DEV_MODE = IS_DEV && process.argv.indexOf('--dev') !== -1;
// Gli strumenti di sviluppo falsano le misure di fluidita': con --senza-devtools
// si avvia in modalita' sviluppo senza aprirli.
const DEV_TOOLS = DEV_MODE && process.argv.indexOf('--senza-devtools') === -1;
const ICONA = path.join(__dirname, 'build', 'icon.ico');
const LOCK_MAX_BYTES = 4096;
const ATTESA_CHIUSURA = 20000;   // tempo concesso al renderer per salvare

const COLORE_FINESTRA = '#0e1017';

// Piè di pagina del report, nel margine inferiore. Il modello non eredita
// nulla dalla pagina: dimensione e colore vanno scritti qui.
const PIEDE_PDF =
  '<div style="width:100%;padding:0 12mm;display:flex;justify-content:space-between;' +
  'font-family:Segoe UI,Arial,sans-serif;font-size:7.5px;color:#8A8880;">' +
  '<span>ER Oncology Archivist · Report statistico · Documento a uso interno, contiene dati clinici aggregati</span>' +
  '<span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>';

// ── Stato del solo processo principale ────────────────────────────
let mainWindow = null;
/** @type {BrowserWindow|null} finestra separata della safety net */
let safetyWindow = null;
/** @type {string|null} cartella dati validata; il renderer non la sceglie */
let dataFolder = null;
/** @type {string|null} dove finisce la copia automatica dell'archivio */
let backupFolder = null;
/** quando e' riuscito l'ultimo backup, e quando si e' avvisato per
 *  l'ultima volta che non c'e' una cartella dove farlo */
let ultimoBackup = 0;
let ultimoAvvisoBackup = 0;
/** true quando il renderer ha scaricato i salvataggi (o l'utente ha
 *  scelto di chiudere comunque): da lì la finestra si chiude davvero. */
let chiusuraConsentita = false;
let timerChiusura = null;
/** true mentre l'utente decide in una finestra del tool se chiudere. */
let attesaUtente = false;

// ══════════════════════════════════════════════════════════════════
//  CONFIG (in AppData, non nella cartella dati)
// ══════════════════════════════════════════════════════════════════
/** In sviluppo su dev-data la configurazione vera non si tocca: un giro
 *  di prova non deve riscrivere la cartella dati della postazione ne'
 *  la data dell'ultimo backup. */
let configProva = false;

function configPath() {
  const nome = configProva ? CONFIG_FILE.replace('.json', '.dev.json') : CONFIG_FILE;
  return path.join(app.getPath('userData'), nome);
}

/** Notepad e PowerShell 5.1 scrivono UTF-8 con BOM: senza questo,
 *  un file toccato a mano diventa illeggibile per JSON.parse. */
function stripBom(text) {
  return (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF) ? text.slice(1) : text;
}

function readConfig() {
  try {
    const raw = stripBom(fs.readFileSync(configPath(), 'utf8'));
    const cfg = JSON.parse(raw);
    // Ogni campo viene validato da chi lo usa. Prima si scartava tutto
    // il file se mancava dataFolder, e chi aveva scelto la cartella del
    // backup prima di quella dati se la vedeva sparire.
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg;
  } catch (_) { /* config assente o illeggibile: si riparte da zero */ }
  return {};
}

/** Riscrive la configurazione dallo stato corrente.
 *  Si costruisce un oggetto nuovo invece di ritoccare quello letto dal
 *  file: cosi' una chiave inattesa nel JSON non torna sul disco, e
 *  nessun __proto__ arriva mai in un Object.assign. */
function salvaConfig() {
  writeConfig({
    dataFolder: dataFolder || '',
    backupFolder: backupFolder || '',
    ultimoBackup: ultimoBackup || 0,
    ultimoAvvisoBackup: ultimoAvvisoBackup || 0
  });
}

function writeConfig(cfg) {
  try {
    const target = configPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[config] scrittura fallita:', err.message);
  }
}

/** Fino alla 2.3.0 l'archivio si chiamava ps_onco_data.json. Aprendo una
 *  cartella che ha ancora il nome vecchio, il file viene rinominato: uno
 *  solo, con il nome nuovo, invece di due copie che poi divergono.
 *  Se il nome nuovo c'e' gia', non si tocca niente. */
function migraNomiFile(cartella) {
  if (!cartella) return;
  try {
    const nuovo = path.join(cartella, DATA_FILE);
    const vecchio = path.join(cartella, DATA_FILE_VECCHIO);
    if (fs.existsSync(vecchio) && !fs.existsSync(nuovo)) {
      fs.renameSync(vecchio, nuovo);
      console.log('[dati] archivio rinominato: ' + DATA_FILE_VECCHIO + ' -> ' + DATA_FILE);
    }
  } catch (err) {
    // niente di grave: si continua con il nome nuovo, il vecchio resta li'
    console.error('[dati] rinomina dell\u2019archivio non riuscita:', err.message);
  }
  try {
    // un lock con il nome vecchio, se nessuno lo aggiorna piu', e' solo
    // un residuo: lo si toglie di mezzo (due minuti sono molto piu' del
    // battito con cui le postazioni lo rinfrescano)
    const lockVecchio = path.join(cartella, LOCK_FILE_VECCHIO);
    if (Date.now() - fs.statSync(lockVecchio).mtimeMs > 120000) fs.unlinkSync(lockVecchio);
  } catch (_) { /* nessun lock vecchio */ }
}

/** La cartella deve esistere, essere una directory ed essere scrivibile. */
function validateFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return null;
  const abs = path.resolve(folder);
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
    fs.accessSync(abs, fs.constants.R_OK | fs.constants.W_OK);
    return abs;
  } catch (_) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  FILE I/O — solo nomi su allowlist, solo dentro dataFolder
// ══════════════════════════════════════════════════════════════════
function resolveTarget(name) {
  if (typeof name !== 'string' || !ALLOWED_FILES.has(name)) {
    throw new Error('Nome file non consentito.');
  }
  if (!dataFolder) throw new Error('Cartella dati non configurata.');
  return path.join(dataFolder, name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scrittura atomica: file temporaneo nella stessa cartella + rename.
 *  Su SMB il rename può fallire con EBUSY/EPERM se un altro PC sta
 *  leggendo: si riprova, poi si ricade sulla scrittura diretta. */
async function atomicWrite(target, content) {
  const tmp = target + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  await fsp.writeFile(tmp, content, 'utf8');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp.rename(tmp, target);
      return;
    } catch (err) {
      const retryable = ['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].indexOf(err.code) !== -1;
      if (!retryable) {
        // Errore non transitorio (cartella sparita, disco pieno...): la
        // scrittura diretta fallirebbe allo stesso modo, e troncherebbe
        // il file buono.
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
      if (attempt < 3) {
        await sleep(120 * (attempt + 1));
        continue;
      }
      // Ultima risorsa, per le condivisioni che negano il rename sopra un
      // file esistente. La scrittura diretta non è atomica: se si
      // interrompe a metà, il file temporaneo con la copia integra resta
      // dov'è invece di essere cancellato insieme all'unica copia buona.
      try {
        await fsp.writeFile(target, content, 'utf8');
      } catch (fallbackErr) {
        throw new Error(descrizioneErrore(fallbackErr) +
          ' La copia integra è conservata in ' + path.basename(tmp) + '.');
      }
      await fsp.unlink(tmp).catch(() => {});
      return;
    }
  }
}

/** L'archivio si scrive solo se è davvero un archivio: un contenuto vuoto
 *  o troncato, per un difetto del renderer, cancellerebbe tutti gli esami
 *  di entrambe le postazioni. */
function verificaArchivio(content) {
  let dati;
  try {
    dati = JSON.parse(stripBom(content));
  } catch (_) {
    throw new Error('Contenuto dell’archivio non valido: scrittura rifiutata.');
  }
  const ok = Array.isArray(dati) || (dati && typeof dati === 'object' && Array.isArray(dati.records));
  if (!ok) throw new Error('Struttura dell’archivio non valida: scrittura rifiutata.');
}

// ══════════════════════════════════════════════════════════════════
//  FINESTRA
// ══════════════════════════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: COLORE_FINESTRA,
    title: 'ER Oncology Archivist',
    // nel pacchetto l'icona è quella dell'eseguibile; questa vale per npm start
    icon: fs.existsSync(ICONA) ? ICONA : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: IS_DEV
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV_TOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Prima di chiudere, il renderer scarica i salvataggi in sospeso: un
  // esame salvato un istante prima della chiusura restava solo in memoria.
  mainWindow.on('close', (event) => {
    if (chiusuraConsentita) return;
    event.preventDefault();
    // Richiesta già in corso, o l'utente sta rispondendo a "Modifiche non
    // salvate": un altro clic sulla X non deve riavviare il conto alla
    // rovescia, che chiuderebbe la finestra con la domanda ancora aperta.
    if (timerChiusura || attesaUtente) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      return;
    }
    timerChiusura = setTimeout(consentiChiusura, ATTESA_CHIUSURA);
    mainWindow.webContents.send('app:richiesta-chiusura');
  });
  // Se la pagina si blocca o cade, nessuno risponderà alla richiesta: la
  // chiusura deve restare possibile.
  mainWindow.on('unresponsive', () => { attesaUtente = false; });
  mainWindow.webContents.on('render-process-gone', () => { attesaUtente = false; chiusuraConsentita = true; });

  // loadURL + url.format: loadFile non risolve correttamente nel
  // pacchetto portable distribuito (nota storica del progetto).
  mainWindow.loadURL(url.format({
    pathname: path.join(__dirname, 'src', 'index.html'),
    protocol: 'file:',
    slashes: true
  }));

  if (!IS_DEV) Menu.setApplicationMenu(null);
}

/** Chiude davvero la finestra, senza chiedere altro al renderer. */
function consentiChiusura() {
  clearTimeout(timerChiusura);
  timerChiusura = null;
  chiusuraConsentita = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
}

/** Nessuna navigazione fuori dai file locali dell'app, nessuna popup,
 *  nessun link esterno aperto dentro Electron. */
function hardenWebContents(contents) {
  // Il separatore finale conta: senza, anche una cartella "src-altro"
  // accanto a src/ passava il controllo. Su Windows i percorsi non
  // distinguono maiuscole e minuscole.
  const normalizza = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const radice = normalizza(path.resolve(__dirname, 'src') + path.sep);

  // L'app non contiene link esterni: nessuna finestra, nessun browser.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (event, target) => {
    let ok = false;
    try {
      ok = new URL(target).protocol === 'file:' &&
           normalizza(path.resolve(url.fileURLToPath(target))).indexOf(radice) === 0;
    } catch (_) { ok = false; }
    if (!ok) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

// ══════════════════════════════════════════════════════════════════
//  IPC — ogni handler verifica il mittente
// ══════════════════════════════════════════════════════════════════
/** Ogni canale dichiara chi lo può chiamare. La finestra della safety
 *  net è una finestra a parte: le si aprono solo i canali che le
 *  servono, non tutti quelli della finestra principale. */
function assertSender(event, ancheSafety) {
  const daPrincipale = mainWindow && !mainWindow.isDestroyed() &&
                       event.sender === mainWindow.webContents;
  const daSafety = ancheSafety === true && safetyWindow && !safetyWindow.isDestroyed() &&
                   event.sender === safetyWindow.webContents;
  if (!daPrincipale && !daSafety) {
    throw new Error('Mittente IPC non autorizzato.');
  }
}

function register(channel, handler, ancheSafety) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event, ancheSafety);
    return handler(...args);
  });
}

register('app:info', async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  dataFile: DATA_FILE,
  lockFile: LOCK_FILE
}));

register('fs:getDataFolder', async () => dataFolder);

register('fs:selectDataFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleziona la cartella dati condivisa',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: dataFolder || undefined
  });
  if (res.canceled || !res.filePaths.length) return null;

  const folder = validateFolder(res.filePaths[0]);
  // l'avviso lo mostra il renderer, con le finestre del tool
  if (!folder) return { stato: 'non-valida' };
  migraNomiFile(folder);
  dataFolder = folder;
  salvaConfig();
  return folder;
});

register('fs:readText', async (name) => {
  const target = resolveTarget(name);
  try {
    return await fsp.readFile(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(descrizioneErrore(err));
  }
});

register('fs:writeText', async (name, content) => {
  const target = resolveTarget(name);
  if (typeof content !== 'string') throw new Error('Contenuto non valido.');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Contenuto troppo grande.');
  }
  if (name === LOCK_FILE && Buffer.byteLength(content, 'utf8') > LOCK_MAX_BYTES) {
    throw new Error('Lock non valido.');
  }
  if (name === DATA_FILE) verificaArchivio(content);
  try {
    await atomicWrite(target, content);
    return true;
  } catch (err) {
    throw new Error(descrizioneErrore(err));
  }
});

register('fs:deleteFile', async (name) => {
  // Dal renderer si cancella solo il lock: l'archivio non si elimina mai.
  if (name !== LOCK_FILE) throw new Error('Cancellazione non consentita.');
  const target = resolveTarget(name);
  try {
    await fsp.unlink(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw new Error(descrizioneErrore(err));
  }
});

register('fs:exists', async (name) => {
  const target = resolveTarget(name);
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
});

register('app:saveExport', async (defaultName, base64) => {
  const safeName = sanitizeFileName(defaultName);
  if (typeof base64 !== 'string' || base64.length > MAX_EXPORT_CHARS) {
    throw new Error('Dati di export non validi.');
  }
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Salva export',
    defaultPath: safeName
  });
  if (res.canceled || !res.filePath) return null;
  await fsp.writeFile(res.filePath, Buffer.from(base64, 'base64'));
  return res.filePath;
});

register('app:savePdf', async (defaultName) => {
  const safeName = sanitizeFileName(defaultName, '.pdf');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Salva report PDF',
    defaultPath: safeName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return null;
  // Formato e margini li decide il CSS (@page: A4 orizzontale): senza
  // preferCSSPageSize una regola @page con size vince comunque su
  // landscape e il report usciva in verticale.
  // Electron dipinge i margini di stampa con il backgroundColor della
  // finestra, che è scuro: per la durata della stampa diventa bianco.
  mainWindow.setBackgroundColor('#FFFFFF');
  let pdf;
  try {
    pdf = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: 'A4',
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: PIEDE_PDF
    });
  } finally {
    mainWindow.setBackgroundColor(COLORE_FINESTRA);
  }
  await fsp.writeFile(res.filePath, pdf);
  return res.filePath;
});

// ══════════════════════════════════════════════════════════════════
//  SAFETY NET — copia di sicurezza dell'archivio
//
//  Due strade, lo stesso file:
//  · ogni quindici giorni una copia automatica nella cartella scelta
//    dalla postazione, con un avviso di sistema;
//  · su richiesta, la stessa copia su una chiavetta USB.
//  Il nome è sempre backup_ER_OA.json e viene sempre sovrascritto.
//
//  Il comando che elenca le unità è fisso e senza interpolazione: nessun
//  input del renderer entra nella riga di comando. Le lettere di unità
//  sono validate con una regex prima di diventare un percorso.
// ══════════════════════════════════════════════════════════════════

/** Lettere di unita' presenti adesso. Costa pochi microsecondi, a
 *  differenza di PowerShell: serve a capire se c'e' qualcosa di nuovo. */
function lettereMontate() {
  let firma = '';
  for (let c = 67; c <= 90; c++) {           // da C: a Z:
    const lettera = String.fromCharCode(c) + ':';
    try { fs.accessSync(lettera + path.sep); firma += lettera; } catch (_) { /* assente */ }
  }
  return firma;
}

let cacheUnita = { firma: null, unita: [], quando: 0 };
let unitaInCorso = null;

/** Unita' rimovibili scrivibili. La finestra della safety net chiede
 *  ogni due secondi e mezzo: avviare PowerShell ogni volta costava
 *  mezzo secondo di CPU per giro, e su un PC lento le chiamate si
 *  sarebbero accavallate. Ora si interroga PowerShell solo quando le
 *  lettere presenti cambiano (una chiavetta inserita o tolta), o dopo
 *  un minuto; e mai due volte insieme. */
function trovaUnitaRimovibili(fresca) {
  const firma = lettereMontate();
  // prima di scrivere si guarda sempre com'e' adesso, non com'era
  if (!fresca && firma === cacheUnita.firma && Date.now() - cacheUnita.quando < 60000) {
    return Promise.resolve(cacheUnita.unita);
  }
  if (!unitaInCorso) {
    unitaInCorso = enumeraUnitaRimovibili()
      .then((unita) => { cacheUnita = { firma: firma, unita: unita, quando: Date.now() }; return unita; })
      .finally(() => { unitaInCorso = null; });
  }
  return unitaInCorso;
}

function enumeraUnitaRimovibili() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | ' +
      'ForEach-Object { $_.DeviceID + "|" + $_.VolumeName + "|" + $_.FreeSpace }'
    ], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const unita = [];
      String(stdout).split(/\r?\n/).forEach((riga) => {
        const m = riga.trim().match(/^([A-Z]:)\|([^|]*)\|(\d*)$/);
        if (!m) return;
        const radice = m[1] + path.sep;
        try {
          fs.accessSync(radice, fs.constants.W_OK);
        } catch (_) { return; }   // inserita ma protetta in scrittura
        unita.push({
          lettera: m[1],
          etichetta: (m[2] || '').trim() || 'Unità rimovibile',
          spazioLibero: Number(m[3]) || 0
        });
      });
      resolve(unita);
    });
  });
}

/** Quanti esami contiene una copia dell'archivio: serve solo per dirlo
 *  all'utente. */
function contaEsami(contenuto) {
  try {
    const store = JSON.parse(stripBom(contenuto));
    return Array.isArray(store) ? store.length
         : (store && Array.isArray(store.records) ? store.records.length : 0);
  } catch (_) { return 0; }
}

/** Legge l'archivio corrente e ne verifica la struttura: quel che non è
 *  un archivio non diventa un backup. La copia di sicurezza sarebbe la
 *  prima cosa a tradire, se contenesse spazzatura. */
async function leggiArchivio() {
  if (!dataFolder) return { stato: 'senza-cartella' };
  let contenuto;
  try {
    contenuto = await fsp.readFile(path.join(dataFolder, DATA_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { stato: 'senza-archivio' };
    return { stato: 'errore', messaggio: descrizioneErrore(err) };
  }
  try {
    verificaArchivio(contenuto);
  } catch (err) {
    return { stato: 'errore', messaggio: err.message };
  }
  return { stato: 'ok', contenuto: contenuto };
}

/** Copia dell'archivio nella cartella indicata, sempre con lo stesso
 *  nome. La scrittura è atomica: se si interrompe, la copia buona di
 *  quindici giorni fa resta dov'è. */
async function eseguiBackup(cartella) {
  const destinazioneCartella = validateFolder(cartella);
  if (!destinazioneCartella) return { stato: 'cartella-non-valida' };

  const letto = await leggiArchivio();
  if (letto.stato !== 'ok') return letto;

  const destinazione = path.join(destinazioneCartella, BACKUP_FILE);
  try {
    await atomicWrite(destinazione, letto.contenuto);
  } catch (err) {
    return { stato: 'errore', messaggio: descrizioneErrore(err) };
  }
  return { stato: 'ok', percorso: destinazione,
           esami: contaEsami(letto.contenuto), quando: Date.now() };
}

/** Avviso di sistema: l'utente può non avere il programma davanti.
 *  Un clic sull'avviso apre la finestra della safety net. */
function notificaSistema(titolo, corpo) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: titolo,
      body: corpo,
      icon: fs.existsSync(ICONA) ? ICONA : undefined
    });
    n.on('click', () => apriFinestraSafety());
    n.show();
  } catch (err) {
    console.error('[backup] avviso non mostrato:', err.message);
  }
}

/** Lo stesso avviso dentro al programma: le finestre aperte lo mostrano
 *  con la grafica del tool. */
function avvisaFinestre(messaggio) {
  [mainWindow, safetyWindow].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('app:backup', messaggio);
  });
}

/** Il giro dei quindici giorni. */
async function controllaBackup() {
  if (!dataFolder) return;
  const adesso = Date.now();
  if (ultimoBackup && adesso - ultimoBackup < INTERVALLO_BACKUP) return;

  if (!backupFolder) {
    // Senza una cartella non c'è backup da fare: si ricorda, ma non più
    // di una volta ogni quindici giorni. Un avviso che torna ogni ora
    // diventa un avviso che non si legge più.
    if (ultimoAvvisoBackup && adesso - ultimoAvvisoBackup < INTERVALLO_BACKUP) return;
    const primaVolta = !ultimoAvvisoBackup;
    ultimoAvvisoBackup = adesso;
    salvaConfig();
    // Al primo avvio basta il messaggio dentro al programma: chi ha appena
    // installato il tool sta configurando la cartella dati, e un avviso di
    // Windows che gli passa davanti non aiuta. Da qui parte il conto dei
    // quindici giorni: il richiamo successivo è quello vero.
    if (!primaVolta) {
      notificaSistema('Backup dell’archivio non configurato',
        'Scegli dove salvare la copia di sicurezza: si apre da Safety net.');
    }
    avvisaFinestre({ tipo: 'da-configurare', primaVolta: primaVolta });
    return;
  }

  const esito = await eseguiBackup(backupFolder);
  if (esito.stato === 'ok') {
    ultimoBackup = esito.quando;
    salvaConfig();
    notificaSistema('Copia di sicurezza eseguita',
      esito.esami + ' esami copiati in ' + backupFolder + '.');
    avvisaFinestre({ tipo: 'fatto', esami: esito.esami,
                     percorso: esito.percorso, quando: esito.quando });
  } else {
    // La data non si aggiorna: al prossimo giro ci riprova.
    notificaSistema('Copia di sicurezza non riuscita',
      esito.messaggio || 'La cartella del backup non \u00e8 raggiungibile.');
    avvisaFinestre({ tipo: 'fallito', messaggio: esito.messaggio || '' });
  }
}

function programmaBackup() {
  // Un errore imprevisto non deve diventare un rifiuto senza gestione nel
  // processo principale: si registra, e al giro dopo si riprova.
  const giro = () => controllaBackup().catch((err) => console.error('[backup] giro non riuscito:', err.message));
  setTimeout(() => {
    giro();
    setInterval(giro, CONTROLLO_BACKUP);
  }, PRIMO_CONTROLLO);
}

/** Stato completo per la finestra della safety net. */
function statoSafety() {
  return {
    cartellaDati: dataFolder,
    cartellaBackup: backupFolder,
    ultimoBackup: ultimoBackup || 0,
    prossimoBackup: ultimoBackup ? ultimoBackup + INTERVALLO_BACKUP : 0,
    giorni: GIORNI_BACKUP,
    nomeFile: BACKUP_FILE
  };
}

/** Copia sull'unità scelta dall'utente. La lettera arriva dal renderer:
 *  vale solo se è fra le unità rimovibili rilevate adesso, quindi non si
 *  può usare per scrivere altrove. Il file sta nella radice della
 *  chiavetta e si chiama sempre backup_ER_OA.json: si ritrova subito, e
 *  la copia nuova prende il posto della vecchia invece di lasciare in
 *  giro archivi dimenticati. Scelta e avvertenza le mostra il renderer,
 *  con le finestre del tool. */
async function copiaSuUsb(lettera) {
  if (typeof lettera !== 'string' || !/^[A-Z]:$/.test(lettera)) {
    return { stato: 'errore', messaggio: 'Unità non valida.' };
  }
  const unita = await trovaUnitaRimovibili(true);
  const scelta = unita.find((u) => u.lettera === lettera);
  if (!scelta) return { stato: 'nessuna-unita' };

  const letto = await leggiArchivio();
  if (letto.stato !== 'ok') return letto;

  const destinazione = path.join(scelta.lettera + path.sep, BACKUP_FILE);
  try {
    await atomicWrite(destinazione, letto.contenuto);
  } catch (err) {
    return { stato: 'errore', messaggio: descrizioneErrore(err) };
  } finally {
    cacheUnita.firma = null;       // spazio libero cambiato: si rilegge
  }
  return { stato: 'ok', percorso: destinazione, unita: scelta.lettera,
           etichetta: scelta.etichetta, esami: contaEsami(letto.contenuto),
           quando: Date.now() };
}

// ── Finestra separata ───────────────────────────────────────

/** La safety net vive in una finestra sua: la si tiene aperta accanto al
 *  programma mentre si sceglie la cartella o si aspetta la chiavetta. */
function apriFinestraSafety() {
  if (safetyWindow && !safetyWindow.isDestroyed()) {
    if (safetyWindow.isMinimized()) safetyWindow.restore();
    safetyWindow.focus();
    return true;
  }
  safetyWindow = new BrowserWindow({
    width: 780,
    height: 760,
    minWidth: 620,
    minHeight: 540,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    show: false,
    backgroundColor: COLORE_FINESTRA,
    title: 'Safety net — ER Oncology Archivist',
    icon: fs.existsSync(ICONA) ? ICONA : undefined,
    autoHideMenuBar: true,
    // Stesse difese della finestra principale: nessuna eccezione perché
    // è una finestra di servizio.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: IS_DEV
    }
  });
  safetyWindow.setMenu(null);
  safetyWindow.once('ready-to-show', () => {
    if (safetyWindow && !safetyWindow.isDestroyed()) safetyWindow.show();
  });
  safetyWindow.on('closed', () => { safetyWindow = null; });
  safetyWindow.loadURL(url.format({
    pathname: path.join(__dirname, 'src', 'safety.html'),
    protocol: 'file:',
    slashes: true
  }));
  return true;
}

// ── Canali ─────────────────────────────────────────────────
// Quelli aperti anche alla safety net sono i soli che la finestra di
// servizio può chiamare: legge lo stato, sceglie la sua cartella, copia.
// Dell'archivio non tocca niente.
register('app:unitaRimovibili', async () => trovaUnitaRimovibili(false), true);
register('app:safetyNet', async (lettera) => copiaSuUsb(lettera), true);
register('app:apriSafety', async () => apriFinestraSafety());

register('safety:stato', async () => statoSafety(), true);

register('safety:scegliCartella', async () => {
  const finestra = safetyWindow && !safetyWindow.isDestroyed() ? safetyWindow : mainWindow;
  const res = await dialog.showOpenDialog(finestra, {
    title: 'Dove salvare la copia di sicurezza',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: backupFolder || undefined
  });
  if (res.canceled || !res.filePaths.length) return { stato: 'annullato' };
  const cartella = validateFolder(res.filePaths[0]);
  if (!cartella) return { stato: 'non-valida' };
  // Il backup non sta nella cartella che copia: se la share sparisce,
  // sparirebbero insieme originale e copia.
  if (dataFolder && path.resolve(cartella) === path.resolve(dataFolder)) {
    return { stato: 'stessa-cartella' };
  }
  backupFolder = cartella;
  salvaConfig();
  return { stato: 'ok', safety: statoSafety() };
}, true);

register('safety:dimenticaCartella', async () => {
  backupFolder = null;
  salvaConfig();
  return statoSafety();
}, true);

register('safety:backupOra', async () => {
  if (!backupFolder) return { stato: 'senza-cartella-backup' };
  const esito = await eseguiBackup(backupFolder);
  if (esito.stato === 'ok') {
    ultimoBackup = esito.quando;
    salvaConfig();
  }
  return esito;
}, true);

register('safety:chiudi', async () => {
  if (safetyWindow && !safetyWindow.isDestroyed()) safetyWindow.close();
  return true;
}, true);

/** Risposta del renderer alla richiesta di chiusura:
 *  'chiudi'  → la finestra si chiude;
 *  'attendi' → l'utente sta decidendo in una finestra del tool, niente
 *              chiusura forzata allo scadere dell'attesa;
 *  'resta'   → la finestra resta aperta. */
register('app:conferma-chiusura', async (esito) => {
  clearTimeout(timerChiusura);
  timerChiusura = null;
  attesaUtente = esito === 'attendi';
  if (esito === 'chiudi') {
    setImmediate(consentiChiusura);
    return true;
  }
  return false;
});

/** Nome file proposto nella finestra di salvataggio: mai un percorso. */
function sanitizeFileName(name, forcedExt) {
  let base = typeof name === 'string' ? name : 'export';
  base = path.basename(base)
    .split('').filter(function (ch) { var c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('')
    // La classe deve contenere anche la barra rovesciata: scritta \| il
    // backslash sfuggiva la barra verticale invece di entrare nell'insieme,
    // e su una piattaforma non Windows path.basename non la toglie.
    .replace(/[<>:"/\\|?*]/g, '_')
    .slice(0, 120)
    .trim();
  if (!base || base === '.' || base === '..') base = 'export';
  if (forcedExt && base.toLowerCase().slice(-forcedExt.length) !== forcedExt) base += forcedExt;
  return base;
}

function descrizioneErrore(err) {
  switch (err.code) {
    case 'EACCES':
    case 'EPERM':  return 'Permessi insufficienti sulla cartella dati.';
    case 'ENOENT': return 'Cartella dati non raggiungibile (rete non disponibile?).';
    case 'EBUSY':  return 'File occupato da un altro PC. Riprovare tra qualche secondo.';
    case 'ENOSPC': return 'Spazio esaurito sul server.';
    default:       return err.message || 'Errore di accesso al file.';
  }
}

// ══════════════════════════════════════════════════════════════════
//  SVILUPPO — ricarica automatica e cartella dati dedicata
//  Tutto quanto segue gira solo con `npm run dev`.
// ══════════════════════════════════════════════════════════════════

/** Ricarica la finestra a ogni salvataggio dentro src/. */
function watchSources() {
  const dir = path.join(__dirname, 'src');
  let timer = null;
  try {
    fs.watch(dir, { recursive: true }, (_evt, file) => {
      if (!file || !/\.(html|css|js)$/i.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[dev] ' + file + ' → ricarico la finestra');
          mainWindow.webContents.reloadIgnoringCache();
        }
      }, 160);
    });
    console.log('[dev] in ascolto su src/');
  } catch (err) {
    console.error('[dev] watcher non attivo:', err.message);
  }

  // main.js e preload.js girano nel processo principale: per quelli
  // serve riavviare, la ricarica della finestra non basta.
  try {
    fs.watch(__dirname, (_evt, file) => {
      if (file === 'main.js' || file === 'preload.js') {
        console.log('[dev] ' + file + ' modificato → riavvia: Ctrl+C, poi npm run dev');
      }
    });
  } catch (_) {}
}

/** In sviluppo si usa dev-data/ senza chiedere nulla, e senza scriverlo
 *  in configurazione: un normale avvio continua a chiedere la cartella. */
function useDevDataFolder() {
  const dir = path.join(__dirname, 'dev-data');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[dev] non riesco a creare dev-data:', err.message);
    return;
  }
  const ok = validateFolder(dir);
  if (ok) {
    migraNomiFile(ok);
    dataFolder = ok;
    configProva = true;
    // da qui in poi si legge e si scrive la configurazione di prova
    const cfg = readConfig();
    backupFolder = validateFolder(cfg.backupFolder);
    ultimoBackup = Number(cfg.ultimoBackup) || 0;
    ultimoAvvisoBackup = Number(cfg.ultimoAvvisoBackup) || 0;
    console.log('[dev] cartella dati:', ok);
  }
}

// ══════════════════════════════════════════════════════════════════
//  AVVIO
// ══════════════════════════════════════════════════════════════════
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));

  app.whenReady().then(() => {
    // Content-Security-Policy anche a livello di sessione, in aggiunta
    // al <meta> della pagina.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: Object.assign({}, details.responseHeaders, {
          'Content-Security-Policy': [
            // style-src consente gli stili inline (l'SVG dello splash ne usa
            // uno per glifo). script-src resta rigido: è quello che chiude
            // la classe XSS.
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self'; connect-src 'none'; " +
            "form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
          ]
        })
      });
    });

    const cfg = readConfig();
    dataFolder = validateFolder(cfg.dataFolder);
    migraNomiFile(dataFolder);
    backupFolder = validateFolder(cfg.backupFolder);
    ultimoBackup = Number(cfg.ultimoBackup) || 0;
    ultimoAvvisoBackup = Number(cfg.ultimoAvvisoBackup) || 0;
    // --demo (npm run demo) usa sempre dev-data, anche se una cartella è
    // già configurata: la demo non deve mai aprire l'archivio vero
    if (DEV_MODE && (!dataFolder || process.argv.indexOf('--demo') !== -1)) useDevDataFolder();
    createWindow();
    // Senza un identificativo esplicito Windows non mostra gli avvisi di
    // un'applicazione Electron non installata.
    if (process.platform === 'win32') app.setAppUserModelId('it.eroncologyarchivist.app');
    programmaBackup();
    if (DEV_MODE) watchSources();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
