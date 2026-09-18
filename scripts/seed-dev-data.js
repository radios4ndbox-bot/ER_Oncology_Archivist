'use strict';

/* Riempie dev-data/ con esami inventati, per avere archivio e
   statistiche popolati mentre si lavora.

   Gli esami sono inventati ma verosimili: ogni richiesta del PS ha
   l'esame che di solito le si fa (una colica renale va a TC addome
   senza mdc, una cefalea a TC encefalo senza mdc) e le diagnosi sono
   scritte come un referto del PACS, con sede e misura dentro al testo.
   Cosi' la cronologia propone esami sensati anche dall'archivio, e
   "Interpreta" ha qualcosa di vero su cui lavorare nella demo.

   NON tocca mai la cartella dati vera: scrive solo dentro dev-data/
   (esclusa dal repository) o, con --demo, nell'archivio demo.

   Uso:  npm run seed            (120 esami in dev-data/)
         npm run seed -- 500     (numero a scelta)
         node scripts/seed-dev-data.js 210 --demo   (rigenera demo/) */

const fs = require('fs');
const path = require('path');

const DEMO = process.argv.indexOf('--demo') !== -1;
const numeroArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const QUANTI = Math.min(Math.max(parseInt(numeroArg, 10) || (DEMO ? 210 : 120), 1), 5000);
const FILE = DEMO
  ? path.join(__dirname, '..', 'demo', 'ps_onco_data.json')
  : path.join(__dirname, '..', 'dev-data', 'ps_onco_data.json');

