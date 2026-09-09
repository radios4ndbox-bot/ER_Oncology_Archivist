# Analisi della versione precedente

File esaminato: `legacy/ps_oncologia.original.html` (2.606 righe, 559 KB,
identico al gemello `er_oncology_archivist.html`).

Legenda gravità: **A** = blocca o distrugge dati · **B** = rischio concreto ·
**C** = difetto funzionale.

---

## A1 — Tutto lo stato globale mancava (il bug segnalato)

Il blocco `// STATE` era presente come commento ma **le dichiarazioni non
c'erano**. Nessuna delle 14 variabili era dichiarata da nessuna parte del
file:

```
currentStep  DB  saveTimer  editingId  fuItems  fuTargetId  filtered
selected  sortKey  sortDir  wOnco  wPrimo  wSottocat  wMetastasi
```

Verificato con una ricerca di `let|var|const <nome>` su tutto il file: zero
occorrenze per ciascuna.

Caricando il file originale in un browser, l'errore si presenta **subito
all'avvio**, non durante il cambio vista:

```
Uncaught ReferenceError: currentStep is not defined
    at ps_oncologia.html:2602
```

La riga 2602 è `buildProgress();`, la penultima istruzione del file. Il
lancio interrompe lo script, quindi la `checkServer()` della riga
successiva **non viene mai eseguita**: niente caricamento del file dati,
niente banner, niente lock. In reparto l'errore sembrava legato alla
transizione solo perché lo splash screen copre la pagina all'avvio e il
malfunzionamento diventa visibile appena si tocca qualcosa.

**Non era un problema di ordine dei blocchi**: spostare il JavaScript
dello splash più in basso non avrebbe cambiato nulla, perché le
dichiarazioni non esistevano in nessun punto del file.

*Correzione*: stato dichiarato esplicitamente in cima a `src/app.js`, file
in `'use strict'` così che una variabile dimenticata diventi subito un
errore invece di una globale silenziosa.

## A2 — `showLockBanner` / `hideLockBanner` non esistevano

Chiamate in `acquireLock()`, mai definite. La `ReferenceError` finiva nel
`catch` della funzione, il cui ramo di gestione **scriveva il lock
comunque**: il lock file non ha mai bloccato niente. Sintomo invisibile,
effetto reale sulla concorrenza.

## A3 — Perdita dati fra le due postazioni

`persistDB()` serializzava l'intero `DB` in memoria e lo scriveva sopra il
file. `DB` veniva caricato all'avvio e mai più riletto. Sequenza reale in
reparto:

1. Sala Notte apre il programma alle 8:00 → carica 300 record
2. Sala TC1 inserisce 12 esami durante la mattina
3. Sala Notte salva un esame alle 13:00 → riscrive il file con i suoi 301
   record: **i 12 esami di Sala TC1 spariscono**

Il lock file non proteggeva (vedi A2) e comunque non sarebbe bastato: era
un lock di presenza, non di scrittura, e `persistDB` non lo consultava.

*Correzione*: ad ogni salvataggio `rileggi → unisci → scrivi → rileggi e
verifica`, con unione per `id`, last-write-wins su `updatedAt` e tombstone
per le cancellazioni. Più recupero periodico delle modifiche remote.

## A4 — Un errore di rete azzerava l'archivio

```js
async function loadFromFile() {
  try { ... DB = JSON.parse(text); }
  catch(e) { DB = []; }        // ← condivisione non raggiungibile? archivio vuoto
  ...
}
```

Qualsiasi errore — share non montata, JSON corrotto, file bloccato —
produceva `DB = []`. Da lì in poi il primo salvataggio scriveva
`[]` sul file: **archivio clinico cancellato in silenzio**.

*Correzione*: errore di lettura o JSON non valido → l'app entra in sola
lettura, mostra un banner e **non scrive nulla** finché il problema non è
risolto.

## A5 — Scritture non atomiche

