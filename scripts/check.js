'use strict';

/* Gli stessi controlli che gira GitHub Actions, ma in locale e in un
   secondo: così si scopre subito se una modifica romperebbe la build,
   invece di aspettare la pipeline.

   Uso:  npm run check */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const leggi = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let errori = 0;
function esito(ok, titolo, dettaglio) {
  console.log((ok ? '  OK   ' : '  FALLITO ') + titolo + (dettaglio ? ' — ' + dettaglio : ''));
  if (!ok) errori++;
}

console.log('\nControlli locali\n');

// 1. sintassi JavaScript
['main.js', 'preload.js', 'src/app.js', 'src/zip.js', 'src/xlsx.js', 'src/pptx.js', 'src/names.js',
 'src/safety.js', 'src/interpreta.js', 'scripts/test-interpreta.js'].forEach((f) => {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    esito(true, 'sintassi ' + f);
  } catch (err) {
    esito(false, 'sintassi ' + f, String(err.stderr || err.message).split('\n')[1] || '');
  }
});

const html = leggi('src/index.html');
const app = leggi('src/app.js');
const css = leggi('src/styles.css');
const main = leggi('main.js');
// finestra separata della safety net
const shtml = leggi('src/safety.html');
const sjs = leggi('src/safety.js');
const scss = leggi('src/safety.css');

// 2. nessun gestore di evento inline (la CSP vieta 'unsafe-inline')
const reInline = /on(click|change|input|load|error|submit|focus|blur)=/g;
const inline = (html.match(reInline) || []).concat(shtml.match(reInline) || []);
esito(inline.length === 0, 'nessun gestore inline nell\'HTML', inline.length || '');

// 3. nessuna risorsa remota (l'app deve funzionare offline)
const reRemota = /(src|href)="https?:\/\//g;
const remote = (html.match(reRemota) || []).concat(shtml.match(reRemota) || []);
esito(remote.length === 0, 'nessuna risorsa remota', remote.join(' '));

// 4. impostazioni di sicurezza di Electron
['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true'].forEach((k) => {
  esito(main.indexOf(k) !== -1, 'main.js ha ' + k);
});

// 4b. la modalità sviluppo non può attivarsi nel pacchetto distribuito
esito(/const DEV_MODE = IS_DEV && /.test(main),
  'DEV_MODE subordinata a IS_DEV (mai nel .exe)');

// 5. tag bilanciati nell'HTML
[['<button', '</button>'], ['<div', '</div>'], ['<svg', '</svg>']].forEach(([a, b]) => {
  const na = (html.match(new RegExp(a, 'g')) || []).length;
  const nb = (html.match(new RegExp(b, 'g')) || []).length;
  esito(na === nb, 'tag bilanciati ' + a + '>', na + '/' + nb);
});

// 6. ogni data-act ha un gestore, anche quelli scritti dal JavaScript.
//    Con il solo HTML statico sfuggivano i pulsanti generati a runtime
//    (i tipi di esame usavano "tipo-su" contro il gestore "tipi-su").
const bloccoAzioni = app.slice(app.indexOf('const CLICK_ACTIONS = {'), app.indexOf('function wireEvents()'));
const azioniJs = new Set([...bloccoAzioni.matchAll(/^\s*'([a-z-]+)':/gm)].map((m) => m[1]));
const reAzione = /data-act="([a-z-]+)"|setAttribute\('data-act', '([a-z-]+)'\)/g;
const usate = new Set([...html.matchAll(reAzione), ...app.matchAll(reAzione)].map((m) => m[1] || m[2]));
const orfane = [...usate].filter((a) => !azioniJs.has(a));
esito(orfane.length === 0, 'ogni data-act ha un gestore', orfane.join(', '));
const inutili = [...azioniJs].filter((a) => !usate.has(a));
esito(inutili.length === 0, 'nessun gestore senza pulsanti', inutili.join(', '));

