'use strict';

/* Riempie dev-data/ con esami inventati, per avere archivio e
   statistiche popolati mentre si lavora.

   NON tocca mai la cartella dati vera: scrive solo dentro dev-data/,
   che è esclusa dal repository.

   Uso:  npm run seed          (120 esami)
         npm run seed -- 500   (numero a scelta) */

const fs = require('fs');
const path = require('path');

const CARTELLA = path.join(__dirname, '..', 'dev-data');
const FILE = path.join(CARTELLA, 'ps_onco_data.json');
const QUANTI = Math.min(Math.max(parseInt(process.argv[2], 10) || 120, 1), 5000);

const COGNOMI = ['Rossi', 'Bianchi', 'Ferrari', 'Esposito', 'Romano', 'Colombo', 'Ricci',
  'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Costa', 'Giordano',
  'Mancini', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri'];
const NOMI_M = ['Mario', 'Luigi', 'Giuseppe', 'Antonio', 'Francesco', 'Paolo', 'Marco',
  'Alessandro', 'Roberto', 'Stefano'];
const NOMI_F = ['Anna', 'Maria', 'Giulia', 'Chiara', 'Elena', 'Laura', 'Francesca',
  'Silvia', 'Paola', 'Martina'];
const ESAMI = ['TC torace', 'TC addome', 'TC total body', 'Ecografia addome',
  'RMN encefalo', 'RX torace', 'Ecografia collo'];
const SEDI = ['Polmone', 'Colon', 'Fegato', 'Pancreas', 'Mammella', 'Rene', 'Stomaco',
  'Encefalo', 'Prostata', 'Ovaio'];
const META_SEDI = ['Fegato', 'Polmone', 'Encefalo', 'Osso', 'Surrene'];
const RICHIESTE = ['dolore addominale', 'dispnea', 'trauma', 'febbre persistente',
  'calo ponderale', 'dolore toracico', 'ittero', 'cefalea'];

// Generatore deterministico: rilanciando lo script si ottengono gli
// stessi dati, così i confronti fra una modifica e l'altra sono validi.
let seme = 20260101;
function caso() {
  seme = (seme * 1103515245 + 12345) % 2147483648;
  return seme / 2147483648;
}
const scegli = (arr) => arr[Math.floor(caso() * arr.length)];
const intero = (min, max) => min + Math.floor(caso() * (max - min + 1));
const due = (n) => String(n).padStart(2, '0');

function generaEsame(i) {
  const maschio = caso() < 0.5;
  const nome = maschio ? scegli(NOMI_M) : scegli(NOMI_F);
  const anno = intero(1935, 1995);
  const dob = anno + '-' + due(intero(1, 12)) + '-' + due(intero(1, 28));

  // distribuiti sugli ultimi 14 mesi
  const indietro = intero(0, 420);
  const d = new Date(Date.now() - indietro * 86400000);
  const data = d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());

  const dado = caso();
  const onco = dado < 0.22 ? 'si' : dado < 0.32 ? 'sospetto' : '';
  const oncologico = onco === 'si' || onco === 'sospetto';
  const metastasi = oncologico ? (caso() < 0.3 ? 'si' : 'no') : null;
  const primo = oncologico && caso() < 0.55;

  const creato = Date.now() - indietro * 86400000;
  return {
    id: 'seed-' + i,
    cognome: scegli(COGNOMI),
    nome: nome,
    sesso: maschio ? 'M' : 'F',
    dob: dob,
    prima_onco: onco === 'si' ? (caso() < 0.6 ? 'si' : 'no') : (caso() < 0.5 ? 'no' : 'ignoto'),
    data: data,
    tipo_esame: scegli(ESAMI),
    richiesta: scegli(RICHIESTE),
    onco: onco,
    diagnosi: oncologico ? 'Lesione sospetta di ' + intero(8, 60) + ' mm' : '',
    sede: oncologico ? scegli(SEDI) : '',
    dim: oncologico ? intero(8, 60) + ' mm' : '',
    primo_riscontro: primo,
    sottocat: primo ? (caso() < 0.6 ? 'unica' : 'associata') : null,
    pat_assoc: '',
    metastasi: metastasi,
    meta_sede: metastasi === 'si' ? scegli(META_SEDI) : '',
    meta_primitivo: metastasi === 'si' ? scegli(SEDI) : '',
    anat: oncologico && caso() < 0.5 ? 'Referto istologico in attesa di revisione' : '',
    note: '',
    followup: oncologico && caso() < 0.25
      ? [{ date: data, type: 'Controllo', text: 'Reperto stabile al controllo' }]
      : [],
    createdAt: creato,
    updatedAt: creato
  };
}

fs.mkdirSync(CARTELLA, { recursive: true });

const records = [];
for (let i = 0; i < QUANTI; i++) records.push(generaEsame(i));

const store = {
  schema: 2,
  savedAt: new Date().toISOString(),
  records: records,
  deleted: {}
};

fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');

const onco = records.filter((r) => r.onco === 'si').length;
const sosp = records.filter((r) => r.onco === 'sospetto').length;
const meta = records.filter((r) => r.metastasi === 'si').length;
console.log('Scritti ' + QUANTI + ' esami in ' + FILE);
console.log('  oncologici: ' + onco + ' · sospetti: ' + sosp + ' · metastasi: ' + meta);
console.log('Avvia con:  npm run dev');
