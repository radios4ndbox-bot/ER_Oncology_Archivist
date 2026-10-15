'use strict';

/* Riempie dev-data/ con esami inventati, per avere archivio e
   statistiche popolati mentre si lavora — o, con --demo, rigenera
   l'archivio della demo dimostrativa.

   Gli esami coprono UN ANNO di attivita' del PS (1 ottobre 2025 -
   30 settembre 2026) e sono inventati ma verosimili:

   * ogni richiesta del PS ha l'esame che di solito le si fa (una colica
     renale va a TC addome senza mdc, una cefalea a TC encefalo senza mdc);
   * la stagione conta: d'inverno piu' dispnee e febbri, d'estate piu'
     coliche e traumi;
   * le diagnosi sono scritte come un referto del PACS, con sede e misura
     dentro al testo — anche quelle non oncologiche (calcoli, embolie,
     polmoniti, fratture), cosi' "Interpreta" ha qualcosa di vero su cui
     lavorare e impara a non vedere tumori dove non ci sono;
   * una parte dei pazienti oncologici RITORNA in PS nei mesi successivi:
     stessa persona, prima diagnosi gia' nota, e il referto racconta la
     storia (progressione, compressione midollare, embolia, sindrome
     cavale, febbre in neutropenia...), con l'esito istologico nel
     follow-up di anatomia patologica.

   Generatore deterministico: rilanciando lo script si ottengono gli
   stessi dati, così i confronti fra una modifica e l'altra sono validi.

   NON tocca mai la cartella dati vera: scrive solo dentro dev-data/
   (esclusa dal repository) o, con --demo, nell'archivio demo.

   Uso:  npm run seed            (120 esami in dev-data/)
         npm run seed -- 500     (numero a scelta)
         node scripts/seed-dev-data.js 420 --demo   (rigenera demo/) */

const fs = require('fs');
const path = require('path');

const DEMO = process.argv.indexOf('--demo') !== -1;
const numeroArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const QUANTI = Math.min(Math.max(parseInt(numeroArg, 10) || (DEMO ? 420 : 120), 1), 5000);
const FILE = DEMO
  ? path.join(__dirname, '..', 'demo', 'ER OA Archive.json')
  : path.join(__dirname, '..', 'dev-data', 'ER OA Archive.json');

// L'anno coperto. Fisso, non "gli ultimi 12 mesi": con Date.now() i dati
// cambierebbero da un giorno all'altro.
const INIZIO = Date.UTC(2025, 9, 1);           // 1 ottobre 2025
const GIORNI = 365;                            // fino al 30 settembre 2026
const SALVATO = Date.UTC(2026, 8, 30, 19, 42); // ultimo salvataggio dell'archivio

const COGNOMI = ['Rossi', 'Bianchi', 'Ferrari', 'Esposito', 'Romano', 'Colombo', 'Ricci',
  'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Costa', 'Giordano',
  'Mancini', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri', 'Fontana', 'Santoro', 'Mariani',
  'Rinaldi', 'Caruso', 'Ferrara', 'Galli', 'Martini', 'Leone', 'Longo', 'Gentile',
  'Martinelli', 'Vitale', 'Lombardo', 'Serra', 'Coppola', 'De Santis', "D'Angelo",
  'Marchetti', 'Parisi', 'Villa', 'Conte', 'Ferraro', 'Ferri', 'Fabbri', 'Bianco',
  'Marini', 'Grasso', 'Valentini', 'Messina', 'Sala', 'De Angelis', 'Gatti', 'Pellegrini',
  'Palumbo', 'Sanna', 'Farina', 'Rizzi', 'Monti', 'Cattaneo', 'Morelli', 'Amato',
  'Silvestri', 'Mazza', 'Testa', 'Grassi', 'Pellegrino', 'Carbone', 'Giuliani', 'Benedetti'];
const NOMI_M = ['Mario', 'Luigi', 'Giuseppe', 'Antonio', 'Francesco', 'Paolo', 'Marco',
  'Alessandro', 'Roberto', 'Stefano', 'Giovanni', 'Andrea', 'Luca', 'Salvatore', 'Vincenzo',
  'Pietro', 'Carlo', 'Franco', 'Domenico', 'Bruno', 'Sergio', 'Giorgio', 'Enrico', 'Massimo',
  'Claudio', 'Renato', 'Fabio', 'Davide', 'Matteo', 'Riccardo', 'Alberto', 'Gianni',
  'Angelo', 'Nicola', 'Emilio', 'Vittorio', 'Raffaele', 'Ugo', 'Aldo', 'Tommaso'];
const NOMI_F = ['Anna', 'Maria', 'Giulia', 'Chiara', 'Elena', 'Laura', 'Francesca',
  'Silvia', 'Paola', 'Martina', 'Rosa', 'Angela', 'Giovanna', 'Teresa', 'Lucia', 'Carmela',
  'Caterina', 'Franca', 'Rita', 'Giuseppina', 'Antonella', 'Patrizia', 'Daniela', 'Sara',
  'Federica', 'Valentina', 'Simona', 'Roberta', 'Monica', 'Alessandra', 'Cristina',
  'Barbara', 'Marisa', 'Luisa', 'Graziella', 'Ilaria', 'Emma', 'Gabriella', 'Nadia', 'Bruna'];