// 7. ogni id usato dal JS esiste nell'HTML
const idsHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsJs = new Set([
  ...[...app.matchAll(/\bel\('([A-Za-z_]\w*)'\)/g)].map((m) => m[1]),
  ...[...app.matchAll(/\b(?:val|rawVal|setHtml)\('([A-Za-z_]\w*)'/g)].map((m) => m[1])
]);
// id creati dal JavaScript stesso, non presenti nel markup statico
const idsDinamici = new Set(['notaEdit', 'cronoCorpo', 'smartApprendi', 'smartSignificato', 'smartEspressione',
  'suggPannello']);
const mancanti = [...idsJs].filter((id) => !idsHtml.has(id) && !idsDinamici.has(id));
esito(mancanti.length === 0, 'ogni id usato dal JS esiste', mancanti.join(', '));

// 8. nessun carattere di controllo nei sorgenti
[['src/app.js', app], ['src/styles.css', css], ['main.js', main]].forEach(([nome, testo]) => {
  // I fine riga alla Windows non sono un difetto: git li mette da solo
  // a ogni checkout con core.autocrlf, e senza questa normalizzazione il
  // controllo falliva su un clone appena fatto segnalando una riga storta
  // per ogni riga del file.
  const brutti = [...testo.replace(/\r\n/g, '\n')]
    .filter((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t');
  esito(brutti.length === 0, 'nessun carattere di controllo in ' + nome, brutti.length || '');
});

// 8b. il renderer non può cancellare l'archivio
esito(/if \(name !== LOCK_FILE\) throw/.test(main), 'fs:deleteFile limitato al lock');

// 8c. nessuna finestra di sistema per conferme e avvisi: sono tutte del tool
esito(!/\b(confirm|alert|prompt)\(/.test(app), 'nessun confirm/alert/prompt nel renderer');
esito(main.indexOf('showMessageBox') === -1, 'nessun showMessageBox nel processo principale');

// 8d. l'archivio demo è leggibile e contiene solo pazienti inventati
try {
  const demo = JSON.parse(leggi('demo/ER OA Archive.json'));
  const solo = Array.isArray(demo.records) && demo.records.length > 0 &&
    demo.records.every((r) => /^seed-\d+$/.test(r.id));
  esito(solo, 'archivio demo valido e solo generato', (demo.records || []).length + ' esami');
} catch (err) {
  esito(false, 'archivio demo valido e solo generato', err.message);
}

// 8e. finestra separata della safety net: stesse regole della principale
const azioniSafety = new Set([...sjs.matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1]));
const usateSafety = new Set([...shtml.matchAll(/data-act="([a-z-]+)"/g),
                             ...sjs.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]));
const orfaneSafety = [...usateSafety].filter((a) => !azioniSafety.has(a));
esito(orfaneSafety.length === 0, 'ogni data-act della safety net ha un gestore', orfaneSafety.join(', '));

const idsSafetyHtml = new Set([...shtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const idsSafetyJs = new Set([...sjs.matchAll(/\bel\('([A-Za-z_]\w*)'\)/g)].map((m) => m[1]));
const mancantiSafety = [...idsSafetyJs].filter((id) => !idsSafetyHtml.has(id));
esito(mancantiSafety.length === 0, 'ogni id usato dalla safety net esiste', mancantiSafety.join(', '));

esito(!/\b(confirm|alert|prompt)\(/.test(sjs), 'nessun confirm/alert/prompt nella safety net');

// La finestra di servizio non deve poter toccare l'archivio: i canali
// che scrivono restano fuori dalla sua portata.
const vietati = ['writeText(', 'deleteFile(', 'saveExport(', 'selectDataFolder('];
const abusi = vietati.filter((c) => sjs.indexOf('API.' + c) !== -1);
esito(abusi.length === 0, 'la safety net non tocca l\'archivio', abusi.join(', '));

[['src/safety.js', sjs], ['src/safety.css', scss]].forEach(([nome, testo]) => {
  const brutti = [...testo.replace(/\r\n/g, '\n')]
    .filter((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t');
  esito(brutti.length === 0, 'nessun carattere di controllo in ' + nome, brutti.length || '');
});

// 8f. Interpreta legge i referti come ci si aspetta
try {
  const e = require('./test-interpreta.js')(true);
  esito(e.falliti === 0 && e.demoOk === e.demoTot, 'interpretazione dei referti',
    (e.casi - e.falliti) + '/' + e.casi + ' casi, archivio demo ' + e.demoOk + '/' + e.demoTot);
} catch (err) {
  esito(false, 'interpretazione dei referti', err.message);
}

// 9. versione allineata fra package.json e lockfile
const pkg = JSON.parse(leggi('package.json'));
const lock = JSON.parse(leggi('package-lock.json'));
esito(pkg.version === lock.version, 'versione allineata col lockfile',
  pkg.version + ' / ' + lock.version);

console.log('\n' + (errori ? errori + ' controlli falliti\n' : 'Tutto a posto\n'));
process.exit(errori ? 1 : 0);
