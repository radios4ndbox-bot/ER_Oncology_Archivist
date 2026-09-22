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


---

# Revisione del 15 settembre 2026 — sicurezza e bug

Rilettura riga per riga di `main.js`, `preload.js`, `src/app.js`,
`src/zip.js`, `src/xlsx.js`, `src/index.html` (CSP, script, link),
`scripts/`, `package.json` e del workflow di build. `src/pptx.js` è stato
controllato per le interpolazioni non protette; `styles.css` e `names.js`
non contengono logica e non sono stati rivisti riga per riga.

## Sicurezza — corretti

| # | gravità | problema | correzione |
|---|---|---|---|
| S1 | media | `fs:deleteFile` accettava anche `ps_onco_data.json`: un difetto o una compromissione del renderer poteva cancellare l'archivio di entrambe le postazioni | il renderer può cancellare solo il lock |
| S2 | media | `fs:writeText` scriveva sull'archivio qualunque testo: un contenuto vuoto o troncato azzerava tutti gli esami | il processo principale rifiuta un archivio che non sia JSON con `records`; il lock ha un tetto di 4 KB |
| S3 | bassa | `will-navigate` confrontava il percorso per prefisso senza separatore (`src-altro` passava) e decodificava l'URL a mano | `url.fileURLToPath`, separatore finale, confronto senza maiuscole su Windows |
| S4 | bassa | `setWindowOpenHandler` apriva nel browser qualsiasi link http(s) | tutto negato: l'app non ha link esterni; aggiunto anche `setPermissionCheckHandler` |
| S5 | media | il job di build aveva `contents: write` mentre `npm ci` esegue gli script delle dipendenze | build in sola lettura; pubblicazione in un job separato che scarica solo gli eseguibili |
| S6 | bassa | chiavi `__proto__` nel file condiviso (in `note` e `deleted`) potevano alterare il prototipo degli oggetti in memoria | oggetti senza prototipo e solo le chiavi delle descrizioni esistenti |

Nessuna XSS trovata: ogni inserimento in `innerHTML` passa da `esc()`, i
testi dei messaggi usano `textContent`, `script-src 'self'` resta rigido.
Il path traversal resta strutturalmente impossibile (allowlist dei nomi).

## Sicurezza — da decidere con il reparto (non modificato)

- ~~**Electron 35 è uscito dal periodo di supporto.**~~ Risolto il
  16/09/2026: aggiornati Electron a 44.4.0 ed electron-builder a 26.15.3
  (`npm audit`: 0 vulnerabilità, prima 14 fra cui una critica in `tar`).
  Riprovati nell'app aggiornata stampa PDF, export PowerPoint, finestre di
  dialogo, chiusura con modifiche non salvate; build locale di installer e
  portable riuscita.
- **`asar: false` e portable su cartella scrivibile.** Chi può scrivere
  nella cartella dell'eseguibile può modificare `app.js` e agire su
  entrambe le postazioni. L'eseguibile va tenuto in una cartella di sola
  lettura per gli utenti.
- **Archivio in chiaro sulla condivisione.** La protezione dipende solo dai
  permessi della cartella. Da valutare con il referente privacy.
- **L'export "anonimo" è pseudonimizzato.** Toglie nome, cognome e data di
  nascita, ma restano i testi liberi (diagnosi, referti, note), la data
  dell'esame e l'età: prima di condividerlo fuori va controllato.
- **Orologi delle postazioni.** L'unione dei dati vince sul timestamp
  locale: un orologio sfasato può far prevalere la modifica più vecchia.
  Le due postazioni devono restare sincronizzate con il dominio.

## Bug — corretti