const TIPI = ['TC encefalo senza mdc', 'TC torace', 'TC torace con mdc', 'Angio-TC torace',
  'TC addome con mdc', 'TC addome senza mdc', 'Angio-TC addome', 'Uro-TC',
  'TC total body', 'TC rachide senza mdc', 'TC distrettuale', 'Ecografia addome', 'RX torace'];

let seme = 20251001;
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
const isoGiorno = (g) => new Date(INIZIO + g * 86400000).toISOString().slice(0, 10);
const mese = (g) => new Date(INIZIO + g * 86400000).getUTCMonth() + 1;

/* ── Pazienti ──────────────────────────────────────────────────────
   Chi arriva in un PS oncologico e' in prevalenza anziano. */
function nuovoPaziente(eta) {
  const maschio = caso() < 0.5;
  const anni = eta || pesata([[intero(22, 44), 10], [intero(45, 59), 22], [intero(60, 74), 38],
    [intero(75, 84), 22], [intero(85, 96), 8]]);
  return {
    maschio: maschio,
    cognome: scegli(COGNOMI),
    nome: maschio ? scegli(NOMI_M) : scegli(NOMI_F),
    dob: (2026 - anni) + '-' + due(intero(1, 12)) + '-' + due(intero(1, 28))
  };
}

/* ── Scenari del PS ────────────────────────────────────────────────
   peso: frequenza; stagione: moltiplicatore per mese (inverno/estate);
   onco: probabilita' di un reperto oncologico; esami: l'esame tipico
   con le alternative; benigni: i referti quando il tumore non c'e'. */
const INVERNO = [11, 12, 1, 2, 3];
const ESTATE = [6, 7, 8, 9];

const BENIGNI = {
  colica: [
    () => 'Calcolo dell\'uretere lombare ' + lato() + ' di ' + intero(3, 9) + ' mm con idronefrosi di ' +
      scegli(['I', 'II']) + ' grado.',
    () => 'Calcolo al giunto pielo-ureterale ' + lato() + ' di ' + intero(4, 11) + ' mm, lieve ectasia calico-pielica.',
    () => 'Calcolo dell\'uretere pelvico ' + lato() + ' di ' + intero(2, 6) + ' mm con modesta idroureteronefrosi.',
    () => 'Non calcoli lungo le vie escretrici. Non idronefrosi.'
  ],
  ematuria: [
    () => 'Non difetti di riempimento delle vie escretrici. Ipertrofia prostatica con impronta sul pavimento vescicale.',
    () => 'Coaguli endovescicali in assenza di alterazioni parietali. Cistite emorragica.'
  ],
  addome: [
    () => 'Non pneumoperitoneo. Non versamento libero. Modesta distensione gassosa delle anse coliche.',
    () => 'Colecisti distesa con pareti edematose e calcoli nel lume, quadro di colecistite acuta.',
    () => 'Appendice ciecale ispessita con imbibizione del grasso circostante, quadro di appendicite acuta.',
    () => 'Edema peripancreatico con imbibizione del grasso, quadro di pancreatite acuta edematosa.',
    () => 'Pneumoperitoneo libero da perforazione di viscere cavo.',
    () => 'Non reperti di rilievo in ambito addominale.'
  ],
  diverticolite: [
    () => 'Diverticolite acuta del sigma con imbibizione del grasso pericolico, senza raccolte.',
    () => 'Diverticolite complicata del sigma con raccolta pericolica di ' + intero(2, 5) + ' cm e bolle aeree extraluminali.',
    () => 'Diverticolosi del sigma senza segni di flogosi in atto.'
  ],
  ittero: [
    () => 'Coledocolitiasi con dilatazione delle vie biliari intra ed extraepatiche.',
    () => 'Calcolosi della colecisti. Coledoco di calibro nei limiti.'
  ],
  sanguinamento: [
    () => 'Spandimento attivo di mdc in fase arteriosa nel colon discendente, su base diverticolare.',
    () => 'Non spandimento di mdc in atto. Diverticolosi del colon.',
    () => 'Ulcera duodenale con sanguinamento in atto in fase arteriosa.'
  ],
  occlusione: [
    () => 'Distensione delle anse del tenue con livelli idroaerei, verosimilmente da briglia aderenziale.',
    () => 'Volvolo del sigma con marcata distensione del colon a monte.',
    () => 'Ernia inguinale ' + lata() + ' contenente ansa del tenue, con segni di sofferenza.'
  ],
  dispnea: [
    () => 'Difetti di riempimento endoluminali delle arterie polmonari lobari bilaterali, compatibili con embolia polmonare.',
    () => 'Embolia polmonare segmentaria del lobo inferiore ' + lato() + '. Non segni di sovraccarico destro.',
    () => 'Non difetti di riempimento delle arterie polmonari. Versamento pleurico bilaterale di grado lieve.',
    () => 'Edema interstiziale con versamento pleurico bilaterale, quadro di scompenso cardiaco.',
    () => 'Enfisema centrolobulare diffuso. Non addensamenti in atto.'
  ],
  toracico: [
    () => 'Non difetti di riempimento delle arterie polmonari. Aorta toracica di calibro regolare.',
    () => 'Dissezione aortica tipo B dall\'origine della succlavia sinistra all\'aorta addominale.',
    () => 'Pneumotorace ' + lato() + ' di ' + intero(1, 4) + ' cm all\'apice.'
  ],
  febbre: [
    () => 'Addensamento parenchimale del lobo inferiore ' + lato() + ', di verosimile natura flogistica.',
    () => 'Opacita\' a vetro smerigliato bilaterali, quadro compatibile con polmonite interstiziale.',
    () => 'Non addensamenti parenchimali in atto. Seni costofrenici liberi.',
    () => 'Addensamento parenchimale basale ' + lato() + ' con modesto versamento pleurico.'
  ],
  cefalea: [
    () => 'Non emorragie intracraniche in atto. Sistema ventricolare in asse.',
    () => 'Emorragia subaracnoidea nelle cisterne della base e nella scissura silviana ' + lata() + '.',
    () => 'Leucoencefalopatia vascolare cronica. Non sanguinamenti in atto.'
  ],
  neuro: [
    () => 'Ematoma intraparenchimale nucleo-capsulare ' + lato() + ' con inondazione ventricolare.',
    () => 'Sfumata perdita della differenziazione cortico-sottocorticale in sede insulare ' + lata() + ', ischemia acuta.',
    () => 'Leucoencefalopatia vascolare cronica. Non sanguinamenti in atto.',
    () => 'Esiti ischemici lacunari dei nuclei della base, invariati.'
  ],
  trauma: [
    () => 'Non emorragie intracraniche in atto. Non fratture della teca.',
    () => 'Ematoma subdurale acuto fronto-parietale ' + lato() + ' di ' + intero(4, 12) + ' mm di spessore.',
    () => 'Frattura composta della teca in sede occipitale ' + lata() + ', senza emorragie associate.'
  ],
  politrauma: [
    () => 'Fratture costali multiple a ' + lata() + ' con pneumotorace di modesta entita\'.',
    () => 'Lacerazione splenica con emoperitoneo di modesta entita\'.',
    () => 'Non lesioni traumatiche viscerali. Frattura del radio distale ' + lato() + '.'
  ],
  rachide: [
    () => 'Frattura da compressione del soma di L' + intero(1, 4) + ', di aspetto osteoporotico.',
    () => 'Discopatia degenerativa L4-L5 e L5-S1 con riduzione dello spazio intersomatico.',
    () => 'Spondiloartrosi diffusa, non fratture recenti.'
  ],
  stadiazione: [
    () => 'Non reperti di rilievo in ambito toraco-addominale.',
    () => 'Epatomegalia steatosica. Non linfoadenomegalie.'
  ]
};

