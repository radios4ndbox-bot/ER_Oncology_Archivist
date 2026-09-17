'use strict';

/* ══════════════════════════════════════════════════════════════════
   Safety net — finestra separata

   Due cose sole: la cartella dove il programma salva da solo la copia
   dell'archivio ogni quindici giorni, e la copia su chiavetta USB.
   Il file è sempre backup_ER_OA.json e viene sempre sovrascritto.

   Questa finestra non tocca l'archivio: dal processo principale le sono
   aperti i soli canali che le servono (stato, scelta della cartella,
   copia). Tutto ciò che arriva da fuori passa da esc() prima di
   diventare HTML.
   ══════════════════════════════════════════════════════════════════ */

const API = window.psApi || null;
const el = (id) => document.getElementById(id);

/** Nessun dato che arriva da fuori entra nell'HTML senza passare di qui:
 *  un'etichetta di volume la scrive chi ha formattato la chiavetta. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let stato = null;          // ultimo stato ricevuto dal processo principale
// null e non '': la firma di un elenco vuoto e' la stringa vuota, e al
// primo giro senza chiavette non si sarebbe disegnato nemmeno l'avviso
// di attesa.
let unitaViste = null;
let copiaInCorso = false;
let rispostaConferma = null;

// ══════════════════════════════════════════════════════════════════
//  Avvisi
// ══════════════════════════════════════════════════════════════════
let timerNotifica = null;
function avvisa(testo) {
  const n = el('notifica');
  if (!n) return;
  n.textContent = String(testo);
  n.classList.add('mostra');
  clearTimeout(timerNotifica);
  timerNotifica = setTimeout(() => n.classList.remove('mostra'), 3600);
}

// ══════════════════════════════════════════════════════════════════
//  Conferma — la finestra del sistema non c'entra niente con il tool
// ══════════════════════════════════════════════════════════════════
function conferma(opzioni) {
  const velo = el('velo');
  if (!velo) return Promise.resolve(false);
  el('confTitolo').textContent = opzioni.titolo || 'Conferma';
  el('confTesto').textContent = opzioni.testo || '';
  el('confDettaglio').textContent = opzioni.dettaglio || '';
  el('confSi').textContent = opzioni.conferma || 'Conferma';
  velo.classList.remove('in-chiusura');
  velo.classList.add('aperto');
  el('confSi').focus();
  return new Promise((risolvi) => { rispostaConferma = risolvi; });
}

function chiudiConferma(esito) {
  const velo = el('velo');
  if (!velo || !velo.classList.contains('aperto')) return;
  // l'uscita è animata: la classe si toglie a animazione finita
  velo.classList.add('in-chiusura');
  setTimeout(() => {
    velo.classList.remove('aperto', 'in-chiusura');
  }, 180);
  const risolvi = rispostaConferma;
  rispostaConferma = null;
  if (risolvi) risolvi(esito);
}

// ══════════════════════════════════════════════════════════════════
//  Stato del backup automatico
// ══════════════════════════════════════════════════════════════════
function dataOra(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const due = (n) => String(n).padStart(2, '0');
  return due(d.getDate()) + '/' + due(d.getMonth() + 1) + '/' + d.getFullYear() +
         ' alle ' + due(d.getHours()) + ':' + due(d.getMinutes());
}

/** "fra 12 giorni", "oggi", "in ritardo di 3 giorni": la data da sola
 *  non dice se il backup è in regola. */
function quandoManca(ms) {
  if (!ms) return '';
  const giorni = Math.round((ms - Date.now()) / 86400000);
  if (giorni > 1) return 'fra ' + giorni + ' giorni';
  if (giorni === 1) return 'domani';
  if (giorni === 0) return 'oggi';
  if (giorni === -1) return 'era ieri';
  return 'in ritardo di ' + Math.abs(giorni) + ' giorni';
}