| # | gravità | problema | correzione |
|---|---|---|---|
| B1 | alta | un esame salvato mentre un salvataggio era in corso spariva: `doPersist` sostituiva la memoria con lo stato letto prima della scrittura, e il salvataggio successivo non lo trovava più | la memoria si riunisce con lo stato scritto invece di essere sostituita |
| B2 | alta | chiudendo la finestra entro 400 ms dal salvataggio di un esame (o durante la scrittura) le modifiche restavano solo in memoria | alla chiusura il processo principale aspetta il renderer; se il salvataggio non riesce chiede se chiudere comunque |
| B3 | media | cambiando cartella con un salvataggio in attesa, gli esami del vecchio archivio finivano nel nuovo | i salvataggi si completano prima del cambio; con una cartella diversa la memoria riparte vuota |
| B4 | media | il ripiego della scrittura atomica scriveva direttamente sul file anche per errori non transitori e, se falliva, cancellava il temporaneo con l'unica copia integra | ripiego solo per errori transitori; in caso di errore il temporaneo resta sul disco |
| B5 | media | i pulsanti sposta su, sposta giù ed elimina dei tipi di esame non facevano nulla (`tipo-su` contro il gestore `tipi-su`) | nomi allineati; `npm run check` ora controlla anche le azioni generate dal JavaScript |
| B6 | media | "Ricarica" scartava le modifiche non ancora scritte, per esempio quelle inserite in sola lettura | per la stessa cartella il file si unisce alla memoria, e le differenze si salvano |
| B7 | bassa | un record senza id (file modificato a mano) riceveva un id casuale a ogni lettura e si duplicava al primo salvataggio | id stabile ricavato da contenuto e posizione |
| B8 | bassa | tipi di esame e descrizioni cambiati sull'altra postazione non arrivavano finché non cambiava un esame | l'impronta dello stato include cancellazioni, tipi e descrizioni |
| B9 | bassa | date impossibili nel file (31/02) venivano accettate e spostate al mese dopo | scartate |
| B10 | bassa | `COLORE_FINESTRA` era dichiarata dopo la funzione che la usa (funzionava solo per l'ordine di avvio) | spostata fra le costanti |

## Verifiche eseguite

Nell'applicazione Electron in modalità sviluppo, via DevTools Protocol:

- date: `2026-02-31` scartata, `2024-02-29` accettata;
- id stabile: lo stesso record senza id letto due volte ha lo stesso id;
- tipi di esame: "sposta giù" scambia davvero le prime due voci;
- processo principale: rifiutati cancellazione dell'archivio, archivio
  vuoto, archivio senza `records`, lock di 5 KB, nome file con percorso;
- salvataggio concorrente: 11 esami inseriti durante salvataggi in corso,
  nessuno perso in memoria, tutti e 11 sul file;
- chiusura come con la X (`BrowserWindow.close()` dal processo principale)
  con un salvataggio ancora in attesa: esame scritto sul file e lock
  rimosso prima della chiusura.

Build locale dell'installer NSIS: icona dell'eseguibile, intestazione
scura con il logo e testo bianco nella pagina delle opzioni.

## Icona e installer

`build/icon.ico` è il logo ER OA · Desio ritagliato sul bordo del disco
(cerchio stimato sui pixel del bordo, scarto mediano 1,5 px) con fondo
trasparente, in 9 dimensioni da 16 a 256 px. Le immagini dell'installer
(`installerSidebar.bmp`, `installerHeader.bmp`) e `build/installer.nsh`
riprendono i colori del tool: radiale scuro dello splash e filo
rosso-viola.

---

# Revisione del 18 settembre 2026 — fluidità e safety net

## Fluidità: dove finivano i fotogrammi

Misurato nel renderer con gli intervalli fra fotogrammi, il profilo CPU e
la traccia del motore, a velocità normale e con la CPU rallentata quattro
e otto volte (la postazione del PS non è la macchina di sviluppo). Il
tempo non era nel JavaScript dell'applicazione — poche decine di
millisecondi in tutto — ma in stile, impaginazione e disegno.

| | difetto | correzione | misura |
|---|---|---|---|
| F1 | l'interfaccia si costruiva mentre l'intro era già partita | l'intro parte a costruzione finita, a scena ferma | atto I: fotogramma peggiore da 931 ms a 28 ms (CPU ×8) |
| F2 | `--salita` finiva sulla vista che contiene tutta l'applicazione, `--pop-delay` sulle sezioni: variabili ereditate, quindi ricalcolo di stile su tutto il sottoalbero | registrate con `@property … inherits: false` | ricalcolo da 242 ms sparito dal fotogramma della risalita |
| F3 | la banda del velo saliva con `clip-path`, ridisegnando l'intera finestra ad ogni fotogramma | sale con una trasformazione | fase finale: da 7 fotogrammi oltre 25 ms a 4 |
| F4 | le viste non attive erano sfocate con `filter: blur(4px)`, e la sfocatura era in transizione ad ogni cambio vista, su due viste insieme | trasparenza al posto della sfocatura | cambio vista: da 102 a 121 fotogrammi consegnati (CPU ×4) |
| F5 | classi su `<body>` (`intro-in-corso`, `pagina-sale`, `rail-aperto`) con regole discendenti: il motore passava in rassegna tutti i nodi | classi sui contenitori che le usano | — |
| F6 | cambiando vista si ridisegnavano tabella e grafici identici a prima | firma di dati, filtri e ordinamento: si ridisegna solo se è cambiato qualcosa | archivio: 271 ms → 67 ms di blocco |
| F7 | letture e scritture del layout alternate (grafici, FLIP del pannello, sezioni) | raggruppate: prima tutte le letture, poi tutte le scritture | otto impaginazioni forzate → una |
| F8 | i 51 tracciati del titolo restavano nel documento per sempre | la scena dell'intro si toglie dalla pagina quando ha finito | — |
| F9 | il volo del logo e la risalita della pagina erano in fila: prima il logo atterrava, poi la pagina saliva — due movimenti staccati | partono insieme, stessa durata e stessa curva: il logo si porta su la pagina | scarto fra gli arrivi misurato in 22 ms, progresso identico al decimo di punto percentuale ad ogni campione |
| F10 | `--t-salita`, la durata della risalita, finiva ereditata sulla vista che contiene tutta l'applicazione | registrata come non ereditata, come le altre | ricalcolo da 130 ms sparito dal fotogramma della partenza (CPU ×4) |

A velocità normale l'intro non perde più un fotogramma in nessuna delle
quattro fasi (media 7,1 ms, nessun compito lungo del filo principale) e
nessuna animazione dell'interfaccia supera i 25 ms. A CPU rallentata
quattro volte resta un solo fotogramma da 28 ms in tutta la sequenza.

## Safety net: backup automatico e chiavetta

Funzione nuova, in una finestra separata (`src/safety.html`).

* copia integrale dell'archivio ogni **15 giorni** nella cartella scelta
  dalla postazione, più un avviso di sistema; il file è sempre
  `backup_ER_OA.json` e viene sovrascritto;
* copia su chiavetta USB con lo stesso nome, nella radice dell'unità;
* l'elenco delle unità rimovibili si aggiorna da solo a finestra aperta.

Scelte di sicurezza:

| | scelta | perché |
|---|---|---|
| S1 | ogni canale IPC dichiara da quale finestra può arrivare | la finestra di servizio non deve poter scrivere sull'archivio: `fs:writeText` da lì risponde *mittente IPC non autorizzato* (verificato) |
| S2 | il renderer passa una lettera di unità, mai un percorso | la lettera vale solo se corrisponde a un'unità rimovibile rilevata in quel momento |
| S3 | un solo file di backup, sovrascritto | una cartella che accumula archivi datati con nomi e diagnosi in chiaro è un problema di riservatezza che cresce da solo |
| S4 | la cartella del backup non può essere quella dell'archivio | se la share sparisce, sparirebbero insieme originale e copia |
| S5 | il contenuto viene verificato prima di diventare backup | quel che non è un archivio non deve prendere il posto della copia buona |
| S6 | scrittura atomica anche per il backup | una copia interrotta non distrugge quella di quindici giorni prima |
| S7 | se la cartella non è raggiungibile la data non avanza | il tentativo si ripete al giro dopo invece di saltare quindici giorni |
| S8 | in sviluppo su `dev-data` la configurazione vera non si tocca (`psonco-config.dev.json`) | una prova non deve riscrivere la cartella dati della postazione |

Verifiche eseguite via DevTools Protocol sull'applicazione in esecuzione:
apertura della finestra dal programma; stato mostrato (cartella, ultimo
backup, prossimo previsto); backup su richiesta (210 esami, file scritto
e riletto); `fs:writeText` dalla finestra di servizio respinto; copia su
un'unità inesistente respinta; conferma sui dati sanitari prima della
copia; scadenza dei 15 giorni simulata con una data di 16 giorni fa — al
controllo successivo il backup è partito da solo e la data è avanzata.
La copia su una chiavetta fisica non è stata provata: qui non ce n'è una
collegata.

---

# Revisione del 18 settembre 2026 — Interpreta e cronologia verosimile

| | modifica | dettaglio |
|---|---|---|
| G1 | il menu *Tipo di esame* (passo 2) veniva tagliato | la scheda del passo aveva `overflow: hidden` e il binario delle viste lo aveva su entrambi gli assi: ora il binario taglia solo in orizzontale (`overflow-x: clip`) e il menu si apre verso l'alto quando sotto non c'è spazio nella finestra |
| G2 | la cronologia proponeva un esame per categoria (una colica renale finiva a Uro-TC) | esame tipico per singolo quesito, con statistiche d'archivio anche per quesito; 11 quesiti nuovi (embolia, dissezione, appendicite, diverticolite, pancreatite, colica biliare, ischemia mesenterica, politrauma, trauma cranico, polmonite, compressione midollare) |
| G3 | archivio demo con coppie richiesta/esame casuali ("dispnea → Ecografia collo") | rigenerato con scenari del PS verosimili e diagnosi scritte come referti |
| G4 | *Interpreta* (nuovo) | `src/interpreta.js`, senza DOM; nessuna scrittura nel modulo senza conferma; le parole insegnate passano dalla stessa normalizzazione del file condiviso (solo `sede`/`metastasi`, testi brevi, al massimo 300) |

Sicurezza: tutto ciò che Interpreta mostra — frasi del referto, parole
non riconosciute, parole insegnate — passa da `esc()` prima di diventare
HTML; le parole insegnate lette dal file condiviso sono validate come il
resto della personalizzazione.

---

# Revisione del 18 settembre 2026 — controllo completo dopo la 2.3.0

Riletto tutto il codice cambiato dalla 2.1.0 (circa 3.700 righe: intro,
safety net, Interpreta, cronologia, suggerimenti) cercando difetti e
falle; le prove sono state rifatte sull'applicazione in esecuzione.

| | gravità | difetto | correzione |
|---|---|---|---|
| R1 | media | la finestra della safety net chiedeva l'elenco delle chiavette ogni 2,5 s e ogni richiesta avviava PowerShell (mezzo secondo di CPU): su un PC lento le chiamate si sarebbero accavallate | PowerShell parte solo quando le lettere di unità cambiano o dopo un minuto, e mai due volte insieme; prima di scrivere su una chiavetta si rilegge sempre lo stato reale. Misurato: 6 richieste insieme in 2 ms |
| R2 | bassa | un errore imprevisto nel giro del backup automatico sarebbe diventato un rifiuto di promessa senza gestione nel processo principale | intercettato e registrato; il giro dopo riprova |
| R3 | bassa | scelta una voce dal menu dei suggerimenti, l'evento di input lo riapriva con le voci più lunghe ("Colon" → "Colon discendente") | l'input che segue una scelta non riapre il menu |

Sicurezza, verificato:

- dalla finestra della safety net `writeText`, `deleteFile`,
  `selectDataFolder` e `readText` rispondono *mittente IPC non
  autorizzato*;
- la copia su chiavetta rifiuta un percorso al posto della lettera
  (`C:\Windows`) e un disco fisso (`C:`);
- nessuna concatenazione HTML senza `esc()` nel codice nuovo (ricerca
  sulle righe aggiunte dalla 2.1.0); le parole insegnate lette dal file
  condiviso sono validate come il resto della personalizzazione;
- nessuna espressione regolare costruita da testo dell'utente;
- `npm audit`: 0 vulnerabilità;
- le tabelle della cronologia sono coerenti: ogni quesito ha una sola
  categoria, ogni esame proposto per un quesito esiste.

---

# 22 settembre 2026 — il file dell'archivio si chiama ER OA Archive

L'archivio creato dal programma passa da `ps_onco_data.json` a
**`ER OA Archive.json`**, e il file di presenza da `ps_onco.lock` a
`ER OA Archive.lock`.

La migrazione è automatica e non duplica niente: aprendo una cartella
che ha ancora il nome vecchio, il file viene **rinominato** (non
copiato), così non restano due archivi che poi divergono. Se il nome
nuovo esiste già, non si tocca niente; se la rinomina non riesce
(permessi, file aperto) si registra l'errore e si continua, senza
perdere nulla. Un lock con il nome vecchio più fermo di due minuti
viene tolto perché è solo un residuo.

Vale anche per la cartella scelta dopo, non solo per quella
configurata: la rinomina passa da `fs:selectDataFolder`.

Verificato sull'applicazione: cartella con i nomi vecchi → all'avvio il
file è rinominato, i 210 esami si leggono tutti, il lock nuovo viene
creato e un salvataggio scrive sul nome nuovo.

Attenzione in reparto: le due postazioni vanno aggiornate insieme. Una
versione precedente continuerebbe a leggere e scrivere sul nome vecchio,
e i due archivi divergerebbero.

---

# 22 settembre 2026 — animazioni in sincrono

| | difetto | correzione |
|---|---|---|
| A1 | i suggerimenti della richiesta del PS comparivano di scatto, e ad ogni lettera battuta il riquadro veniva riscritto | compare in dissolvenza e cambia con una dissolvenza breve; se il contenuto non cambia non viene nemmeno riscritto |
| A2 | nel toggle Metastasi di Smart guess il fondino bianco saltava da una voce all'altra, e i campi della metastasi comparivano e sparivano spostando il resto | il fondino è un cursore che scorre (stessa molla del resto del tool) e i due campi si aprono a scomparsa; il pannello non viene più ridisegnato ad ogni scelta |
| A3 | nel passo 3 la tinta rosa/ambra cambiava in 350 ms mentre la sezione si apriva in 500 ms, e i riquadri interni viravano ognuno per conto suo | colore e apertura hanno la stessa durata e la stessa curva, sezione, sottosezioni e toggle insieme |
| A4 | la spiegazione di un grafico si apriva con una curva e il testo entrava con un'altra; cambiando elemento il testo veniva sostituito di colpo mentre il riquadro cambiava altezza | stessa curva per riquadro e contenuto, e a riquadro già aperto il testo sfuma, cambia e rientra |
| A5 | la spiegazione era sempre rosa, qualunque elemento si fosse scelto | prende la tinta dell'elemento cliccato (spicchio, barra, cella) |

Verificato sull'applicazione: classi e durate a schermo, cursore che si
sposta da 3 px a 40 px con la sua transizione, tinta della spiegazione
che passa dal viola delle diagnosi all'ambra dei sospetti, nessuna
eccezione in console.

---

# 22 settembre 2026 — la richiesta del PS diventa un autofill

| | modifica |
|---|---|
| L1 | pulsante **Ricorda** sotto la richiesta del PS: mette la frase scritta in una libreria condivisa (fino a 400 voci, nel file dell'archivio come il resto della personalizzazione). Le voci in libreria compaiono nella cronologia con la stella e riempiono il campo con un clic |
| L2 | **doppioni**: due ricordate che cambiano solo per maiuscole, punteggiatura, o che hanno il 70% delle parole in comune, vengono segnalate — al salvataggio e aprendo *Categorie delle richieste*, con il motivo scritto accanto e il pulsante per toglierle |
| L3 | **niente piu' «Imposta TC…»**: la richiesta non detta il tipo di esame. La riga resta informativa (categoria, esame tipico, cosa dice l'archivio) e non agisce piu' sul modulo; la funzione che impostava il tipo di esame e' stata tolta |
| L4 | la cronologia si aggiorna **ad ogni modifica del testo**: prima aspettava un decimo di secondo e, fra una battuta e l'altra, restava a schermo il suggerimento precedente |
| L5 | le ricordate che nessuna parola chiave riconosce finivano fuori da tutte le categorie: ora hanno il loro blocco in fondo all'elenco |

Verificato sull'applicazione: salvataggio e doppio salvataggio, voce
ricordata che ricompare con la stella e riempie il campo, riconoscimento
di un duplicato di sole maiuscole e di uno che cambia una parola,
avviso in sezione e notifica all'apertura, rimozione dalla libreria.