const SCENARI = [
  { peso: 13, stagione: ESTATE, onco: 0.06, sedi: ['Rene', 'Vescica', 'Prostata'], benigni: 'colica',
    richieste: ['colica renale sinistra', 'colica renale destra', 'dolore lombare colico', 'sospetta colica renale'],
    esami: [['TC addome senza mdc', 0.85], ['Ecografia addome', 0.15]] },
  { peso: 5, onco: 0.35, sedi: ['Vescica', 'Rene', 'Prostata'], benigni: 'ematuria',
    richieste: ['macroematuria', 'ematuria', 'ematuria con coaguli'],
    esami: [['Uro-TC', 0.8], ['TC addome con mdc', 0.2]] },
  { peso: 15, onco: 0.16, sedi: ['Colon', 'Pancreas', 'Stomaco', 'Fegato', 'Ovaio', 'Retto', 'Colecisti',
    'Intestino tenue', 'Utero'], benigni: 'addome',
    richieste: ['dolore addominale', 'addominalgia diffusa', 'addome acuto', 'dolore addominale e vomito',
      'dolore in ipocondrio destro', 'dolore epigastrico'],
    esami: [['TC addome con mdc', 0.85], ['Ecografia addome', 0.15]] },
  { peso: 5, stagione: ESTATE, onco: 0.12, sedi: ['Colon', 'Retto'], benigni: 'diverticolite',
    richieste: ['sospetta diverticolite', 'dolore in fossa iliaca sinistra'],
    esami: [['TC addome con mdc', 1]] },
  { peso: 5, onco: 0.4, sedi: ['Pancreas', 'Vie biliari', 'Fegato'], benigni: 'ittero',
    richieste: ['ittero', 'ittero di ndd', 'subittero', 'ittero indolore'],
    esami: [['Ecografia addome', 0.4], ['TC addome con mdc', 0.6]] },
  { peso: 5, onco: 0.3, sedi: ['Colon', 'Stomaco', 'Retto', 'Esofago'], benigni: 'sanguinamento',
    richieste: ['melena', 'rettorragia', 'anemizzazione e melena', 'ematemesi'],
    esami: [['Angio-TC addome', 0.6], ['TC addome con mdc', 0.4]] },
  { peso: 5, onco: 0.3, sedi: ['Colon', 'Retto', 'Peritoneo', 'Intestino tenue'], benigni: 'occlusione',
    richieste: ['subocclusione intestinale', 'alvo chiuso a feci e gas', 'distensione addominale'],
    esami: [['TC addome con mdc', 1]] },
  { peso: 10, stagione: INVERNO, onco: 0.18, sedi: ['Polmone', 'Pleura', 'Mediastino'], benigni: 'dispnea',
    richieste: ['dispnea', 'dispnea ingravescente', 'desaturazione', 'sospetta embolia polmonare'],
    esami: [['Angio-TC torace', 0.6], ['TC torace con mdc', 0.25], ['RX torace', 0.15]] },
  { peso: 7, onco: 0.06, sedi: ['Polmone', 'Mediastino'], benigni: 'toracico',
    richieste: ['dolore toracico', 'dolore retrosternale', 'dolore toracico trafittivo'],
    esami: [['Angio-TC torace', 0.8], ['RX torace', 0.2]] },
  { peso: 3, onco: 0.5, sedi: ['Polmone'], benigni: 'febbre',
    richieste: ['emottisi', 'tosse con emottisi'],
    esami: [['TC torace con mdc', 1]] },
  { peso: 8, stagione: INVERNO, onco: 0.08, sedi: ['Polmone', 'Linfonodi'], benigni: 'febbre',
    richieste: ['febbre persistente', 'tosse e febbre', 'rialzo termico', 'sospetta polmonite'],
    esami: [['RX torace', 0.65], ['TC torace', 0.35]] },
  { peso: 7, onco: 0.1, sedi: ['Encefalo'], benigni: 'cefalea',
    richieste: ['cefalea', 'cefalea ingravescente', 'cefalea con vomito', 'cefalea a rombo di tuono'],
    esami: [['TC encefalo senza mdc', 1]] },
  { peso: 6, onco: 0.18, sedi: ['Encefalo'], benigni: 'neuro',
    richieste: ['deficit neurologico', 'stato confusionale', 'afasia', 'crisi convulsiva', 'emiparesi'],
    esami: [['TC encefalo senza mdc', 1]] },
  { peso: 5, stagione: ESTATE, onco: 0.02, sedi: ['Encefalo'], benigni: 'trauma',
    richieste: ['trauma cranico', 'caduta con trauma cranico', 'trauma cranico in TAO'],
    esami: [['TC encefalo senza mdc', 1]] },
  { peso: 3, stagione: ESTATE, onco: 0.03, sedi: ['Rene', 'Fegato', 'Surrene'], benigni: 'politrauma',
    richieste: ['politrauma', 'incidente stradale', 'caduta dall\'alto'],
    esami: [['TC total body', 1]] },
  { peso: 10, onco: 0.6, sedi: ['Polmone', 'Pancreas', 'Linfonodi', 'Stomaco', 'Colon', 'Mammella', 'Fegato',
    'Rene', 'Esofago', 'Milza', 'Surrene', 'Testa-collo', 'Tiroide'], benigni: 'stadiazione',
    richieste: ['calo ponderale', 'calo ponderale e astenia', 'sospetta neoplasia', 'linfoadenopatia',
      'anemia sideropenica', 'sudorazioni notturne'],
    esami: [['TC total body', 0.85], ['TC torace con mdc', 0.15]] },
  { peso: 5, onco: 0.3, sedi: ['Osso', 'Parti molli'], benigni: 'rachide',
    richieste: ['lombalgia', 'rachialgia ingravescente', 'dolore osseo', 'tumefazione dolente della coscia'],
    esami: [['TC rachide senza mdc', 0.7], ['TC distrettuale', 0.3]] }
];

