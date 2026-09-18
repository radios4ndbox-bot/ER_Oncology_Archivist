'use strict';

/* ══════════════════════════════════════════════════════════════════
   INTERPRETA — lettura di un referto copiato dal PACS

   Dal testo libero del referto ricava quello che il passo 3 chiede:
   sede della lesione, dimensioni, se c'è malattia metastatica, dove, e
   il tumore primitivo quando il referto lo dice.

   Non è un modello statistico: è un dizionario di parole chiave con
   poche regole esplicite, perché chi lo usa deve poter capire perché
   ha proposto una cosa e correggerlo. Le regole:

   · il referto si divide in frasi; ogni frase si normalizza (minuscole,
     niente accenti né punteggiatura) e si confronta con il dizionario,
     dalle espressioni più lunghe alle più corte: "flessura epatica" è
     colon, non fegato;
   · le negazioni valgono fino alla virgola o alla fine della frase:
     "non lesioni focali epatiche" non propone il fegato;
   · una sede conta solo se nella sua frase c'è una lesione vera (massa,
     formazione, lesione, neoplasia…) fuori da una negazione, e pesa di
     più se la lesione o la misura le sono vicine;
   · le frasi con segni di secondarietà (secondarie, metastasi,
     ripetitive, carcinosi…) danno le sedi delle metastasi;
   · le frasi di anamnesi (noto carcinoma, pregressa, esiti di…) danno
     il tumore primitivo noto, non la sede attuale;
   · la misura proposta è quella più vicina alla sede scelta, nella
     stessa frase: una misura presa altrove non si inventa.

   Il reparto può insegnare parole nuove (Apprendi, o Personalizzazione
   → Smart guess): arrivano qui come elenco "apprese" e hanno la
   precedenza sulle predefinite a parità di lunghezza.

   Nessun DOM, nessuno stato: la stessa funzione gira nel programma e
   nei test da riga di comando.
   ══════════════════════════════════════════════════════════════════ */

