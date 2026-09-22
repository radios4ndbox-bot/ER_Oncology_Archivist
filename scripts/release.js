'use strict';

/* Prepara una release in locale, senza dipendere dalle GitHub Actions.

   Fa quello che farebbe la pipeline: controlli, build di portable e
   installer, checksum SHA-256 e note della release. Alla fine in dist/
   c'è tutto quello che serve da allegare a una release su GitHub —
   utile quando lo spazio delle Actions è esaurito, o quando serve una
   copia subito senza aspettare la pipeline.

   Uso:  npm run release
         npm run release -- --senza-build   (riusa gli .exe già in dist/) */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SENZA_BUILD = process.argv.indexOf('--senza-build') !== -1;
const versione = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function passo(titolo) {
  console.log('\n── ' + titolo + ' ' + '─'.repeat(Math.max(0, 58 - titolo.length)));
}

passo('Controlli');
execFileSync(process.execPath, [path.join(__dirname, 'check.js')], { stdio: 'inherit' });

if (!SENZA_BUILD) {
  passo('Build portable + installer');
  // Si chiama direttamente il programma di electron-builder con node:
  // lanciare npx.cmd da uno script fallisce su Windows (EINVAL: Node
  // non avvia piu' i .cmd senza shell), e una shell qui non serve.
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  // gli stessi argomenti della pipeline: nessuna pubblicazione automatica
  execFileSync(process.execPath, [cli, '--win', 'portable', 'nsis', '--publish', 'never'],
    { cwd: ROOT, stdio: 'inherit' });
}

passo('Checksum SHA-256');
const esebili = fs.readdirSync(DIST)
  .filter((f) => f.toLowerCase().endsWith('.exe') && f.indexOf(versione) !== -1)
  .sort();
if (!esebili.length) {
  console.error('Nessun eseguibile della versione ' + versione + ' in dist/. Lancia senza --senza-build.');
  process.exit(1);
}
const righe = esebili.map((f) => {
  const dati = fs.readFileSync(path.join(DIST, f));
  const hash = crypto.createHash('sha256').update(dati).digest('hex');
  console.log('  ' + (dati.length / 1048576).toFixed(1).padStart(6) + ' MB  ' + f);
  return hash + '  ' + f;
});
const sommeFile = path.join(DIST, 'SHA256SUMS.txt');
fs.writeFileSync(sommeFile, righe.join('\n') + '\n', 'utf8');

passo('Note della release');
const note = [
  '## ER Oncology Archivist v' + versione,
  '',
  '**Quale file scaricare**',
  '',
  '| file | quando usarlo |',
  '|---|---|',
  '| `...-portable.exe` | copialo sulla share e lancialo. Nessuna installazione, nessun diritto di amministratore. |',
  '| `...-setup.exe` | installazione classica, se preferisci il collegamento nel menu Start. |',
  '',
  '**Gli eseguibili non sono firmati.** Al primo avvio Windows SmartScreen mostra',
  '"Windows ha protetto il PC": *Ulteriori informazioni* -> *Esegui comunque*.',
  'Verifica prima il checksum qui sotto.',
  '',
  '```',
  righe.join('\n'),
  '```',
  '',
  'In PowerShell: `Get-FileHash .\\nomefile.exe -Algorithm SHA256`'
].join('\n');
const noteFile = path.join(DIST, 'note-release.md');
fs.writeFileSync(noteFile, note + '\n', 'utf8');

passo('Pronto');
console.log('In dist/ ci sono i file da allegare alla release v' + versione + ':');
esebili.concat(['SHA256SUMS.txt', 'note-release.md']).forEach((f) => console.log('  dist/' + f));
console.log('\nPer pubblicarli su GitHub senza le Actions:');
console.log('  1. git tag v' + versione + ' && git push origin v' + versione);
console.log('  2. sul repository: Releases → Draft a new release → tag v' + versione);
console.log('  3. trascina i file qui sopra, incolla dist/note-release.md e pubblica');