/* ── Referti oncologici ────────────────────────────────────────────
   Ogni sede ha la sua frase, scritta come la scrive un radiologo; la
   misura dentro il testo e' la stessa del campo Dimensioni. */
function misura() {
  if (caso() < 0.55) { const a = intero(12, 55); const b = intero(8, a); return a + ' x ' + b + ' mm'; }
  if (caso() < 0.5) return intero(9, 48) + ' mm';
  return intero(2, 7) + ',' + intero(1, 9) + ' cm';
}

const FRASI = {
  Polmone: (m) => 'Nel lobo ' + scegli(['superiore', 'inferiore']) + ' del polmone ' + lato() +
    ' si osserva formazione solida a margini spiculati di ' + m + ', sospetta per neoplasia primitiva.',
  Fegato: (m) => 'Lesione ipodensa del ' + scegli(['VI', 'VII', 'VIII', 'IV']) + ' segmento epatico di ' + m +
    ', a margini sfumati, meritevole di approfondimento.',
  Pancreas: (m) => 'Formazione ipodensa della ' + scegli(['testa', 'coda']) + ' del pancreas di ' + m +
    ' con dilatazione a monte del Wirsung.',
  Colon: (m) => 'Ispessimento parietale stenosante del ' +
    scegli(['sigma', 'colon ascendente', 'colon discendente', 'colon trasverso', 'cieco']) +
    ' di ' + m + ', sospetto per neoplasia.',
  Retto: (m) => 'Ispessimento parietale irregolare del retto di ' + m +
    ' con infiltrazione del grasso perirettale.',
  Stomaco: (m) => 'Ispessimento parietale irregolare dell\'antro gastrico, spessore massimo ' + m + '.',
  Esofago: (m) => 'Ispessimento parietale circonferenziale dell\'esofago distale di ' + m + ', sospetto per neoplasia.',
  Rene: (m) => 'Massa renale ' + lata() + ' solida disomogenea di ' + m + ', sospetta per eteroplasia.',
  Surrene: (m) => 'Massa surrenalica ' + lata() + ' disomogenea di ' + m + ', meritevole di caratterizzazione.',
  Vescica: (m) => 'Formazione vegetante della parete vescicale ' + scegli(['posteriore', 'laterale']) + ' di ' + m + '.',
  Prostata: (m) => 'Area ipodensa nella zona periferica della prostata di ' + m + ', sospetta.',
  Mammella: (m) => 'Formazione nodulare solida della mammella ' + lata() + ' di ' + m + ', sospetta.',
  Ovaio: (m) => 'Voluminosa formazione annessiale ' + lata() + ' a componente solida di ' + m + '.',
  Utero: (m) => 'Formazione solida disomogenea del corpo dell\'utero di ' + m + ', sospetta per neoplasia endometriale.',
  Colecisti: (m) => 'Ispessimento parietale irregolare della colecisti di ' + m + ', sospetto per neoplasia.',
  'Intestino tenue': (m) => 'Ispessimento parietale stenosante dell\'ultima ansa ileale di ' + m + '.',
  Encefalo: (m) => 'In sede ' + scegli(['frontale', 'parietale', 'temporale', 'occipitale']) + ' ' + lata() +
    ' si osserva lesione espansiva di ' + m + ' con edema perilesionale.',
  Linfonodi: (m) => 'Voluminosi pacchetti linfonodali ' + scegli(['mediastinici', 'lomboaortici', 'mesenterici']) +
    ', il maggiore di ' + m + ', di verosimile natura linfoproliferativa.',
  Milza: (m) => 'Lesioni ipodense multiple della milza, la maggiore di ' + m + ', da riferire a linfoma.',
  Pleura: (m) => 'Ispessimento pleurico nodulare ' + lato() + ' di ' + m + ', sospetto.',
  Mediastino: (m) => 'Massa mediastinica anteriore di ' + m + '.',
  Osso: (m) => 'Lesione osteolitica del soma vertebrale L' + intero(1, 5) + ' di ' + m + '.',
  'Parti molli': (m) => 'Voluminosa massa delle parti molli della coscia ' + lata() + ' di ' + m +
    ', sospetta per sarcoma.',
  'Vie biliari': (m) => 'Ispessimento stenosante della via biliare principale di ' + m +
    ', sospetto per colangiocarcinoma.',
  Peritoneo: (m) => 'Ispessimento nodulare del peritoneo di ' + m + ' compatibile con carcinosi, con ascite.',
  Tiroide: (m) => 'Nodulo solido disomogeneo del lobo tiroideo ' + lato() + ' di ' + m + ', da approfondire.',
  'Testa-collo': (m) => 'Massa solida della regione laringea sopraglottica di ' + m + ', sospetta per neoplasia.'
};