`writeJson` scriveva direttamente sul file di destinazione. Interruzione a
metà (rete SMB, PC spento) = `ps_onco_data.json` troncato e non più
leggibile, che sommato ad A4 significava perdita completa.

*Correzione*: scrittura su file temporaneo nella stessa cartella, poi
`rename`, con ripetizioni su `EBUSY`/`EPERM` tipici delle share.

---

## B1 — XSS con capacità di scrittura su disco

Ogni dato del paziente veniva concatenato in HTML senza escaping.
Punti verificati: `renderTable`, `openDetail`, `renderFUList`,
`updateSuggests`, `drawHeatmap`, le tabelle delle statistiche, `metaLabel`.

Esempio, `updateSuggests`, con l'unico escaping presente in tutto il file:

```js
`<button ... onclick="document.getElementById('w_sede').value='${s.replace(/'/g,"\\'")}'">`
```

Bastava una sede scritta come `x" onmouseover="…` per uscire dall'attributo.

Il punto è la portata: la pagina aveva accesso a `window.electronFS` con
`readJson` / `writeJson` / `deleteFile` **su cartella e nome file
arbitrari**, e caricava script da CDN senza CSP. Uno script iniettato
poteva leggere e scrivere ovunque il profilo `pviggiano` avesse permessi.

E l'iniezione non richiedeva accesso al PC: il file dati sta su una
condivisione scritta da due postazioni, quindi è **input non fidato**.

*Correzione*: `esc()` su ogni valore interpolato, verificato con payload
reali; nessun gestore inline nel markup (delega su `data-act`); CSP
`script-src 'self'` senza `unsafe-inline`; controllo in CI che nessun
`onclick=` rientri nel markup.

## B2 — Path traversal nel bridge Electron

Il renderer passava **cartella e nome file** a ogni chiamata:

```js
window.electronFS.readJson(dataFolder, 'ps_onco_data.json')
```

Con il main process che si fidava di entrambi, `../../..` o un percorso
assoluto erano sufficienti a leggere o scrivere qualunque file.

*Correzione*: la cartella dati è stato del solo processo principale (il
renderer non la comunica mai) e il nome file deve appartenere a una
allowlist di due elementi. Il traversal non è più esprimibile, non solo
"filtrato".

## B3 — Impostazioni Electron non irrobustite

Il `main.js` originale non è nel materiale fornito, ma l'HTML mostra un
`preload` che espone I/O su percorso libero: superficie compatibile con
`contextIsolation` non attivo o comunque con un bridge troppo largo.

*Correzione*, in `main.js`: `contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`, `webviewTag: false`, devtools solo in sviluppo,
`setWindowOpenHandler` → deny, `will-navigate` limitato ai file dell'app,
permessi del browser negati, istanza singola, verifica del mittente su
ogni handler IPC.

## B4 — Librerie da CDN in un ambiente offline

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
```

Tre problemi: dietro il proxy ospedaliero non carica (l'export Excel non
funziona); nessun `integrity`, quindi si esegue qualunque cosa arrivi da
quell'URL; SheetJS 0.18.5 è una versione con vulnerabilità note
(prototype pollution, ReDoS).

*Correzione*: `src/xlsx.js`, generatore XLSX scritto da zero (~250 righe:
ZIP *stored* + CRC32 + SpreadsheetML). Nessuna dipendenza, funziona
offline. Verificato: archivio ZIP valido, tutte le parti XML ben formate,
UTF-8 corretto, numeri come numeri.

## B5 — Formula injection negli export

`exportCSV` produceva celle non neutralizzate. Un campo che inizia con
`=`, `+`, `-`, `@` viene eseguito come formula all'apertura in Excel:
`=HYPERLINK(...)`, `=cmd|'/c …'!A1`. Su un referto scritto a mano non è
teorico.

*Correzione*: prefisso apostrofo sulle celle a rischio nel CSV; nell'XLSX
tutte le stringhe sono `inlineStr`, che Excel non valuta mai.

