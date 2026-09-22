'use strict';

/* Prove di "Interpreta" su referti scritti come li scrive un radiologo.
   Ogni caso dice cosa ci si aspetta; se una modifica al dizionario ne
   rompe uno, npm run check lo segnala.

   Uso:  node scripts/test-interpreta.js       (dettaglio)
         da check.js, in silenzio: esce con 1 se qualcosa non torna */

const path = require('path');
const I = require(path.join(__dirname, '..', 'src', 'interpreta.js'));

const CASI = [
  ['polmone con metastasi epatiche',
    'TC torace-addome con mdc. Nel lobo superiore del polmone destro si osserva formazione solida a margini ' +
    'spiculati di 32 x 28 mm, sospetta per neoplasia primitiva. Multiple lesioni ipodense epatiche di verosimile ' +
    'natura secondaria, la maggiore di 15 mm al VII segmento. Non versamento pleurico.',
    { sede: 'Polmone', dimensioni: '32 x 28 mm', metastasi: 'si', metaSede: 'Fegato' }],
  ['metastasi epatiche da primitivo noto',
    'In paziente con noto adenocarcinoma del colon sigmoideo, si apprezzano plurime lesioni epatiche ipodense, ' +
    'compatibili con localizzazioni secondarie, la maggiore di 4,2 cm nel VI segmento.',
    { sede: 'Fegato', dimensioni: '4,2 cm', metastasi: 'si', primitivo: 'Adenocarcinoma del colon' }],
  ['pancreas, fegato negativo',
    'Formazione ipodensa di 3 cm della testa del pancreas con dilatazione a monte del Wirsung e delle vie biliari. ' +
    'Fegato senza lesioni focali. Non adenopatie.',
    { sede: 'Pancreas', dimensioni: '3 cm', metastasi: 'no' }],
  ['solo negazioni e un calcolo',
    'Non lesioni focali epatiche. Reni in sede, di normali dimensioni. Colica renale sinistra con idronefrosi ' +
    'di I grado da calcolo di 6 mm.',
    { sede: '', dimensioni: '' }],
  ['encefalo, misura senza sede nella frase',
    'TC encefalo senza mdc: in sede frontale sinistra si osserva area ipodensa con effetto massa di 25 mm, ' +
    'sospetta per lesione occupante spazio. Conclusioni: lesione espansiva del lobo frontale sinistro.',
    { sede: 'Encefalo', dimensioni: '25 mm' }],
  ['flessura epatica e colon, non fegato',
    'Ispessimento parietale stenosante della flessura epatica del colon, esteso per 5 cm, sospetto per neoplasia. ' +
    'Linfonodi pericolici di 8 mm.',
    { sede: 'Colon', dimensioni: '5 cm' }],
  ['osso con primitivo mammario noto',
    'Multiple lesioni osteolitiche a carico dei somi vertebrali D8 e L2, di verosimile natura secondaria in noto ' +
    'carcinoma mammario.',
    { sede: 'Osso', metastasi: 'si', primitivo: 'Carcinoma della mammella' }],
  ['misura scritta attaccata con decimali',
    'Massa renale destra solida disomogenea di 4.5x3.8cm, sospetta per eteroplasia.',
    { sede: 'Rene', dimensioni: '4,5 x 3,8 cm' }],
  ['"si nota" non e\' anamnesi',
    'Fegato di normali dimensioni, senza lesioni focali. Si nota formazione nodulare solida di 14 mm nel lobo ' +
    'inferiore del polmone sinistro.',
    { sede: 'Polmone', dimensioni: '14 mm' }],
  ['stomaco con carcinosi',
    'Ispessimento parietale irregolare dell antro gastrico, spessore massimo 18 mm, con linfonodi perigastrici ' +
    'aumentati di volume, il maggiore di 12 mm. Carcinosi peritoneale con ascite.',
    { sede: 'Stomaco', dimensioni: '18 mm', metastasi: 'si' }],
  ['linfoma',
    'Voluminosi pacchetti linfonodali mediastinici e retroperitoneali, il maggiore di 6 x 4 cm, in prima ' +
    'ipotesi di natura linfoproliferativa.',
    { sede: 'Linfonodi', dimensioni: '6 x 4 cm' }],
  ['metastasi cerebrali da mammella nota',
    'Nota neoplasia mammaria sinistra. TC encefalo: multiple lesioni captanti in sede cerebellare e parietale ' +
    'destra, la maggiore di 12 mm, compatibili con localizzazioni secondarie.',
    { sede: 'Encefalo', dimensioni: '12 mm', metastasi: 'si', primitivo: 'Neoplasia della mammella' }],
  ['parola insegnata dal reparto',
    'Voluminosa formazione di 22 mm della loggia ipofisaria.',
    { sede: 'Ipofisi', dimensioni: '22 mm' },
    [{ testo: 'ipofisaria', tipo: 'sede', valore: 'Ipofisi' }]]
];

function prova(silenzioso) {
  let falliti = 0;
  CASI.forEach(([nome, testo, atteso, apprese]) => {
    const r = I.interpreta(testo, apprese || []);
    const sbagliati = Object.keys(atteso).filter((k) => r[k] !== atteso[k]);
    if (sbagliati.length) falliti++;
    if (!silenzioso || sbagliati.length) {
      console.log((sbagliati.length ? '  NO  ' : '  ok  ') + nome +
        (sbagliati.length ? ' — ' + sbagliati.map((k) => k + ': "' + r[k] + '" invece di "' + atteso[k] + '"').join(', ') : ''));
    }
  });

  // l'archivio demo e' scritto come dei referti: Interpreta deve
  // ritrovarci le stesse sedi e misure salvate nei campi
  let demoTot = 0, demoOk = 0;
  try {
    const demo = require(path.join(__dirname, '..', 'demo', 'ER OA Archive.json'));
    demo.records.filter((r) => r.diagnosi).forEach((r) => {
      demoTot++;
      const x = I.interpreta(r.diagnosi, []);
      if (x.sede === r.sede && x.dimensioni === r.dim) demoOk++;
      else if (!silenzioso) console.log('  NO  demo ' + r.id + ': ' + x.sede + ' / ' + x.dimensioni);
    });
  } catch (_) { /* senza archivio demo si provano solo i casi */ }

  return { casi: CASI.length, falliti: falliti, demoTot: demoTot, demoOk: demoOk };
}

if (require.main === module) {
  const e = prova(false);
  console.log('\n' + (e.casi - e.falliti) + '/' + e.casi + ' casi · archivio demo ' + e.demoOk + '/' + e.demoTot);
  process.exit(e.falliti || e.demoOk !== e.demoTot ? 1 : 0);
}

module.exports = prova;