// La storia in anamnesi, come la scrive il radiologo: "Noto carcinoma
// della mammella". Interpreta la legge come primitivo, non come lesione.
const ISTOLOGIA = {
  Polmone: ['Adenocarcinoma', 'del polmone'],
  Pancreas: ['Adenocarcinoma', 'del pancreas'], Colon: ['Adenocarcinoma', 'del colon'],
  Retto: ['Adenocarcinoma', 'del retto'], Stomaco: ['Adenocarcinoma', 'dello stomaco'],
  Esofago: ['Carcinoma', 'dell’esofago'], Rene: ['Carcinoma', 'del rene'],
  Vescica: ['Carcinoma', 'della vescica'], Prostata: ['Adenocarcinoma', 'della prostata'],
  Mammella: ['Carcinoma', 'della mammella'], Ovaio: ['Carcinoma', 'dell’ovaio'],
  Utero: ['Carcinoma', 'dell’utero'], Linfonodi: ['Linfoma', '']
};
const primitivoTesto = (sede) => {
  const i = ISTOLOGIA[sede];
  return i ? (i[1] ? i[0] + ' ' + i[1] : i[0]) : '';
};
const anamnesi = (sede) => {
  const i = ISTOLOGIA[sede];
  return 'Noto ' + i[0].toLowerCase() + (i[1] ? ' ' + i[1].replace('’', '\'') : '') + '.';
};