const Interpreta = (function () {

  // ── Sedi ────────────────────────────────────────────────────────
  // nome: come compare nel modulo e nelle statistiche (uguale ai valori
  // già in archivio); di: per comporre "Adenocarcinoma del colon".
  // Nei modelli, "parola*" vale per ogni parola che comincia così.
  const ORGANI = [
    { nome: 'Polmone', di: 'del polmone', modelli: ['polmon*', 'lobo superiore', 'lobo inferiore',
      'lobo medio', 'lingula*', 'bronch*', 'broncogen*', 'ilo polmonare', 'peribronc*', 'scissur*'] },
    { nome: 'Fegato', di: 'del fegato', modelli: ['fegato', 'epatic*', 'epatocarcinom*', 'hcc',
      'glissoniana', 'sottoglissoniana', 'segmento epatico'] },
    { nome: 'Pancreas', di: 'del pancreas', modelli: ['pancrea*', 'wirsung*', 'uncinato',
      'processo uncinato', 'testa pancreatica', 'coda pancreatica'] },
    { nome: 'Colon', di: 'del colon', modelli: ['colon', 'sigma', 'sigmoide*', 'sigmoidea', 'cieco', 'ciecal*',
      'colorettal*', 'flessura epatica', 'flessura splenica', 'valvola ileocecale', 'ileocecal*',
      'colon ascendente', 'colon discendente', 'colon trasverso'] },
    { nome: 'Retto', di: 'del retto', modelli: ['retto', 'rettal*', 'ampolla rettale', 'giunzione retto sigmoidea',
      'retto sigma'] },
    { nome: 'Stomaco', di: 'dello stomaco', modelli: ['stomaco', 'gastric*', 'gastrico', 'antro gastrico', 'antral*',
      'piloro', 'pilori*', 'cardias', 'fondo gastrico', 'grande curvatura', 'piccola curvatura'] },
    { nome: 'Esofago', di: 'dell’esofago', modelli: ['esofag*', 'giunzione esofago gastrica',
      'giunzione esofagogastrica'] },
    { nome: 'Rene', di: 'del rene', modelli: ['rene', 'reni', 'renal*', 'pielo*', 'parenchima renale'] },
    { nome: 'Surrene', di: 'del surrene', modelli: ['surren*', 'surrenal*'] },
    { nome: 'Vescica', di: 'della vescica', modelli: ['vescica', 'vescical*', 'uroteli*'] },
    { nome: 'Prostata', di: 'della prostata', modelli: ['prostat*'] },
    { nome: 'Mammella', di: 'della mammella', modelli: ['mammell*', 'mammari*', 'mammaria'] },
    { nome: 'Utero', di: 'dell’utero', modelli: ['uter*', 'endometri*', 'miometri*', 'cervice uterina',
      'collo dell utero'] },
    { nome: 'Ovaio', di: 'dell’ovaio', modelli: ['ovai*', 'ovari*', 'annessi*', 'annesso'] },
    { nome: 'Tiroide', di: 'della tiroide', modelli: ['tiroid*'] },
    { nome: 'Encefalo', di: 'dell’encefalo', modelli: ['encefal*', 'cerebral*', 'cerebr*', 'cervellett*', 'cerebell*',
      'emisfer*', 'lobo frontale', 'lobo temporale', 'lobo parietale', 'lobo occipitale',
      'sovratentorial*', 'sottotentorial*', 'intraassial*', 'gliom*', 'glioblastom*', 'meningiom*',
      'tronco encefalico', 'intracranic*', 'sede frontale', 'sede temporale', 'sede parietale',
      'sede occipitale', 'regione frontale', 'regione temporale', 'regione parietale',
      'regione occipitale', 'nuclei della base', 'capsula interna', 'corpo calloso', 'talam*'] },
    { nome: 'Osso', di: 'dell’osso', modelli: ['osso', 'ossa', 'osseo', 'ossea', 'ossei', 'ossee',
      'scheletr*', 'vertebr*', 'somatic*', 'osteo*', 'osteolitic*', 'osteoaddensant*', 'osteoblastic*',
      'costa', 'coste', 'costal*', 'sterno', 'sternal*', 'femor*', 'omer*', 'sacro', 'sacral*',
      'ala iliaca', 'ali iliache', 'acetabol*', 'mielom*'] },
    { nome: 'Linfonodi', di: 'linfonodale', modelli: ['linfonod*', 'linfoadeno*', 'adenopat*',
      'linfoadenopat*', 'linfom*'] },
    { nome: 'Mediastino', di: 'del mediastino', modelli: ['mediastin*', 'timo', 'timic*', 'timom*'] },
    { nome: 'Pleura', di: 'della pleura', modelli: ['pleur*', 'mesoteliom*'] },
    { nome: 'Peritoneo', di: 'del peritoneo', modelli: ['peritone*', 'carcinosi', 'omento', 'omental*',
      'omental cake'] },
    { nome: 'Milza', di: 'della milza', modelli: ['milza', 'splenic*'] },
    { nome: 'Vie biliari', di: 'delle vie biliari', modelli: ['vie biliari', 'via biliare', 'biliar*',
      'coledoc*', 'colangio*', 'klatskin', 'papilla di vater', 'ampollom*', 'ilo epatico'] },
    { nome: 'Colecisti', di: 'della colecisti', modelli: ['colecist*'] },
    { nome: 'Intestino tenue', di: 'dell’intestino tenue', modelli: ['tenue', 'ileal*', 'digiun*',
      'duoden*', 'ultima ansa ileale'] },
    { nome: 'Testicolo', di: 'del testicolo', modelli: ['testicol*'] },
    { nome: 'Testa-collo', di: 'del distretto testa-collo', modelli: ['laring*', 'faring*', 'rinofaring*',
      'orofaring*', 'ipofaring*', 'cavo orale', 'parotid*', 'sottomandibolar*'] },
    { nome: 'Parti molli', di: 'delle parti molli', modelli: ['parti molli', 'sottocut*', 'sarcom*'] }
  ];

  // Parole che cominciano come una sede ma non lo sono: senza questo
  // "colonna" sarebbe colon e "polmonite" una lesione del polmone.
  const FALSI_AMICI = new Set(['colonna', 'polmonite', 'broncopolmonite', 'pancreatite', 'colecistite',
    'pielonefrite', 'ostruzione', 'osservano', 'osserva', 'osservabile', 'epatomegalia',
    'splenomegalia', 'renella', 'uretere', 'ureteri', 'cerebrovascolare', 'bronchiectasie',
    'bronchiolite', 'tiroidite']);

  // ── Segnali ─────────────────────────────────────────────────────
  const LESIONE = ['lesion*', 'neoformazion*', 'formazion*', 'massa', 'masse', 'neoplas*', 'eteroplas*',
    'pacchett*', 'conglomerat*', 'linfoproliferativ*', 'adenomegal*', 'linfoadenomegal*',
    'aumentat* di volume', 'aumentat* di dimensioni', 'captant*', 'area ipodensa', 'effetto massa',
    'eteroformazion*', 'tumor*', 'tumefazion*', 'carcinom*', 'adenocarcinom*', 'linfom*', 'nodul*',
    'ispessiment*', 'infiltr*', 'ipodens*', 'iperdens*', 'ipercaptant*', 'sarcom*', 'melanom*',
    'mielom*', 'gliom*', 'glioblastom*', 'meningiom*', 'mesoteliom*', 'metastas*', 'secondari*',
    'ripetitiv*', 'carcinosi', 'k', 'ca', 'hcc', 'impianto', 'impianti', 'tessuto solido',
    'componente solida', 'vegetant*', 'stenosante', 'spiculat*', 'osteolitic*', 'osteoaddensant*'];

  const PRIMITIVO = ['primitiv*', 'eteroplas*', 'carcinom*', 'adenocarcinom*', 'k', 'ca', 'hcc',
    'massa', 'masse', 'neoformazion*', 'tumor*', 'neoplasia primitiva', 'sospett* per neoplas*',
    'sospett* per eteroplas*'];

  const METASTASI = ['metastas*', 'metastatic*', 'secondari*', 'secondarism*', 'ripetitiv*',
    'ripetitivit*', 'carcinosi', 'disseminat*', 'disseminazion*', 'mts', 'mt'];

  const NEGAZIONE = ['non', 'nessun*', 'assenza', 'assent*', 'senza', 'negativ*', 'esclus*', 'esclude',
    'escludono'];

  // "si nota una lesione" e' ovunque nei referti: "noto" vale solo
  // davanti a una diagnosi, come in "noto carcinoma del colon".
  const ANAMNESI = ['pregress*', 'esiti', 'anamnes*', 'storia', 'operat*', 'resezion*', 'intervento',
    'follow up', 'chemioterap*', 'radioterap*', 'in trattamento', 'gia trattat*', 'gia operat*',
    'not* neoplas*', 'not* carcinom*', 'not* adenocarcinom*', 'not* k', 'not* ca', 'not* tumor*',
    'not* linfom*', 'not* melanom*', 'not* sarcom*', 'not* mielom*', 'nota malattia', 'noto tumore',
    'in paziente con', 'paziente con not*'];

  const ISTOLOGIA = [
    ['adenocarcinom*', 'Adenocarcinoma'], ['epatocarcinom*', 'Epatocarcinoma'], ['hcc', 'Epatocarcinoma'],
    ['carcinom*', 'Carcinoma'], ['k', 'Carcinoma'], ['ca', 'Carcinoma'], ['linfom*', 'Linfoma'],
    ['melanom*', 'Melanoma'], ['sarcom*', 'Sarcoma'], ['mielom*', 'Mieloma'], ['mesoteliom*', 'Mesotelioma'],
    ['glioblastom*', 'Glioblastoma'], ['gliom*', 'Glioma'], ['neoplas*', 'Neoplasia'], ['tumor*', 'Tumore']
  ];

  // Parole di servizio dei referti: non si propongono da insegnare.
  const VUOTE = new Set((
    'a ad al alla alle allo agli ai all che chi con col coi da dal dalla dalle dallo dai dagli dei del ' +
    'della delle dello degli di e ed gli i il in la le lo nei nel nella nelle negli o od per su sul sulla ' +
    'sulle sui tra fra un una uno si ha ho sono piu meno anche come dove quale quali cui questo questa ' +
    'questi queste quello quella tale tali ogni altro altra altri altre poi gia ancora circa oltre verso ' +
    'osserva osservano apprezza apprezzano rileva rilevano evidenzia evidenziano segnala segnalano ' +
    'documenta documentano reperto reperti quadro compatibile compatibili verosimile verosimilmente ' +
    'natura dimensioni diametro massimo massima misura misurano misura presenza livello sede sedi ' +
    'regione regioni destra sinistra destro sinistro destri sinistre bilaterale bilateralmente esame ' +
    'eseguito eseguita studio mezzo contrasto mdc fase fasi contestuale contestualmente carico aspetto ' +
    'caratteri margini irregolari regolari struttura strutture densita valori norma normale normali ' +
    'nota noto note noti rispetto precedente precedenti controllo tc rx eco ecografia rm pz paziente ' +
    'area aree zona zone parte parti porzione tratto grado lieve lievi modesto modesta modesti ' +
    'marcato marcata multiple multipli plurime plurimi alcune alcuni numerose numerosi maggiore ' +
    'minore mm cm x ecc vedi cfr quesito clinico conclusioni conclusione referto indicazione ' +
    'infine inoltre altresi pertanto quindi mentre ovvero ossia nonche tipo seguito presente presenti ' +
    'visibile visibili evidente evidenti dubbio dubbia possibile possibili probabile probabilmente ' +
    'anche esame eseguita dopo prima durante endovena ev somministrazione solida solido solide solidi ' +
    'voluminosa voluminoso voluminose voluminosi effetto'
  ).split(' '));

  // ── Testo ───────────────────────────────────────────────────────
  function normalizza(testo) {
    return String(testo == null ? '' : testo)
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      // i decimali restano un'unica parola: "3,2 cm" -> "3d2 cm"
      .replace(/(\d)[.,](\d)/g, '$1d$2')
      // "4d5x3d8cm" -> "4d5 x 3d8 cm": misure scritte tutte attaccate
      .replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 x ')
      .replace(/(\d)(mm|cm)/g, '$1 $2')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Frasi del referto, con il testo originale per mostrarlo. */
  function frasi(testo) {
    const protetto = String(testo || '').replace(/(\d)\.(\d)/g, '$1․$2');
    return protetto
      .split(/[.;:\n\r]+/)
      .map((f) => f.replace(/․/g, '.').trim())
      .filter((f) => f.length > 1);
  }

  /** Un modello "lobo superiore" o "epatic*" come sequenza di pezzi. */
  function compila(modello) {
    return normalizza(String(modello).replace(/\*/g, ' STELLA ')).split(' ')
      .reduce((pezzi, t) => {
        if (t === 'stella') { if (pezzi.length) pezzi[pezzi.length - 1].prefisso = true; }
        else if (t) pezzi.push({ t: t, prefisso: false });
        return pezzi;
      }, []);
  }

  function combacia(pezzo, parola) {
    if (FALSI_AMICI.has(parola)) return false;
    return pezzo.prefisso ? parola.indexOf(pezzo.t) === 0 : parola === pezzo.t;
  }

  /** Una parola insegnata diventa un modello tollerante: "surrenalico"
   *  vale anche per surrenalica, surrenalici, surrenaliche. */
  function modelloAppreso(testo) {
    return normalizza(testo).split(' ').filter(Boolean).map((p) =>
      (p.length >= 5 && /[aeio]$/.test(p)) ? p.replace(/[aeio]+$/, '') + '*' : p).join(' ');
  }

  /** Tutti i modelli del dizionario, dal piu' lungo al piu' corto. */
  function dizionario(apprese) {
    const voci = [];
    const aggiungi = (modello, genere, valore, appreso) => {
      const pezzi = compila(modello);
      if (pezzi.length) voci.push({ pezzi: pezzi, genere: genere, valore: valore, appreso: !!appreso });
    };
    (apprese || []).forEach((a) => {
      if (!a || typeof a.testo !== 'string') return;
      if (a.tipo === 'sede' && a.valore) aggiungi(modelloAppreso(a.testo), 'sede', String(a.valore), true);
      if (a.tipo === 'metastasi') aggiungi(modelloAppreso(a.testo), 'metastasi', null, true);
    });
    ORGANI.forEach((o) => o.modelli.forEach((m) => aggiungi(m, 'sede', o.nome)));
    LESIONE.forEach((m) => aggiungi(m, 'lesione'));
    PRIMITIVO.forEach((m) => aggiungi(m, 'primitivo'));
    METASTASI.forEach((m) => aggiungi(m, 'metastasi'));
    NEGAZIONE.forEach((m) => aggiungi(m, 'negazione'));
    ANAMNESI.forEach((m) => aggiungi(m, 'anamnesi'));
    // piu' lunghi prima; a parita', quanto ha insegnato il reparto
    voci.sort((a, b) => (b.pezzi.length - a.pezzi.length) || (b.appreso - a.appreso));
    return voci;
  }

  /** Le corrispondenze di una frase. Una parola puo' essere insieme
   *  sede e segnale ("carcinomatosi" no, ma "linfoma" si': e' una
   *  lesione e dice dove): per questo ogni genere ha la sua copertura. */
  function trova(parole, voci) {
    const usate = {};
    const trovate = [];
    voci.forEach((v) => {
      const n = v.pezzi.length;
      const occupate = usate[v.genere] || (usate[v.genere] = parole.map(() => false));
      for (let i = 0; i + n <= parole.length; i++) {
        let ok = true;
        for (let j = 0; j < n; j++) {
          if (occupate[i + j] || !combacia(v.pezzi[j], parole[i + j])) { ok = false; break; }
        }
        if (!ok) continue;
        for (let j = 0; j < n; j++) occupate[i + j] = true;
        trovate.push({ genere: v.genere, valore: v.valore, da: i, a: i + n - 1, appreso: v.appreso });
      }
    });
    return trovate.sort((x, y) => x.da - y.da);
  }

  // ── Misure ──────────────────────────────────────────────────────
  const UNITA = { mm: 1, cm: 10, millimetri: 1, centimetri: 10 };
  const numero = (t) => (/^\d+(d\d+)?$/.test(t) ? parseFloat(t.replace('d', '.')) : null);

  /** "32 x 28 mm", "3,2 cm", "3 cm x 2 cm", "15mm": valori e posizione. */
  function misure(parole) {
    const out = [];
    for (let i = 0; i < parole.length; i++) {
      let t = parole[i];
      let incollata = t.match(/^(\d+(?:d\d+)?)(mm|cm)$/);
      if (numero(t) === null && !incollata) continue;
      // lo spessore di strato non e' una lesione
      if (i > 0 && /^(spessore|strato|strati|fov|collimazione)$/.test(parole[i - 1])) continue;
      const valori = [];
      let unita = null;
      let j = i;
      while (j < parole.length) {
        t = parole[j];
        incollata = t.match(/^(\d+(?:d\d+)?)(mm|cm)$/);
        if (incollata) { valori.push(parseFloat(incollata[1].replace('d', '.'))); unita = incollata[2]; j++; }
        else if (numero(t) !== null) {
          valori.push(numero(t)); j++;
          if (UNITA[parole[j]]) { unita = parole[j]; j++; }
        } else break;
        if ((parole[j] === 'x' || parole[j] === 'per') && j + 1 < parole.length &&
            (numero(parole[j + 1]) !== null || /^\d/.test(parole[j + 1]))) { j++; continue; }
        break;
      }
      if (unita && valori.length && valori.length <= 3) {
        const fattore = UNITA[unita];
        const breve = unita === 'millimetri' ? 'mm' : unita === 'centimetri' ? 'cm' : unita;
        out.push({
          da: i, a: j - 1,
          mm: Math.max.apply(null, valori) * fattore,
          testo: valori.map((v) => String(v).replace('.', ',')).join(' x ') + ' ' + breve
        });
      }
      i = j - 1;
    }
    return out.filter((m) => m.mm >= 1 && m.mm <= 400);
  }

  // ── Analisi ─────────────────────────────────────────────────────
  function breve(f) {
    const t = f.replace(/\s+/g, ' ').trim();
    return t.length > 110 ? t.slice(0, 107) + '…' : t;
  }

  function interpreta(testo, apprese) {
    const voci = dizionario(apprese);
    const elenco = frasi(testo);
    const organi = new Map();          // nome -> { punti, primo, meta, frase, misura }
    const primitiviNoti = [];
    const riconosciute = [];
    const coperte = new Set();         // parole gia' spiegate dal dizionario
    let inConclusioni = false;
    let segniMetastasi = null;
    const orfane = [];

    elenco.forEach((originale, nf) => {
      const parole = normalizza(originale).split(' ').filter(Boolean);
      if (!parole.length) return;
      if (parole[0] === 'conclusioni' || parole[0] === 'conclusione' ||
          (parole[0] === 'in' && parole[1] === 'conclusione')) inConclusioni = true;

      const trovate = trova(parole, voci);
      trovate.forEach((m) => { for (let k = m.da; k <= m.a; k++) coperte.add(parole[k]); });

      // Negazioni e anamnesi valgono dalla parola che le apre fino alla
      // prossima virgola: "noto carcinoma del colon, lesioni epatiche"
      // ha il primitivo prima della virgola e la lesione di oggi dopo.
      const virgole = [];
      normalizza(originale.replace(/,/g, ' QQVIRGOLA ')).split(' ').filter(Boolean)
        .reduce((pos, p) => { if (p === 'qqvirgola') virgole.push(pos); else pos++; return pos; }, 0);
      const portata = (genere, daInizio) => {
        const segno = parole.map(() => false);
        trovate.filter((m) => m.genere === genere).forEach((m) => {
          const fine = virgole.find((v) => v > m.a);
          for (let k = daInizio ? m.da : m.a + 1; k < (fine === undefined ? parole.length : fine); k++) segno[k] = true;
        });
        return segno;
      };
      const negata = portata('negazione', false);
      const storica = portata('anamnesi', true);
      const attuale = (m) => !negata[m.da] && !storica[m.da];

      const lesioni = trovate.filter((m) => m.genere === 'lesione' && attuale(m));
      const primitivo = trovate.some((m) => m.genere === 'primitivo' && attuale(m));
      const metastatica = trovate.find((m) => m.genere === 'metastasi' && attuale(m));
      const sedi = trovate.filter((m) => m.genere === 'sede' && attuale(m));
      const misureFrase = misure(parole).filter((m) => !storica[m.da] && !negata[m.da]);

      trovate.filter((m) => m.genere === 'sede' && !negata[m.da]).forEach((s) => {
        riconosciute.push({ parola: parole.slice(s.da, s.a + 1).join(' '), sede: s.valore, appreso: s.appreso });
      });
      // le sedi dentro l'anamnesi sono il primitivo noto, con la sua istologia
      trovate.filter((m) => m.genere === 'sede' && storica[m.da] && !negata[m.da]).forEach((s) => {
        const intorno = parole.filter((_p, k) => storica[k]);
        primitiviNoti.push({ sede: s.valore, istologia: istologia(intorno) });
      });
      if (!lesioni.length) return;

      if (metastatica && !segniMetastasi) segniMetastasi = breve(originale);
      // "area ipodensa di 25 mm" senza dire dove: la misura resta da parte,
      // e vale per la sede scelta solo se nelle sue frasi non ce n'e' una
      if (!sedi.length && misureFrase.length) {
        misureFrase.forEach((m) => orfane.push({ misura: m, frase: nf, meta: !!metastatica && !primitivo }));
      }

      sedi.forEach((s) => {
        const distanza = Math.min.apply(null, lesioni.map((l) => Math.abs(l.da - s.da)));
        let punti = distanza <= 6 ? 3 : distanza <= 12 ? 2 : 1;
        let misura = null;
        if (misureFrase.length) {
          misura = misureFrase.slice().sort((x, y) => Math.abs(x.da - s.da) - Math.abs(y.da - s.da))[0];
          punti += Math.abs(misura.da - s.da) <= 10 ? 2 : 1;
        }
        if (primitivo) punti += 2;
        if (inConclusioni) punti += 1.5;
        if (s.appreso) punti += 0.5;
        const meta = !!metastatica && !primitivo;
        const voce = organi.get(s.valore) || { nome: s.valore, punti: 0, primaFrase: nf, primaParola: s.da,
          meta: true, primario: 0, frase: '', misura: null, misuraPunti: -1 };
        voce.punti += punti;
        if (!meta) { voce.meta = false; voce.primario += punti; }
        if (!voce.frase || (!meta && voce.primario === punti)) voce.frase = breve(originale);
        if (misura && punti > voce.misuraPunti) { voce.misura = misura; voce.misuraPunti = punti; }
        organi.set(s.valore, voce);
      });
    });

    const tutti = Array.from(organi.values());
    const ordine = (a, b) => (b.punti - a.punti) || (a.primaFrase - b.primaFrase) || (a.primaParola - b.primaParola);
    const primari = tutti.filter((o) => !o.meta).sort((a, b) => (b.primario - a.primario) || ordine(a, b));
    const metastatiche = tutti.filter((o) => o.meta).sort(ordine);

    const principale = primari[0] || metastatiche[0] || null;
    if (principale && !principale.misura && orfane.length) {
      // la piu' vicina alla frase della sede, a parita' la piu' grande
      const adatte = orfane.filter((o) => o.meta === principale.meta);
      const scelta = (adatte.length ? adatte : orfane).slice().sort((a, b) =>
        (Math.abs(a.frase - principale.primaFrase) - Math.abs(b.frase - principale.primaFrase)) ||
        (b.misura.mm - a.misura.mm))[0];
      principale.misura = scelta.misura;
    }
    const notoPrimitivo = primitiviNoti.find((p) => !principale || p.sede !== principale.nome) ||
                          primitiviNoti[0] || null;

    let metastasi = null;
    if (metastatiche.length || segniMetastasi) metastasi = 'si';
    else if (primari.length) metastasi = 'no';

    const sediMeta = metastatiche.map((o) => o.nome);

    let primitivoTesto = '';
    if (metastasi === 'si') {
      if (notoPrimitivo) primitivoTesto = descriviPrimitivo(notoPrimitivo.sede, notoPrimitivo.istologia);
      else if (primari[0]) primitivoTesto = descriviPrimitivo(primari[0].nome, null);
    }

    const candidate = [];
    elenco.forEach((f) => normalizza(f).split(' ').forEach((p) => {
      if (p.length < 4 || VUOTE.has(p) || coperte.has(p) || /\d/.test(p) || candidate.indexOf(p) !== -1) return;
      candidate.push(p);
    }));

    let affidabilita = 'bassa';
    if (principale && principale.punti >= 6) affidabilita = 'alta';
    else if (principale && principale.punti >= 3.5) affidabilita = 'media';

    // Senza una sede riconosciuta la misura di una lesione vale comunque:
    // la sede la completa chi legge, o la insegna con Apprendi.
    let misuraSenzaSede = '';
    if (!principale && orfane.length) {
      misuraSenzaSede = orfane.slice().sort((a, b) => b.misura.mm - a.misura.mm)[0].misura.testo;
    }

    return {
      sede: principale ? principale.nome : '',
      dimensioni: principale && principale.misura ? principale.misura.testo : misuraSenzaSede,
      metastasi: metastasi,
      metaSede: sediMeta.join(', '),
      primitivo: primitivoTesto,
      evidenze: {
        sede: principale ? principale.frase : '',
        metastasi: segniMetastasi || ''
      },
      alternative: tutti.sort(ordine).map((o) => o.nome).filter((n) => !principale || n !== principale.nome),
      riconosciute: riconosciute,
      candidate: candidate.slice(0, 30),
      affidabilita: affidabilita
    };
  }

  function istologia(parole) {
    for (let i = 0; i < ISTOLOGIA.length; i++) {
      const pezzi = compila(ISTOLOGIA[i][0]);
      if (parole.some((p) => combacia(pezzi[0], p))) return ISTOLOGIA[i][1];
    }
    return null;
  }

  function descriviPrimitivo(sede, isto) {
    const o = ORGANI.find((x) => x.nome === sede);
    if (!isto) return sede;
    return isto + ' ' + (o ? o.di : '(' + sede + ')');
  }

  /** Le sedi conosciute, per i suggerimenti del modulo. */
  function nomiSedi() {
    return ORGANI.map((o) => o.nome);
  }

  /** Le parole predefinite di una sede, per mostrarle a chi configura. */
  function modelliDi(nome) {
    const o = ORGANI.find((x) => x.nome === nome);
    return o ? o.modelli.slice() : [];
  }

  return {
    interpreta: interpreta,
    normalizza: normalizza,
    modelloAppreso: modelloAppreso,
    nomiSedi: nomiSedi,
    modelliDi: modelliDi
  };
})();

// Nei test da riga di comando; nella pagina "module" non esiste.
if (typeof module !== 'undefined' && module.exports) module.exports = Interpreta;
