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
['main.js', 'preload.js', 'src/app.js', 'src/zip.js', 'src/xlsx.js', 'src/pptx.js', 'src/names.js'].forEach((f) => {
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

// 2. nessun gestore di evento inline (la CSP vieta 'unsafe-inline')
const inline = html.match(/on(click|change|input|load|error|submit|focus|blur)=/g);
esito(!inline, 'nessun gestore inline nell\'HTML', inline ? inline.length + ' trovati' : '');

// 3. nessuna risorsa remota (l'app deve funzionare offline)
const remote = html.match(/(src|href)="https?:\/\//g);
esito(!remote, 'nessuna risorsa remota', remote ? remote.join(' ') : '');

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
const idsDinamici = new Set(['notaEdit']);
const mancanti = [...idsJs].filter((id) => !idsHtml.has(id) && !idsDinamici.has(id));
esito(mancanti.length === 0, 'ogni id usato dal JS esiste', mancanti.join(', '));

// 8. nessun carattere di controllo nei sorgenti
[['src/app.js', app], ['src/styles.css', css], ['main.js', main]].forEach(([nome, testo]) => {
  const brutti = [...testo].filter((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t');
  esito(brutti.length === 0, 'nessun carattere di controllo in ' + nome, brutti.length || '');
});

// 8b. il renderer non può cancellare l'archivio
esito(/if \(name !== LOCK_FILE\) throw/.test(main), 'fs:deleteFile limitato al lock');

// 9. versione allineata fra package.json e lockfile
const pkg = JSON.parse(leggi('package.json'));
const lock = JSON.parse(leggi('package-lock.json'));
esito(pkg.version === lock.version, 'versione allineata col lockfile',
  pkg.version + ' / ' + lock.version);

console.log('\n' + (errori ? errori + ' controlli falliti\n' : 'Tutto a posto\n'));
process.exit(errori ? 1 : 0);