const ESITI_ISTO = {
  Polmone: ['Adenocarcinoma polmonare, TTF-1 positivo', 'Carcinoma squamocellulare del polmone',
    'Carcinoma a piccole cellule'],
  Fegato: ['Epatocarcinoma moderatamente differenziato', 'Metastasi di adenocarcinoma'],
  Pancreas: ['Adenocarcinoma duttale del pancreas'],
  Colon: ['Adenocarcinoma moderatamente differenziato (G2)', 'Adenocarcinoma mucinoso'],
  Retto: ['Adenocarcinoma del retto G2'], Stomaco: ['Adenocarcinoma gastrico di tipo diffuso'],
  Esofago: ['Adenocarcinoma della giunzione esofago-gastrica', 'Carcinoma squamocellulare'],
  Rene: ['Carcinoma renale a cellule chiare'], Surrene: ['Adenoma corticosurrenalico'],
  Vescica: ['Carcinoma uroteliale di alto grado'], Prostata: ['Adenocarcinoma prostatico, Gleason 4+3'],
  Mammella: ['Carcinoma duttale infiltrante, HER2 negativo', 'Carcinoma lobulare infiltrante'],
  Ovaio: ['Carcinoma sieroso di alto grado'], Utero: ['Carcinoma endometrioide G2'],
  Colecisti: ['Adenocarcinoma della colecisti'], 'Intestino tenue': ['Tumore neuroendocrino ben differenziato (G1)'],
  Encefalo: ['Glioblastoma IDH wild-type', 'Metastasi di adenocarcinoma'],
  Linfonodi: ['Linfoma diffuso a grandi cellule B', 'Linfoma di Hodgkin classico'],
  Milza: ['Linfoma della zona marginale'], Pleura: ['Mesotelioma epitelioide'],
  Mediastino: ['Timoma di tipo B2', 'Linfoma primitivo del mediastino'],
  Osso: ['Mieloma multiplo', 'Metastasi di carcinoma'], 'Parti molli': ['Liposarcoma dedifferenziato'],
  'Vie biliari': ['Colangiocarcinoma'], Peritoneo: ['Carcinosi peritoneale da adenocarcinoma'],
  Tiroide: ['Carcinoma papillare della tiroide'], 'Testa-collo': ['Carcinoma squamocellulare della laringe']
};

const META = [
  ['Fegato', 'Multiple lesioni epatiche di verosimile natura secondaria, la maggiore di '],
  ['Polmone', 'Plurimi noduli polmonari bilaterali di natura secondaria, il maggiore di '],
  ['Osso', 'Lesioni osteolitiche vertebrali di verosimile natura secondaria, la maggiore di '],
  ['Surrene', 'Nodulo surrenalico di natura secondaria di '],
  ['Encefalo', 'Lesioni cerebrali captanti di natura secondaria, la maggiore di ']
];

const PATOLOGIE = ['ipertensione arteriosa', 'diabete mellito tipo 2', 'BPCO', 'fibrillazione atriale in TAO',
  'cardiopatia ischemica', 'insufficienza renale cronica', 'cirrosi epatica HCV', 'obesita\'',
  'pregresso ictus ischemico', 'scompenso cardiaco'];

const NOTE = ['Paziente accompagnato dai familiari', 'Esame eseguito in urgenza notturna',
  'Confronto con TC esterna portata dal paziente', 'Discusso con il chirurgo di guardia',
  'Paziente poco collaborante, artefatti da movimento', 'Avvisato l\'oncologo di riferimento',
  'Mdc non somministrato per insufficienza renale', 'Ricoverato in Medicina d\'Urgenza'];

/* ── Ritorni in PS dei pazienti oncologici ─────────────────────────
   Il paziente e' lo stesso, la prima diagnosi e' nota e il referto lo
   dice in anamnesi. Alcuni ritorni portano la malattia che avanza
   (onco "si" con metastasi), altri una complicanza senza lesioni nuove. */
const RITORNI = [
  { richieste: ['dispnea improvvisa', 'sospetta embolia polmonare'], esame: 'Angio-TC torace',
    referto: () => 'Difetti di riempimento endoluminali delle arterie polmonari segmentarie bilaterali, compatibili con embolia polmonare.' },
  { richieste: ['febbre in neutropenia', 'febbre in paziente in chemioterapia'], esame: 'TC torace',
    referto: () => 'Addensamento parenchimale del lobo inferiore ' + lato() + ', di verosimile natura flogistica.' },
  { richieste: ['edema del volto e del collo', 'turgore giugulare'], esame: 'TC torace con mdc',
    referto: () => 'Stenosi serrata della vena cava superiore da compressione estrinseca, con circoli collaterali.' },
  { richieste: ['vomito incoercibile', 'subocclusione intestinale'], esame: 'TC addome con mdc',
    referto: () => 'Distensione delle anse del tenue con livelli idroaerei, verosimilmente da briglia aderenziale.' },
  { richieste: ['dispnea', 'versamento pleurico'], esame: 'RX torace',
    referto: () => 'Versamento pleurico ' + lato() + ' di grado moderato.' }
];