const COGNOMI = ['Rossi', 'Bianchi', 'Ferrari', 'Esposito', 'Romano', 'Colombo', 'Ricci',
  'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Costa', 'Giordano',
  'Mancini', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri'];
const NOMI_M = ['Mario', 'Luigi', 'Giuseppe', 'Antonio', 'Francesco', 'Paolo', 'Marco',
  'Alessandro', 'Roberto', 'Stefano'];
const NOMI_F = ['Anna', 'Maria', 'Giulia', 'Chiara', 'Elena', 'Laura', 'Francesca',
  'Silvia', 'Paola', 'Martina'];

const TIPI = ['TC encefalo senza mdc', 'TC torace', 'TC torace con mdc', 'Angio-TC torace',
  'TC addome con mdc', 'TC addome senza mdc', 'Angio-TC addome', 'Uro-TC',
  'TC total body', 'TC rachide senza mdc', 'TC distrettuale', 'Ecografia addome', 'RX torace'];

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
const pesata = (voci) => {
  const tot = voci.reduce((s, v) => s + v[1], 0);
  let r = caso() * tot;
  for (const v of voci) { r -= v[1]; if (r <= 0) return v[0]; }
  return voci[voci.length - 1][0];
};
const lato = () => scegli(['destro', 'sinistro']);
const lata = () => scegli(['destra', 'sinistra']);

/* ── Scenari del PS ────────────────────────────────────────────────
   peso: quanto e' frequente; onco: probabilita' di un reperto
   oncologico; esami: l'esame che di solito si fa, con le alternative. */
const SCENARI = [
  { peso: 14, onco: 0.08, sedi: ['Rene', 'Vescica', 'Prostata'],
    richieste: ['colica renale sinistra', 'colica renale destra', 'dolore lombare colico', 'sospetta colica renale'],
    esami: [['TC addome senza mdc', 0.85], ['Ecografia addome', 0.15]] },
  { peso: 5, onco: 0.35, sedi: ['Vescica', 'Rene', 'Prostata'],
    richieste: ['macroematuria', 'ematuria'],
    esami: [['Uro-TC', 0.8], ['TC addome con mdc', 0.2]] },
  { peso: 16, onco: 0.18, sedi: ['Colon', 'Pancreas', 'Stomaco', 'Fegato', 'Ovaio', 'Retto'],
    richieste: ['dolore addominale', 'addominalgia diffusa', 'addome acuto', 'dolore addominale e vomito'],
    esami: [['TC addome con mdc', 0.85], ['Ecografia addome', 0.15]] },
  { peso: 5, onco: 0.15, sedi: ['Colon', 'Retto'],
    richieste: ['sospetta diverticolite', 'dolore in fossa iliaca sinistra'],
    esami: [['TC addome con mdc', 1]] },
  { peso: 5, onco: 0.4, sedi: ['Pancreas', 'Vie biliari', 'Fegato'],
    richieste: ['ittero', 'ittero di ndd', 'subittero'],
    esami: [['Ecografia addome', 0.45], ['TC addome con mdc', 0.55]] },
  { peso: 5, onco: 0.3, sedi: ['Colon', 'Stomaco', 'Retto'],
    richieste: ['melena', 'rettorragia', 'anemizzazione e melena'],
    esami: [['Angio-TC addome', 0.6], ['TC addome con mdc', 0.4]] },
  { peso: 5, onco: 0.3, sedi: ['Colon', 'Retto', 'Peritoneo'],
    richieste: ['subocclusione intestinale', 'alvo chiuso a feci e gas'],
    esami: [['TC addome con mdc', 1]] },
  { peso: 11, onco: 0.2, sedi: ['Polmone', 'Pleura', 'Mediastino'],
    richieste: ['dispnea', 'dispnea ingravescente', 'desaturazione'],
    esami: [['Angio-TC torace', 0.6], ['TC torace con mdc', 0.25], ['RX torace', 0.15]] },
  { peso: 7, onco: 0.08, sedi: ['Polmone', 'Mediastino'],
    richieste: ['dolore toracico', 'dolore retrosternale'],
    esami: [['Angio-TC torace', 0.8], ['RX torace', 0.2]] },
  { peso: 3, onco: 0.5, sedi: ['Polmone'],
    richieste: ['emottisi'],
    esami: [['TC torace con mdc', 1]] },
  { peso: 7, onco: 0.1, sedi: ['Polmone', 'Linfonodi'],
    richieste: ['febbre persistente', 'tosse e febbre', 'rialzo termico'],
    esami: [['RX torace', 0.7], ['TC torace', 0.3]] },
  { peso: 8, onco: 0.12, sedi: ['Encefalo'],
    richieste: ['cefalea', 'cefalea ingravescente', 'cefalea con vomito'],
    esami: [['TC encefalo senza mdc', 1]] },
  { peso: 6, onco: 0.2, sedi: ['Encefalo'],
    richieste: ['deficit neurologico', 'stato confusionale', 'afasia', 'crisi convulsiva'],
    esami: [['TC encefalo senza mdc', 1]] },
  { peso: 5, onco: 0.03, sedi: ['Encefalo'],
    richieste: ['trauma cranico', 'caduta con trauma cranico'],
    esami: [['TC encefalo senza mdc', 1]] },
  { peso: 3, onco: 0.03, sedi: ['Rene', 'Fegato'],
    richieste: ['politrauma', 'incidente stradale'],
    esami: [['TC total body', 1]] },
  { peso: 10, onco: 0.55, sedi: ['Polmone', 'Pancreas', 'Linfonodi', 'Stomaco', 'Colon', 'Mammella', 'Fegato'],
    richieste: ['calo ponderale', 'calo ponderale e astenia', 'sospetta neoplasia', 'linfoadenopatia'],
    esami: [['TC total body', 0.85], ['TC torace con mdc', 0.15]] },
  { peso: 5, onco: 0.3, sedi: ['Osso'],
    richieste: ['lombalgia', 'rachialgia ingravescente', 'dolore osseo'],
    esami: [['TC rachide senza mdc', 0.8], ['TC distrettuale', 0.2]] }
];

/* ── Referti ───────────────────────────────────────────────────────
   Ogni sede ha la sua frase, scritta come la scrive un radiologo; la
   misura dentro il testo e' la stessa del campo Dimensioni. */
function misura() {
  if (caso() < 0.55) { const a = intero(12, 55); const b = intero(8, a); return { testo: a + ' x ' + b + ' mm' }; }
  if (caso() < 0.5) return { testo: intero(9, 48) + ' mm' };
  return { testo: intero(2, 7) + ',' + intero(1, 9) + ' cm' };
}

const FRASI = {
  Polmone: (m) => 'Nel lobo ' + scegli(['superiore', 'inferiore']) + ' del polmone ' + lato() +
    ' si osserva formazione solida a margini spiculati di ' + m + ', sospetta per neoplasia primitiva.',
  Fegato: (m) => 'Lesione ipodensa del ' + scegli(['VI', 'VII', 'VIII', 'IV']) + ' segmento epatico di ' + m +
    ', a margini sfumati, meritevole di approfondimento.',
  Pancreas: (m) => 'Formazione ipodensa della testa del pancreas di ' + m +
    ' con dilatazione a monte del Wirsung.',
  Colon: (m) => 'Ispessimento parietale stenosante del ' + scegli(['sigma', 'colon ascendente', 'colon discendente']) +
    ' di ' + m + ', sospetto per neoplasia.',
  Retto: (m) => 'Ispessimento parietale irregolare del retto di ' + m +
    ' con infiltrazione del grasso perirettale.',
  Stomaco: (m) => 'Ispessimento parietale irregolare dell\'antro gastrico, spessore massimo ' + m + '.',
  Rene: (m) => 'Massa renale ' + lata() + ' solida disomogenea di ' + m + ', sospetta per eteroplasia.',
  Vescica: (m) => 'Formazione vegetante della parete vescicale posteriore di ' + m + '.',
  Prostata: (m) => 'Area ipodensa nella zona periferica della prostata di ' + m + ', sospetta.',
  Mammella: (m) => 'Formazione nodulare solida della mammella ' + lata() + ' di ' + m + ', sospetta.',
  Ovaio: (m) => 'Voluminosa formazione annessiale ' + lata() + ' a componente solida di ' + m + '.',
  Encefalo: (m) => 'In sede ' + scegli(['frontale', 'parietale', 'temporale']) + ' ' + lata() +
    ' si osserva lesione espansiva di ' + m + ' con edema perilesionale.',
  Linfonodi: (m) => 'Voluminosi pacchetti linfonodali mediastinici, il maggiore di ' + m +
    ', di verosimile natura linfoproliferativa.',
  Pleura: (m) => 'Ispessimento pleurico nodulare ' + lato() + ' di ' + m + ', sospetto.',
  Mediastino: (m) => 'Massa mediastinica anteriore di ' + m + '.',
  Osso: (m) => 'Lesione osteolitica del soma vertebrale L' + intero(1, 5) + ' di ' + m + '.',
  'Vie biliari': (m) => 'Ispessimento stenosante della via biliare principale di ' + m +
    ', sospetto per colangiocarcinoma.',
  Peritoneo: (m) => 'Ispessimento nodulare del peritoneo di ' + m + ' compatibile con carcinosi, con ascite.'
};

const META = [
  ['Fegato', 'Multiple lesioni epatiche di verosimile natura secondaria, la maggiore di '],
  ['Polmone', 'Plurimi noduli polmonari bilaterali di natura secondaria, il maggiore di '],
  ['Osso', 'Lesioni osteolitiche vertebrali di verosimile natura secondaria, la maggiore di '],
  ['Surrene', 'Nodulo surrenalico di natura secondaria di '],
  ['Encefalo', 'Lesioni cerebrali captanti di natura secondaria, la maggiore di ']
];

function generaEsame(i) {
  const maschio = caso() < 0.5;
  const nome = maschio ? scegli(NOMI_M) : scegli(NOMI_F);
  const anno = intero(1935, 1995);
  const dob = anno + '-' + due(intero(1, 12)) + '-' + due(intero(1, 28));

  // distribuiti sugli ultimi 14 mesi
  const indietro = intero(0, 420);
  const d = new Date(Date.now() - indietro * 86400000);
  const data = d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());

  const scenario = pesata(SCENARI.map((s) => [s, s.peso]));
  let sede = scegli(scenario.sedi);
  // niente prostata alle donne, niente ovaio agli uomini
  if (sede === 'Prostata' && !maschio) sede = 'Vescica';
  if (sede === 'Ovaio' && maschio) sede = 'Colon';

  const dado = caso();
  const onco = dado < scenario.onco * 0.75 ? 'si' : dado < scenario.onco ? 'sospetto' : '';
  const oncologico = onco === 'si' || onco === 'sospetto';
  const metastasi = oncologico ? (caso() < 0.3 ? 'si' : 'no') : null;
  const primo = oncologico && caso() < 0.55;

  let diagnosi = '', dim = '', metaSede = '', metaPrimitivo = '';
  if (oncologico) {
    const m = misura().testo;
    dim = m;
    diagnosi = FRASI[sede](m);
    if (metastasi === 'si') {
      const altre = META.filter((x) => x[0] !== sede);
      const scelta = scegli(altre);
      metaSede = scelta[0];
      metaPrimitivo = sede;
      diagnosi += ' ' + scelta[1] + intero(8, 30) + ' mm.';
    }
  }

  const creato = Date.now() - indietro * 86400000;
  return {
    id: 'seed-' + i,
    cognome: scegli(COGNOMI),
    nome: nome,
    sesso: maschio ? 'M' : 'F',
    dob: dob,
    prima_onco: onco === 'si' ? (caso() < 0.6 ? 'si' : 'no') : (caso() < 0.5 ? 'no' : 'ignoto'),
    data: data,
    tipo_esame: pesata(scenario.esami),
    richiesta: scegli(scenario.richieste),
    onco: onco,
    diagnosi: diagnosi,
    sede: oncologico ? sede : '',
    dim: dim,
    primo_riscontro: primo,
    sottocat: primo ? (caso() < 0.6 ? 'unica' : 'associata') : null,
    pat_assoc: '',
    metastasi: metastasi,
    meta_sede: metaSede,
    meta_primitivo: metaPrimitivo,
    anat: oncologico && caso() < 0.5 ? 'Referto istologico in attesa di revisione' : '',
    note: '',
    followup: oncologico && caso() < 0.25
      ? [{ date: data, type: 'Controllo', text: 'Reperto stabile al controllo' }]
      : [],
    createdAt: creato,
    updatedAt: creato
  };
}

fs.mkdirSync(path.dirname(FILE), { recursive: true });

const records = [];
for (let i = 0; i < QUANTI; i++) records.push(generaEsame(i));

const adesso = Date.now();
const store = {
  schema: 2,
  savedAt: new Date(adesso).toISOString(),
  records: records,
  deleted: {},
  tipiEsame: { lista: TIPI, updatedAt: adesso }
};

fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');

const onco = records.filter((r) => r.onco === 'si').length;
const sosp = records.filter((r) => r.onco === 'sospetto').length;
const meta = records.filter((r) => r.metastasi === 'si').length;
console.log('Scritti ' + QUANTI + ' esami in ' + FILE);
console.log('  oncologici: ' + onco + ' · sospetti: ' + sosp + ' · metastasi: ' + meta);
if (!DEMO) console.log('Avvia con:  npm run dev');
