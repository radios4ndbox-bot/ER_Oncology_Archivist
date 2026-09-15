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

const { app, BrowserWindow, ipcMain, dialog, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const url = require('url');
const { execFile } = require('child_process');

// ── Costanti ──────────────────────────────────────────────────────
const DATA_FILE = 'ps_onco_data.json';
const LOCK_FILE = 'ps_onco.lock';
/** Unici nomi file che il renderer può nominare. Nessun path, nessun
 *  separatore: il path traversal è strutturalmente impossibile. */
const ALLOWED_FILES = new Set([DATA_FILE, LOCK_FILE]);
const CONFIG_FILE = 'psonco-config.json';
const MAX_TEXT_BYTES = 64 * 1024 * 1024;   // 64 MB
const MAX_EXPORT_CHARS = 96 * 1024 * 1024; // 96 MB di base64
const IS_DEV = !app.isPackaged;
/** Modalità sviluppo: si attiva SOLO con `npm run dev` su un'app non
 *  impacchettata. Nel .exe distribuito app.isPackaged è true, quindi
 *  niente di quanto segue può attivarsi. */
const DEV_MODE = IS_DEV && process.argv.indexOf('--dev') !== -1;
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
/** @type {string|null} cartella dati validata; il renderer non la sceglie */
let dataFolder = null;
/** true quando il renderer ha scaricato i salvataggi (o l'utente ha
 *  scelto di chiudere comunque): da lì la finestra si chiude davvero. */
let chiusuraConsentita = false;
let timerChiusura = null;

// ══════════════════════════════════════════════════════════════════
//  CONFIG (in AppData, non nella cartella dati)
// ══════════════════════════════════════════════════════════════════
function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
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
    if (cfg && typeof cfg === 'object' && typeof cfg.dataFolder === 'string') return cfg;
  } catch (_) { /* config assente o illeggibile: si riparte da zero */ }
  return {};
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
    if (DEV_MODE) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Prima di chiudere, il renderer scarica i salvataggi in sospeso: un
  // esame salvato un istante prima della chiusura restava solo in memoria.
  mainWindow.on('close', (event) => {
    if (chiusuraConsentita) return;
    event.preventDefault();
    if (timerChiusura) return;          // richiesta già in corso
    timerChiusura = setTimeout(consentiChiusura, ATTESA_CHIUSURA);
    mainWindow.webContents.send('app:richiesta-chiusura');
  });

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
function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Mittente IPC non autorizzato.');
  }
}

function register(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
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
  if (!folder) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Cartella non utilizzabile',
      message: 'La cartella selezionata non esiste o non è scrivibile.',
      detail: 'Verificare i permessi sulla condivisione di rete e riprovare.'
    });
    return null;
  }
  dataFolder = folder;
  const cfg = readConfig();
  cfg.dataFolder = folder;
  writeConfig(cfg);
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
//  SAFETY NET — copia di sicurezza su chiavetta USB
//  Il comando è fisso e senza interpolazione: nessun input del renderer
//  entra nella riga di comando. Le lettere di unità sono validate con
//  una regex prima di essere usate come percorso.
// ══════════════════════════════════════════════════════════════════
const CARTELLA_BACKUP = 'PSOnco-Backup';

function trovaUnitaRimovibili() {
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

function marcaTemporale() {
  const d = new Date();
  const due = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + due(d.getMonth() + 1) + due(d.getDate()) +
         '-' + due(d.getHours()) + due(d.getMinutes());
}

async function copiaSuUsb() {
  if (!dataFolder) return { stato: 'senza-cartella' };

  const sorgente = path.join(dataFolder, DATA_FILE);
  let contenuto;
  try {
    contenuto = await fsp.readFile(sorgente, 'utf8');
  } catch (err) {
    return { stato: 'errore', messaggio: descrizioneErrore(err) };
  }

  const unita = await trovaUnitaRimovibili();
  if (!unita.length) return { stato: 'nessuna-unita' };

  let scelta = unita[0];
  if (unita.length > 1) {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Safety net',
      message: 'Su quale unità rimovibile salvare la copia?',
      buttons: unita.map((u) => u.lettera + '  ' + u.etichetta).concat(['Annulla']),
      cancelId: unita.length,
      defaultId: 0
    });
    if (res.response >= unita.length) return { stato: 'annullato' };
    scelta = unita[res.response];
  }

  // Sono dati sanitari: la conferma dev'essere esplicita e informata.
  const conferma = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Copia di sicurezza su unità rimovibile',
    message: 'Copiare l’archivio su ' + scelta.lettera + ' (' + scelta.etichetta + ')?',
    detail: 'Il file contiene dati sanitari in chiaro: nomi, date di nascita e ' +
            'diagnosi.\n\nConservare la chiavetta come si conserva una cartella ' +
            'clinica, e cancellarla quando non serve più.',
    buttons: ['Copia', 'Annulla'],
    cancelId: 1,
    defaultId: 1,
    noLink: true
  });
  if (conferma.response !== 0) return { stato: 'annullato' };

  const cartella = path.join(scelta.lettera + path.sep, CARTELLA_BACKUP);
  const destinazione = path.join(cartella, 'ps_onco_data_' + marcaTemporale() + '.json');
  try {
    await fsp.mkdir(cartella, { recursive: true });
    await atomicWrite(destinazione, contenuto);
  } catch (err) {
    return { stato: 'errore', messaggio: descrizioneErrore(err) };
  }

  let esami = 0;
  try {
    const store = JSON.parse(stripBom(contenuto));
    esami = Array.isArray(store) ? store.length
          : (store && Array.isArray(store.records) ? store.records.length : 0);
  } catch (_) {}

  return { stato: 'ok', percorso: destinazione, unita: scelta.lettera, esami: esami };
}

register('app:safetyNet', async () => copiaSuUsb());

/** Risposta del renderer alla richiesta di chiusura. Se qualcosa non è
 *  stato salvato si chiede all'utente, invece di perderlo in silenzio. */
register('app:conferma-chiusura', async (ok, motivo) => {
  clearTimeout(timerChiusura);
  timerChiusura = null;
  if (!ok) {
    const scelta = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Modifiche non salvate',
      message: 'Alcune modifiche non risultano salvate sul file condiviso.',
      detail: String(motivo || '').slice(0, 400) + '\n\nChiudendo ora andranno perse.',
      buttons: ['Resta aperto', 'Chiudi comunque'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (scelta.response !== 1) return false;
  }
  setImmediate(consentiChiusura);
  return true;
});

/** Nome file proposto nella finestra di salvataggio: mai un percorso. */
function sanitizeFileName(name, forcedExt) {
  let base = typeof name === 'string' ? name : 'export';
  base = path.basename(base)
    .split('').filter(function (ch) { var c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('')
    .replace(/[<>:"/\|?*]/g, '_')
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
    dataFolder = ok;
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

    dataFolder = validateFolder(readConfig().dataFolder);
    if (DEV_MODE && !dataFolder) useDevDataFolder();
    createWindow();
    if (DEV_MODE) watchSources();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