const PROGRESSIONI = [
  { sede: 'Fegato', richieste: ['dolore in ipocondrio destro', 'rialzo delle transaminasi'], esame: 'TC addome con mdc',
    referto: (m) => 'Multiple lesioni epatiche di verosimile natura secondaria, la maggiore di ' + m + '.' },
  { sede: 'Osso', richieste: ['dolore dorsale ingravescente', 'deficit di forza agli arti inferiori',
    'sospetta compressione midollare'], esame: 'TC rachide senza mdc',
    referto: (m) => 'Lesione osteolitica del soma vertebrale D' + intero(6, 12) +
      ' di verosimile natura secondaria di ' + m + ', con invasione del canale vertebrale.' },
  { sede: 'Encefalo', richieste: ['crisi convulsiva', 'cefalea e vomito', 'stato confusionale'],
    esame: 'TC encefalo senza mdc',
    referto: (m) => 'Lesioni cerebrali di natura secondaria, la maggiore in sede ' + scegli(['frontale', 'parietale']) +
      ' ' + lata() + ' di ' + m + ' con edema perilesionale.' },
  { sede: 'Polmone', richieste: ['tosse persistente', 'dispnea ingravescente'], esame: 'TC torace con mdc',
    referto: (m) => 'Plurimi noduli polmonari bilaterali di natura secondaria, il maggiore di ' + m + '.' },
  { sede: 'Osso', richieste: ['caduta con dolore all\'anca', 'impotenza funzionale arto inferiore'],
    esame: 'TC distrettuale',
    referto: (m) => 'Frattura patologica del collo femorale ' + lato() + ' su lesione osteolitica di natura secondaria di ' + m + '.' },
  { sede: 'Peritoneo', richieste: ['distensione addominale', 'ascite'], esame: 'TC addome con mdc',
    referto: (m) => 'Carcinosi peritoneale con ascite, impianto omentale maggiore di ' + m + '.' }
];

/* ── Date ──────────────────────────────────────────────────────────
   Un giorno a caso dell'anno, con la stagione dello scenario. */
function giornoPer(scenario) {
  for (;;) {
    const g = intero(0, GIORNI - 1);
    const m = mese(g);
    const fattore = scenario.stagione && scenario.stagione.indexOf(m) !== -1 ? 1 : (scenario.stagione ? 0.55 : 1);
    if (caso() < fattore) return g;
  }
}
function ora(g) {
  // il PS lavora giorno e notte, con il picco nel pomeriggio
  const h = pesata([[intero(0, 6), 2], [intero(7, 12), 4], [intero(13, 19), 5], [intero(20, 23), 3]]);
  return INIZIO + g * 86400000 + h * 3600000 + intero(0, 59) * 60000;
}

function record(p, g, campi) {
  const t = ora(g);
  return Object.assign({
    cognome: p.cognome, nome: p.nome, sesso: p.maschio ? 'M' : 'F', dob: p.dob,
    prima_onco: '', data: isoGiorno(g), tipo_esame: '', richiesta: '', onco: '', diagnosi: '',
    sede: '', dim: '', primo_riscontro: false, sottocat: null, pat_assoc: '', metastasi: null,
    meta_sede: '', meta_primitivo: '', anat: '', note: caso() < 0.12 ? scegli(NOTE) : '',
    followup: [], createdAt: t, updatedAt: t
  }, campi);
}

function esameIniziale(p, scenario, g) {
  let sede = scegli(scenario.sedi);
  // niente prostata alle donne, niente ovaio e utero agli uomini
  if (sede === 'Prostata' && !p.maschio) sede = 'Vescica';
  if ((sede === 'Ovaio' || sede === 'Utero') && p.maschio) sede = 'Colon';
  if (sede === 'Mammella' && p.maschio) sede = 'Polmone';

  const dado = caso();
  const onco = dado < scenario.onco * 0.75 ? 'si' : dado < scenario.onco ? 'sospetto' : '';
  const tipo = pesata(scenario.esami);
  const richiesta = scegli(scenario.richieste);

  if (!onco) {
    const conosciuto = caso() < 0.3;   // paziente gia' oncologico, oggi senza reperti
    return { sede: null, rec: record(p, g, {
      prima_onco: conosciuto ? 'no' : (caso() < 0.6 ? 'ignoto' : ''),
      tipo_esame: tipo, richiesta: richiesta,
      diagnosi: caso() < 0.8 ? scegli(BENIGNI[scenario.benigni])() : ''
    }) };
  }

  const m = misura();
  const metastasi = onco === 'si' && caso() < 0.3 ? 'si' : 'no';
  let diagnosi = FRASI[sede](m), metaSede = '', metaPrim = '';
  if (metastasi === 'si') {
    const scelta = scegli(META.filter((x) => x[0] !== sede));
    metaSede = scelta[0];
    metaPrim = primitivoTesto(sede) || sede;
    diagnosi += ' ' + scelta[1] + intero(8, 30) + ' mm.';
  }
  const primo = caso() < 0.6;
  const sottocat = primo ? (caso() < 0.6 ? 'unica' : 'associata') : null;
  const prima = onco === 'si' ? (caso() < 0.75 ? 'si' : 'no') : (caso() < 0.5 ? 'si' : 'ignoto');

  // l'istologia arriva settimane dopo: nel campo di anatomia patologica
  // e nel follow-up, solo per i casi gia' chiusi prima della fine dell'anno
  const followup = [], esito = scegli(ESITI_ISTO[sede] || ['Neoplasia maligna']);
  let anat = '';
  const gBiopsia = g + intero(7, 30);
  if (onco === 'si' && caso() < 0.6 && gBiopsia < GIORNI) {
    anat = esito + '.';
    followup.push({ date: isoGiorno(gBiopsia), type: scegli(['Biopsia', 'Agobiopsia TC-guidata', 'Biopsia endoscopica',
      'Pezzo operatorio']), text: esito });
  } else if (onco === 'sospetto' && caso() < 0.4 && gBiopsia < GIORNI) {
    followup.push({ date: isoGiorno(gBiopsia), type: 'Biopsia', text: caso() < 0.5 ? esito : 'Negativa per malignita\'' });
  } else if (onco === 'si' && caso() < 0.5) {
    anat = 'Referto istologico in attesa';
  }

  return { sede: onco === 'si' && ISTOLOGIA[sede] ? sede : null, rec: record(p, g, {
    prima_onco: prima, tipo_esame: tipo, richiesta: richiesta, onco: onco, diagnosi: diagnosi,
    sede: sede, dim: m, primo_riscontro: primo, sottocat: sottocat,
    pat_assoc: sottocat === 'associata' ? [scegli(PATOLOGIE), scegli(PATOLOGIE)]
      .filter((v, i, a) => a.indexOf(v) === i).join(', ') : '',
    metastasi: metastasi, meta_sede: metaSede, meta_primitivo: metaPrim, anat: anat, followup: followup
  }) };
}