function mostraStato(nuovo) {
  if (nuovo) stato = nuovo;
  if (!stato) return;

  const cartella = el('cartellaBackup');
  if (stato.cartellaBackup) {
    cartella.textContent = stato.cartellaBackup + '\\' + (stato.nomeFile || 'backup_ER_OA.json');
    cartella.classList.remove('vuoto');
  } else {
    cartella.textContent = 'nessuna cartella scelta';
    cartella.classList.add('vuoto');
  }

  el('btnDimentica').disabled = !stato.cartellaBackup;
  el('btnAdesso').disabled = !stato.cartellaBackup || !stato.cartellaDati;

  el('cartellaDati').textContent = stato.cartellaDati || 'cartella dati non configurata';

  const ultimo = dataOra(stato.ultimoBackup);
  el('ultimoBackup').textContent = ultimo || 'mai eseguito';

  const prossimo = dataOra(stato.prossimoBackup);
  const manca = quandoManca(stato.prossimoBackup);
  el('prossimoBackup').textContent = prossimo ? prossimo + ' (' + manca + ')'
                                              : 'al primo avvio utile';

  const pillola = el('statoAuto');
  pillola.classList.remove('ok', 'attesa', 'male');
  if (!stato.cartellaBackup) {
    pillola.textContent = 'non configurato';
    pillola.classList.add('attesa');
  } else if (!stato.ultimoBackup) {
    pillola.textContent = 'in attesa del primo backup';
    pillola.classList.add('attesa');
  } else if (stato.prossimoBackup && stato.prossimoBackup < Date.now()) {
    pillola.textContent = 'backup scaduto';
    pillola.classList.add('male');
  } else {
    pillola.textContent = 'attivo';
    pillola.classList.add('ok');
  }
}

async function aggiornaStato() {
  if (!API) return;
  try {
    mostraStato(await API.safetyStato());
  } catch (_) { /* finestra in chiusura */ }
}

// ══════════════════════════════════════════════════════════════════
//  Azioni sul backup automatico
// ══════════════════════════════════════════════════════════════════
async function scegliCartella() {
  if (!API) return;
  const esito = await API.safetyCartella();
  if (!esito || esito.stato === 'annullato') return;
  if (esito.stato === 'non-valida') {
    avvisa('Quella cartella non è scrivibile: scegline un’altra.');
    return;
  }
  if (esito.stato === 'stessa-cartella') {
    avvisa('Scegli una cartella diversa da quella dell’archivio: se la share sparisce, sparirebbero tutte e due.');
    return;
  }
  mostraStato(esito.safety);
  avvisa('Cartella impostata. La prima copia parte adesso.');
  backupAdesso(true);
}

async function dimenticaCartella() {
  if (!API) return;
  const ok = await conferma({
    titolo: 'Togliere la cartella del backup?',
    testo: 'Il programma smetterà di salvare la copia automatica ogni 15 giorni.',
    dettaglio: 'La copia già salvata resta dov’è: questo non cancella niente.',
    conferma: 'Togli'
  });
  if (!ok) return;
  mostraStato(await API.safetyDimentica());
  avvisa('Backup automatico disattivato.');
}

async function backupAdesso(silenzioso) {
  if (!API) return;
  const btn = el('btnAdesso');
  const testo = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Copia in corso…';
  try {
    const esito = await API.safetyBackupOra();
    if (esito && esito.stato === 'ok') {
      avvisa(esito.esami + ' esami copiati in ' + esito.percorso);
    } else if (!silenzioso || (esito && esito.stato !== 'senza-cartella-backup')) {
      avvisa(messaggioErrore(esito));
    }
  } catch (e) {
    avvisa('Copia non riuscita: ' + e.message);
  } finally {
    btn.textContent = testo;
    await aggiornaStato();
  }
}

function messaggioErrore(esito) {
  const s = esito && esito.stato;
  if (s === 'senza-cartella') return 'Cartella dati non configurata: apri il programma e scegli la cartella condivisa.';
  if (s === 'senza-cartella-backup') return 'Scegli prima dove salvare la copia.';
  if (s === 'senza-archivio') return 'Nella cartella dati non c’è ancora un archivio da copiare.';
  if (s === 'cartella-non-valida') return 'La cartella del backup non è più raggiungibile.';
  if (s === 'nessuna-unita') return 'La chiavetta non è più collegata: reinseriscila e riprova.';
  return (esito && esito.messaggio) || 'Operazione non riuscita.';
}

// ══════════════════════════════════════════════════════════════════
//  Chiavette USB
//
//  L'elenco si aggiorna da solo: una chiavetta collegata a finestra
//  aperta deve comparire senza che nessuno prema niente. Si ridisegna
//  solo quando l'elenco cambia davvero, altrimenti l'animazione di
//  entrata ripartirebbe ogni pochi secondi.
// ══════════════════════════════════════════════════════════════════
const RITMO_USB = 2500;

