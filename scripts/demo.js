'use strict';

/* Demo dimostrativa: avvia l'app con l'archivio di pazienti INVENTATI
   conservato in demo/ps_onco_data.json.

   L'archivio demo viene copiato in dev-data/ (dopo aver salvato una copia
   di quello che c'era) e l'app parte in modalità sviluppo su quella
   cartella. Il file in demo/ non viene mai modificato: ogni demo riparte
   dagli stessi dati.

   Uso:  npm run demo */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SORGENTE = path.join(ROOT, 'demo', 'ps_onco_data.json');
const CARTELLA = path.join(ROOT, 'dev-data');
const DESTINAZIONE = path.join(CARTELLA, 'ps_onco_data.json');

if (!fs.existsSync(SORGENTE)) {
  console.error('Archivio demo non trovato: ' + SORGENTE);
  process.exit(1);
}

fs.mkdirSync(CARTELLA, { recursive: true });

if (fs.existsSync(DESTINAZIONE)) {
  const d = new Date();
  const due = (n) => String(n).padStart(2, '0');
  const marca = d.getFullYear() + due(d.getMonth() + 1) + due(d.getDate()) + '-' + due(d.getHours()) + due(d.getMinutes());
  const copia = path.join(CARTELLA, 'ps_onco_data.prima-della-demo-' + marca + '.json');
  fs.copyFileSync(DESTINAZIONE, copia);
  console.log('Archivio di sviluppo precedente salvato in ' + path.relative(ROOT, copia));
}

fs.copyFileSync(SORGENTE, DESTINAZIONE);
// un lock rimasto da una sessione chiusa male mostrerebbe "aperto altrove"
try { fs.unlinkSync(path.join(CARTELLA, 'ps_onco.lock')); } catch (_) { /* nessun lock */ }

const esami = JSON.parse(fs.readFileSync(DESTINAZIONE, 'utf8')).records.length;
console.log('Demo: ' + esami + ' esami di pazienti inventati. Avvio…');

// Da Node, require('electron') restituisce il percorso dell'eseguibile.
const electron = require('electron');
const figlio = spawn(electron, ['.', '--dev', '--demo'], { cwd: ROOT, stdio: 'inherit' });
figlio.on('exit', (codice) => process.exit(codice || 0));