## B6 — Dati dei pazienti nel localStorage del browser

Il fallback non-Electron scriveva l'archivio completo — cognome, nome,
data di nascita, diagnosi — in `localStorage`, cioè in chiaro nel profilo
Edge di un PC di reparto condiviso, senza scadenza e senza che nessuno lo
sapesse.

*Correzione*: in modalità browser i dati restano solo in memoria e un
banner lo dichiara. Se serve la persistenza si usa l'eseguibile.

## B7 — Messaggi di errore grezzi

`notify('Errore salvataggio: ' + e.message)` esponeva percorsi assoluti e
dettagli del filesystem. Ora il processo principale traduce i codici
errno in messaggi utili al reparto ("Permessi insufficienti sulla cartella
dati", "File occupato da un altro PC").

---

## C1 — Metà del database dei nomi era irraggiungibile

```js
.replace(/[^a-zàáâãäåæçèéêëìíîïðñòóôõöùúûüýÿ ]/g, ' ')
```

La normalizzazione teneva solo Latin-1, ma il database contiene nomi
slavi, baltici e cechi: `žiga`, `živko`, `žydrūnas`, `želmíra`… Ogni `ž`,
`š`, `č`, `ū`, `ė` diventava uno spazio, quindi quei nomi non venivano
**mai** riconosciuti. Verificato dopo la correzione: `detectSesso('Žiga',
'Novak')` → `M` (prima: `U`).

*Correzione*: tokenizzazione su `\p{L}\p{M}` con flag Unicode.

## C2 — Il cognome poteva determinare il sesso

`detectSesso` univa nome e cognome e restituiva la prima corrispondenza,
in ordine di scansione. Cognomi italiani molto comuni sono anche nomi
propri: Alessandro, Emanuele, Simone, Nicola, Rosa, Costanza. "Rossi Rosa"
poteva risultare femmina per il cognome.

*Correzione*: si valuta prima il nome di battesimo; il cognome resta solo
come fallback per chi scrive tutto in un campo.

## C3 — Export dell'archivio intero quando il filtro non trova nulla

```js
const src = filtered.length ? filtered : DB;
```

Filtrando fino a zero risultati e premendo "Esporta anonimo" si otteneva
**tutto l'archivio**, non un file vuoto. Su un export nominativo è anche
un problema di riservatezza.

*Correzione*: si esporta sempre e solo la selezione corrente; se è vuota
l'app lo dice e non produce file.

## C4 — Altri difetti minori corretti

| | |
|---|---|
| `goStep(4)` non validava gli step 1 e 2 | si poteva salvare senza data esame passando da 1 → 4 |
| `calcAge` non controllava il range | date fuori scala davano età negative o superiori a 130 |
| `sortBy('eta')` usava `a.eta \|\| calcAge()` | l'età 0 diventava `calcAge(dob)`, ordinamento incoerente |
| `sortBy('primo_riscontro')` su booleani | confronto fra stringhe `"true"`/`""` |
| `selected` non veniva ripulito | id di record eliminati restavano selezionati |
| `#chkAll` non si riallineava | restava spuntato dopo un cambio filtro |
| `alert()` bloccanti nel wizard | sostituiti con le notifiche già presenti |
| `parseInt` senza radice | in `fmtMese`, `fmtMeseBreve` |

---

## Verifiche eseguite

Applicazione caricata e pilotata da browser; tutti i controlli passati.

| verifica | esito |
|---|---|
| Payload `<img src=x onerror=…>` in cognome, nome, sede, referto, note | reso come testo, 0 elementi iniettati, nessuna esecuzione |
| Flusso wizard 1→4 con salvataggio, follow-up e azzeramento | record corretto, sesso rilevato, età calcolata |
| Ordinamento, filtri, selezione multipla, modale dettaglio | corretti |
| Statistiche: KPI, donut, barre, mensile, heatmap, tabelle su 61 record | tutti resi |
| `.xlsx` generato → `zipfile.testzip()`, parsing XML di tutte le parti | ZIP valido, XML ben formato, UTF-8 e numeri corretti |
| `=SUM(A1:A9)` in export | CSV con apostrofo, XLSX come `inlineStr`, nessun `<f>` |
| Unione: record diversi dalle due postazioni | nessuna perdita |
| Unione: stesso record modificato da entrambe | vince il più recente, in entrambi gli ordini |
| Unione: cancellazione contro modifica | tombstone rispettato; modifica successiva prevale |
| Tombstone oltre la TTL | applicato prima della potatura (difetto trovato e corretto in corso di verifica) |
| Config o file dati con BOM UTF-8 | letto correttamente (difetto trovato e corretto in corso di verifica, vedi sotto) |
| Formato legacy (array puro) | letto e convertito |
| Record malformati dal file di rete | normalizzati, mai eseguiti |
| JSON corrotto | eccezione → sola lettura, nessuna scrittura |

### Verifiche sull'applicazione Electron compilata

Eseguite sul processo reale via DevTools Protocol, non in un browser.

| verifica | esito |
|---|---|
| `window.require` / `window.process` / `window.module` nel renderer | tutti `undefined`: contextIsolation e sandbox attivi |
| Superficie del bridge | esattamente 9 metodi, nessun canale extra |
| `psApi.readText('../../../Windows/win.ini')` | rifiutato: "Nome file non consentito" |
| `psApi.readText('C:/Windows/win.ini')` | rifiutato: "Nome file non consentito" |
| Stato globale nel renderer | `currentStep` numero, `DB` oggetto — il bug originale non si ripresenta |
| Errori JavaScript all'avvio | zero |
| Database nomi caricato | 19.153 maschili + 18.249 femminili |
| Ciclo salvataggio su cartella reale | file scritto, stato "salvato", nessun `.tmp` orfano |
| Seconda postazione simulata che scrive sul file | modifiche recuperate e unite, nessuna perdita |
| Cancellazione | tombstone scritto sul file, record rimosso da entrambe |

### Difetto introdotto e corretto: BOM UTF-8

Durante la verifica il file di configurazione scritto da PowerShell 5.1 non
veniva letto: `Out-File -Encoding utf8` in Windows PowerShell antepone un
BOM (`EF BB BF`) e `JSON.parse` lo rifiuta. L'app ripartiva chiedendo di
nuovo la cartella dati.

Lo stesso sarebbe successo al **file dati** se qualcuno dell'IT lo avesse
aperto e risalvato con Notepad o con uno script PowerShell: `parseStore`
avrebbe lanciato un'eccezione e l'app sarebbe entrata in sola lettura,
apparentemente senza motivo.

Corretto in `main.js` e `src/app.js` con uno `stripBom()` prima di ogni
`JSON.parse`. Verificato riscrivendo la configurazione **con** BOM: letta
correttamente.

## Cosa resta da decidere con il reparto

1. **Percorso UNC definitivo** della condivisione (`\\SERVER\PSOnco` è
   ancora un segnaposto) e permessi NTFS per i due account.
2. **Backup** della cartella dati: l'unione protegge dalle sovrascritture
   fra postazioni, non da una cancellazione della share. Serve una copia
   pianificata lato IT.
3. **Cifratura a riposo**: `ps_onco_data.json` contiene dati sanitari in
   chiaro. Se la share non è già su volume cifrato, va valutato con il
   DPO — è un requisito GDPR, non una scelta tecnica.
4. **Elenco degli accessi**: oggi chiunque possa aprire la cartella può
   leggere l'archivio. Va ristretto ai profili del reparto.
5. Bumpare Electron all'ultima stabile prima della distribuzione
   (`package.json` fissa `^35.0.0`): le patch di Chromium sono la parte
   che invecchia più in fretta.