function mostraUnita(unita) {
  const lista = el('unita');
  const pillola = el('statoUsb');
  if (!lista) return;

  const firma = unita.map((u) => u.lettera + '|' + u.etichetta + '|' + u.spazioLibero).join(';');
  if (firma === unitaViste) return;
  unitaViste = firma;

  pillola.classList.remove('ok', 'attesa');
  if (!unita.length) {
    lista.innerHTML = '<li class="vuoto-elenco"><span class="puntini">In attesa di una chiavetta</span></li>';
    pillola.textContent = 'nessuna chiavetta';
    return;
  }

  pillola.textContent = unita.length === 1 ? '1 chiavetta collegata'
                                           : unita.length + ' chiavette collegate';
  pillola.classList.add('ok');
  lista.innerHTML = unita.map((u, i) =>
    '<li style="animation-delay:' + (i * 60) + 'ms">' +
      '<span class="lettera">' + esc(u.lettera) + '</span>' +
      '<span class="nome"><span>' + esc(u.etichetta) + '</span>' +
      '<small>' + esc(spazio(u.spazioLibero)) + ' liberi</small></span>' +
      '<button type="button" class="btn primario" data-act="copia" data-lettera="' + esc(u.lettera) + '">' +
      'Copia qui</button>' +
    '</li>').join('');
}

function spazio(byte) {
  const n = Number(byte) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(1).replace('.', ',') + ' GB';
  if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

async function cercaUnita() {
  if (!API || document.visibilityState === 'hidden') return;
  try {
    mostraUnita(await API.unitaRimovibili() || []);
  } catch (_) { /* finestra in chiusura */ }
}

async function copiaSuUnita(lettera) {
  if (!API || copiaInCorso) return;
  const ok = await conferma({
    titolo: 'Copiare l’archivio su ' + lettera + '?',
    testo: 'Il file contiene dati sanitari in chiaro: nomi, date di nascita e diagnosi.',
    dettaglio: 'Se sulla chiavetta c’è già un backup_ER_OA.json, viene sostituito.',
    conferma: 'Copia'
  });
  if (!ok) return;

  copiaInCorso = true;
  avvisa('Copia su ' + lettera + ' in corso…');
  try {
    const esito = await API.safetyNet(lettera);
    if (esito && esito.stato === 'ok') {
      avvisa(esito.esami + ' esami copiati in ' + esito.percorso);
    } else {
      avvisa(messaggioErrore(esito));
    }
  } catch (e) {
    avvisa('Copia non riuscita: ' + e.message);
  } finally {
    copiaInCorso = false;
  }
}

// ══════════════════════════════════════════════════════════════════
//  Eventi — nessun gestore scritto nell'HTML
// ══════════════════════════════════════════════════════════════════
const AZIONI = {
  chiudi: () => { if (API) API.safetyChiudi(); else window.close(); },
  scegli: scegliCartella,
  dimentica: dimenticaCartella,
  adesso: () => backupAdesso(false),
  copia: (bottone) => copiaSuUnita(bottone.getAttribute('data-lettera')),
  'conferma-si': () => chiudiConferma(true),
  'conferma-no': () => chiudiConferma(false)
};

function avvia() {
  document.addEventListener('click', (ev) => {
    const bersaglio = ev.target.closest('[data-act]');
    if (!bersaglio) return;
    const azione = AZIONI[bersaglio.getAttribute('data-act')];
    if (azione) azione(bersaglio);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (el('velo').classList.contains('aperto')) { chiudiConferma(false); return; }
    AZIONI.chiudi();
  });

  // le schede entrano una dopo l'altra, come le sezioni del programma
  el('sezUsb').style.setProperty('--ritardo', '90ms');

  if (!API) {
    avvisa('Questa finestra funziona solo dentro l’applicazione.');
    return;
  }

  API.onBackup((messaggio) => {
    if (!messaggio) return;
    if (messaggio.tipo === 'fatto') avvisa('Backup automatico eseguito: ' + messaggio.esami + ' esami.');
    if (messaggio.tipo === 'fallito') avvisa('Backup automatico non riuscito. ' + (messaggio.messaggio || ''));
    if (messaggio.tipo === 'da-configurare') avvisa('Sono passati 15 giorni: scegli dove salvare la copia.');
    aggiornaStato();
  });

  aggiornaStato();
  cercaUnita();
  setInterval(cercaUnita, RITMO_USB);
  // tornando sulla finestra, l'elenco è già aggiornato quando la si guarda
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { cercaUnita(); aggiornaStato(); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', avvia);
} else {
  avvia();
}