function ritorno(p, primaria, g) {
  if (caso() < 0.55) {
    const pr = scegli(PROGRESSIONI.filter((x) => x.sede !== primaria));
    const m = intero(10, 45) + ' mm';
    return record(p, g, {
      prima_onco: 'no', tipo_esame: pr.esame, richiesta: scegli(pr.richieste), onco: 'si',
      diagnosi: anamnesi(primaria) + ' ' + pr.referto(m), sede: pr.sede, dim: m,
      metastasi: 'si', meta_sede: pr.sede, meta_primitivo: primitivoTesto(primaria),
      anat: 'Progressione di malattia nota'
    });
  }
  const c = scegli(RITORNI);
  return record(p, g, {
    prima_onco: 'no', tipo_esame: c.esame, richiesta: scegli(c.richieste),
    diagnosi: anamnesi(primaria) + ' ' + c.referto()
  });
}

/* ── Generazione ──────────────────────────────────────────────────── */
const records = [];
while (records.length < QUANTI) {
  const scenario = pesata(SCENARI.map((s) => [s, s.peso]));
  const p = nuovoPaziente();
  const g = giornoPer(scenario);
  const iniziale = esameIniziale(p, scenario, g);
  records.push(iniziale.rec);

  // due pazienti oncologici su tre tornano in PS nei mesi successivi
  if (iniziale.sede && caso() < 0.67) {
    let gg = g;
    const volte = pesata([[1, 4], [2, 4], [3, 2]]);
    for (let k = 0; k < volte && records.length < QUANTI; k++) {
      gg += intero(18, 110);
      if (gg >= GIORNI) break;
      records.push(ritorno(p, iniziale.sede, gg));
    }
  }
}

records.sort((a, b) => a.createdAt - b.createdAt);
records.forEach((r, i) => {
  // l'id viene prima degli altri campi, come negli archivi veri
  records[i] = Object.assign({ id: 'seed-' + i }, r);
  // un esame su dieci e' stato ritoccato dopo (istologia, follow-up)
  if (r.followup.length) records[i].updatedAt = Date.parse(r.followup[r.followup.length - 1].date) + 11 * 3600000;
  else if (caso() < 0.1) records[i].updatedAt = r.createdAt + intero(1, 72) * 3600000;
});

fs.mkdirSync(path.dirname(FILE), { recursive: true });

const store = {
  schema: 2,
  savedAt: new Date(SALVATO).toISOString(),
  records: records,
  deleted: {},
  tipiEsame: { lista: TIPI, updatedAt: SALVATO }
};

fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n', 'utf8');

const conta = (f) => records.filter(f).length;
const pazienti = new Set(records.map((r) => r.cognome + '|' + r.nome + '|' + r.dob)).size;
console.log('Scritti ' + records.length + ' esami (' + pazienti + ' pazienti) in ' + FILE);
console.log('  periodo: ' + records[0].data + ' -> ' + records[records.length - 1].data);
console.log('  oncologici: ' + conta((r) => r.onco === 'si') + ' · sospetti: ' + conta((r) => r.onco === 'sospetto') +
  ' · metastasi: ' + conta((r) => r.metastasi === 'si') + ' · con istologia: ' + conta((r) => r.followup.length));
if (!DEMO) console.log('Avvia con:  npm run dev');
