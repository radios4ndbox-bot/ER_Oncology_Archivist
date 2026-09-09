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

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const url = require('url');

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

// ── Stato del solo processo principale ────────────────────────────
let mainWindow = null;
/** @type {string|null} cartella dati validata; il renderer non la sceglie */
let dataFolder = null;

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
      if (!retryable || attempt === 3) {
        try {
          await fsp.writeFile(target, content, 'utf8');
          await fsp.unlink(tmp).catch(() => {});
          return;
        } catch (fallbackErr) {
          await fsp.unlink(tmp).catch(() => {});
          throw fallbackErr;
        }
      }
      await sleep(120 * (attempt + 1));
    }
  }
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
    backgroundColor: '#0e1017',
    title: 'ER Oncology Archivist',
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

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // loadURL + url.format: loadFile non risolve correttamente nel
  // pacchetto portable distribuito (nota storica del progetto).
  mainWindow.loadURL(url.format({
    pathname: path.join(__dirname, 'src', 'index.html'),
    protocol: 'file:',
    slashes: true
  }));

  if (!IS_DEV) Menu.setApplicationMenu(null);
}

function safeProtocol(target) {
  try { return new URL(target).protocol; } catch (_) { return ''; }
}

/** Nessuna navigazione fuori dai file locali dell'app, nessuna popup,
 *  nessun link esterno aperto dentro Electron. */
function hardenWebContents(contents) {
  const appRoot = path.join(__dirname, 'src');

  contents.setWindowOpenHandler((details) => {
    if (/^https?:$/.test(safeProtocol(details.url))) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, target) => {
    let ok = false;
    try {
      const parsed = new URL(target);
      const filePath = path.resolve(decodeURIComponent(parsed.pathname.replace(/^\//, '')));
      ok = parsed.protocol === 'file:' && filePath.indexOf(appRoot) === 0;
    } catch (_) { ok = false; }
    if (!ok) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
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
  try {
    await atomicWrite(target, content);
    return true;
  } catch (err) {
    throw new Error(descrizioneErrore(err));
  }
});

register('fs:deleteFile', async (name) => {
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
  const pdf = await mainWindow.webContents.printToPDF({
    printBackground: true,
    landscape: false,
    pageSize: 'A4',
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
  });
  await fsp.writeFile(res.filePath, pdf);
  return res.filePath;
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
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
