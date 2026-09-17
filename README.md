# ER Oncology Archivist

Raccolta dati del Pronto Soccorso Oncologico — Radiologia d'Urgenza.
Applicazione desktop Electron, funzionante **completamente offline**, con
archivio condiviso su cartella di rete tra le due postazioni di reparto
(Sala Notte e Sala TC1).

Versione 2.0 — riscrittura dell'originale single-page da ~2.400 righe.
Il file di partenza è conservato in [`legacy/`](legacy/) come riferimento;
l'elenco dei problemi trovati e di come sono stati risolti è in
[`AUDIT.md`](AUDIT.md).

---

## Struttura

```
main.js                  processo principale Electron (finestra, IPC, I/O su file)
preload.js               bridge contextIsolato → window.psApi
src/index.html           markup (nessun gestore inline, CSP rigida)
src/styles.css           fogli di stile
src/app.js               logica applicativa
src/safety.html          finestra separata della safety net (backup e chiavetta USB)
src/safety.js            logica della safety net
src/safety.css           stile della safety net
src/xlsx.js              generatore .xlsx senza dipendenze (sostituisce SheetJS da CDN)
src/names.js             database di ~50.000 nomi europei per il rilevamento del sesso
build/                   risorse di build (icon.ico)
.github/workflows/       build automatica Windows
legacy/                  versione originale, solo consultazione
```

## Build

La pipeline esegue prima dei controlli automatici: sintassi JavaScript,
assenza di gestori di evento inline, assenza di risorse remote, presenza
delle impostazioni di sicurezza in `main.js`. Se uno fallisce non si compila.

### Build di prova

*Actions → Build Windows → Run workflow*. Al termine si scarica l'artifact
**`ER-Oncology-Archivist-Windows`** (serve essere loggati su GitHub).

Gli eseguibili pesano ~100 MB l'uno e lo spazio artifact incluso nel piano
è 500 MB, quindi l'artifact resta disponibile **un giorno**: scaricalo
subito o rilancia il workflow. I push ordinari su `main` compilano lo
stesso — così un errore si vede — ma conservano solo `SHA256SUMS.txt`.
Gli eseguibili di una release restano invece allegati alla release, senza
scadenza.

### Release scaricabile

Per pubblicare una versione che il reparto possa scaricare con un link
diretto, basta creare un tag `v<versione>`:

```bash
npm version 2.0.1 --no-git-tag-version   # allinea package.json
git commit -am "Versione 2.0.1"
git tag v2.0.1
git push origin main --tags
```

Il workflow compila e crea da solo la **Release** con allegati il portable,
l'installer e il file `SHA256SUMS.txt`. Gli allegati non pesano sul
repository e non hanno il limite dei 100 MB dei file versionati.

Il tag deve corrispondere alla `version` di `package.json`: se non
combaciano la pipeline si ferma, per non pubblicare una release `v2.1.0`
che contiene eseguibili `2.0.0`.

### Sviluppo in locale

**Non serve passare da GitHub per provare una modifica.** Electron è già
installato in `node_modules`: l'app parte in un paio di secondi.

```bash
npm install     # una volta sola
npm run seed    # riempie dev-data/ con 120 esami finti
npm run dev     # avvia con ricarica automatica
```

`npm run dev` fa tre cose in più rispetto a `npm start`:

* usa **`dev-data/`** come cartella dati, senza chiedere nulla — niente
  finestra di selezione ad ogni avvio, e la cartella vera resta intoccata
* **ricarica la finestra** ad ogni salvataggio dentro `src/`: si modifica
  un file, si guarda il risultato, senza riavviare
* apre i **DevTools** in una finestra separata

Modificando `main.js` o `preload.js` serve invece riavviare: girano nel
processo principale, la ricarica della finestra non li tocca. Il terminale
lo ricorda da solo.

`npm run seed -- 500` per un archivio più grande. I dati sono generati in
modo deterministico: rilanciandolo si ottengono gli stessi, così i
confronti fra una modifica e l'altra restano validi.

```bash
npm run check   # gli stessi controlli della pipeline, in un secondo
npm start       # avvio normale, come lo vedrà il reparto
npm run dist    # produce dist/ con portable e installer
```

`npm run check` verifica sintassi, assenza di gestori inline e risorse
remote, impostazioni di sicurezza, tag bilanciati, `data-act` senza
gestore, id inesistenti, caratteri di controllo e allineamento della
versione col lockfile. Conviene lanciarlo prima di ogni push: la
pipeline fa gli stessi controlli, ma ci mette minuti.

La modalità sviluppo è subordinata a `app.isPackaged`: nel `.exe`
distribuito non può attivarsi, nemmeno passando `--dev`.
`dev-data/` è escluso dal repository.

### Demo dimostrativa

`demo/ps_onco_data.json` contiene un archivio di **210 esami di pazienti
inventati** (nomi, date e diagnosi generati), per mostrare il tool con
archivio, statistiche e cronologia già popolati.

```
npm run demo
```

Copia l'archivio demo in `dev-data/` (salvando prima una copia di quello
che c'era) e avvia l'app su quella cartella, anche se sulla postazione è
configurata una cartella dati vera. Il file in `demo/` non viene mai
modificato: ogni demo riparte dagli stessi dati. `npm run check` verifica
che contenga solo esami generati.

### Icona

Copiare l'icona in `build/icon.ico` (ICO, almeno 256×256). electron-builder
la rileva da sola: **non** va aggiunta nessuna chiave `icon` in
`package.json`. Se il file manca, la build usa l'icona predefinita.

## Distribuzione

Gli eseguibili **non sono firmati**: al primo avvio Windows SmartScreen
mostra "Windows ha protetto il PC" e serve *Ulteriori informazioni →
Esegui comunque*. Funziona anche senza diritti di amministratore, ma
conviene avvisare il personale. Se l'IT dispone di un certificato di code
signing aziendale, si può configurare in `build.win` di `package.json`.

Per il reparto la strada più semplice è il **portable**: si copia sulla
share e si lancia da lì, senza installare nulla sui PC.

Il `SHA256SUMS.txt` allegato alla release serve a verificare il file
scaricato:

```powershell
Get-FileHash .\ER-Oncology-Archivist-2.0.0-portable.exe -Algorithm SHA256
```

## Intro

All'avvio parte una sequenza automatica, **senza nessun pulsante da
premere**. Un click o un tasto qualsiasi la salta subito.

1. Il logo SD si disegna e si riempie
2. Il titolo entra a fuoco lettera per lettera, da sinistra
3. Compare il sottotitolo
4. Il logo **vola in alto a sinistra** e diventa il marchio della barra di
   navigazione, mentre lo sfondo si dissolve
5. **Solo a volo concluso** le sezioni compaiono una dopo l'altra, a 90 ms
   di distanza — è l'`AnimatedList` di Magic UI: scala con origine in
   alto e molla. La stessa comparsa si ripete ad ogni cambio vista, ad
   ogni passo del wizard e all'apertura delle finestre modali.

Circa 3,3 secondi in tutto. Il volo del logo usa la tecnica FLIP: si
misura dove il logo si trova e dove deve atterrare, e si anima la sola
differenza con una `transform` — nessun ricalcolo di layout per frame.

**Quando parte.** Non al primo istante: prima il programma costruisce
tutta l'interfaccia e legge l'archivio, a scena ferma, e solo a filo
principale libero l'animazione comincia (al massimo si aspetta un secondo
e mezzo). Prima quel lavoro — il primo impaginamento dell'intera pagina,
duecento righe di tabella, i grafici — cadeva in mezzo all'atto I: su una
postazione lenta un fotogramma solo da quasi un secondo, proprio mentre
il logo si disegna. L'attesa a scena ferma non si vede, perché non c'è
ancora niente da guardare.

Durante tutta la sequenza si animano **solo `transform` e `opacity`**,
le due proprietà che il compositore muove senza rifare né il layout né
il disegno: anche la banda che risale alla fine sale spostandosi, non
ritagliandosi. A intro conclusa la scena viene tolta dalla pagina: i 51
tracciati del titolo non devono farsi riesaminare ad ogni ricalcolo di
stile per tutto il resto della giornata.

Le tecniche di animazione sono ispirate a
[animate-ui](https://github.com/imskyleen/animate-ui) (Elliot Sutton,
MIT + Commons Clause) — `components/logo.tsx`, `texts/splitting`,
`effects/effect`. **Nessun codice di quel progetto è stato copiato**: è
React + Framer Motion e qui non sarebbe utilizzabile (nessun bundler, CSP
`script-src 'self'`, tutto deve funzionare offline). Le tre animazioni
sono state riscritte da zero in CSS:

| animate-ui | qui |
|---|---|
| `logo.tsx` — `pathLength` 0→1 + `fillOpacity` | `pathLength="1"` + `stroke-dashoffset`, keyframes `splashDrawLogo` |
| `texts/splitting` — blur+fade sfalsato per carattere | keyframes `splashRevealGlyph` sui 51 path del titolo |
| `effects/effect` — fade + slide + zoom con molla | keyframes `splashMotionEffect`, molla approssimata con `cubic-bezier` |
| ritardi a cascata dell'hero (0,15 s l'uno) | attributo `data-pop` + `--pop-delay`, stessa animazione sui blocchi dell'interfaccia |

La sequenza rispetta `prefers-reduced-motion`, e con *Salta l'intro*
la scena non viene nemmeno animata.

## Dock delle viste

La barra centrale è il `Dock` di
[Magic UI](https://github.com/magicuidesign/magicui): pillola con bordo e
sfocatura, elementi che si ingrandiscono in base alla distanza dal
puntatore, con la scia sulle voci vicine. La molla (mass .1,
stiffness 150, damping 12) è integrata in JavaScript — una transizione
CSS non riproduce quella risposta.

Differenza voluta: loro interpolano la *larghezza* (40→60 px) su icone
quadrate, spingendo le vicine. Qui gli elementi portano anche
l'etichetta, e cambiarne la larghezza rimanderebbe a capo il testo ad
ogni fotogramma. Si scala con `transform`, origine in basso: crescono
verso l'alto come nel dock di macOS.

## Cambio vista

Le tre viste (Nuovo esame, Archivio, Statistiche) stanno affiancate su un
binario che scorre orizzontalmente, con un pannello luminoso che scivola
sotto la scheda attiva e la vista uscente che si sfoca — è il
comportamento dei `Tabs` di animate-ui, riscritto in CSS.

Una differenza voluta: animate-ui interpola anche l'altezza del
contenitore. Qui le viste vanno da ~900 px (wizard) a oltre 3000 px
(statistiche): interpolare quell'altezza costa un ricalcolo di layout per
fotogramma e visivamente è uno stiramento sgradevole. L'altezza si
assesta subito, scorre solo il binario.

## Impostazioni

Menù a tendina in alto a destra, con le voci che servono davvero su una
postazione di reparto:

| voce | effetto |
|---|---|
| Cambia cartella dati… | rifà la scelta della condivisione |
| Ricarica dall'archivio | rilegge il file, utile dopo modifiche dell'altra postazione |
| Safety net | apre la finestra del backup automatico e della copia su chiavetta |
| Tabella compatta | righe più fitte, più esami a schermo |
| Riduci le animazioni | spegne intro, scorrimenti e filtri: utile su PC lenti |
| Salta l'intro all'avvio | per chi apre il programma decine di volte al giorno |

Le preferenze stanno in `localStorage`, sotto la chiave `psonco-prefs`.
Sono scelte della postazione — nessun dato clinico: quelli vivono solo
nel file condiviso.

## Safety net — la copia di sicurezza

Si apre da *Impostazioni → Safety net* e vive in una **finestra a
parte**: la si tiene aperta accanto al programma mentre si sceglie la
cartella o si aspetta che Windows riconosca la chiavetta.

### Backup automatico ogni 15 giorni

Scelta una cartella, il programma ci salva da solo una copia integrale
dell'archivio **ogni 15 giorni**, e lo dice con un avviso di Windows.
Il file si chiama sempre `backup_ER_OA.json` e viene **sovrascritto**:
una copia sola, sempre l'ultima. È una scelta, non una semplificazione
— una cartella che accumula archivi datati, tutti con nomi e diagnosi
in chiaro, è un problema di riservatezza che cresce da solo.

| dove | cosa |
|---|---|
| cartella scelta | `backup_ER_OA.json`, riscritto ogni 15 giorni |
| radice della chiavetta | `backup_ER_OA.json`, riscritto ad ogni copia |

Dettagli che contano:

* il controllo gira ogni ora, perché il programma può restare aperto per
  giorni; se alla scadenza la cartella non è raggiungibile, la data non
  avanza e il tentativo si ripete al giro dopo;
* la cartella del backup non può essere quella dell'archivio: se la
  share sparisce, sparirebbero insieme originale e copia;
* quel che non è un archivio valido non diventa un backup: il contenuto
  viene verificato prima di scriverlo;
* la scrittura è atomica (file temporaneo + rinomina), quindi una copia
  interrotta non distrugge quella buona di quindici giorni prima;
* la cartella scelta e la data dell'ultimo backup stanno in `AppData`
  (`psonco-config.json`), insieme alla cartella dati: sono impostazioni
  della postazione.

### Copia su chiavetta USB

La finestra elenca da sola le unità rimovibili e si aggiorna mentre è
aperta: una chiavetta collegata dopo compare senza dover premere niente.
La copia chiede conferma, perché il file contiene dati sanitari in
chiaro.

Il renderer non vede mai un percorso: passa una lettera di unità, che il
processo principale accetta solo se corrisponde a un'unità rimovibile
rilevata in quel momento e scrivibile. La finestra della safety net, poi,
ha accesso ai soli canali che le servono — stato, scelta della cartella,
copia: `fs:writeText` e compagnia le sono chiusi, e un tentativo
risponde *mittente IPC non autorizzato*.

## Primo avvio su una postazione

Alla prima apertura l'app chiede la cartella dati. Selezionare la
condivisione di rete, ad esempio `\\SERVER\PSOnco`.
Il percorso viene ricordato in `AppData` (`psonco-config.json`) e non
viene più richiesto.

Nella cartella dati l'app crea due file:

| file | contenuto |
|---|---|
| `ps_onco_data.json` | l'archivio |
| `ps_onco.lock` | presenza dell'altra postazione (informativo) |

## Lavoro simultaneo dalle due postazioni

Ogni salvataggio esegue **rilettura → unione → scrittura → verifica**:

* i record vengono uniti per `id`, vince la modifica con `updatedAt` più recente;
* le cancellazioni lasciano un *tombstone* (conservato 6 mesi) così che
  l'altra postazione non le annulli riscrivendo il record;
* la scrittura è atomica (file temporaneo + rename): un cavo staccato a
  metà salvataggio non lascia un JSON troncato;
* ogni 20 secondi, e ad ogni ritorno del fuoco sulla finestra, l'archivio
  recupera le modifiche fatte dall'altra postazione.

Se il file dati risulta illeggibile o irraggiungibile, l'app entra in
**sola lettura** e non scrive nulla: è la protezione contro il caso in cui
un errore di rete transitorio faccia sovrascrivere l'archivio con un file
vuoto.

## Export

Dal pulsante **Esporta…** (archivio o statistiche). L'export usa sempre la
selezione corrente dell'archivio, filtri compresi.

* **Excel nominativo** — tutti i campi, contiene dati personali
* **Excel anonimo** — senza cognome, nome e data di nascita
* **CSV anonimo**
* **PDF** — report di presentazione con KPI e grafici del periodo scelto
  nelle statistiche

Excel e PDF sono generati in locale: nessuna libreria scaricata da
Internet, nessun dato che esce dalla macchina. Il file viene proposto in
una normale finestra "Salva con nome".

## Modalità browser

Aprendo `src/index.html` in Edge, l'app funziona ma **non salva nulla**:
è una sessione temporanea per prove e dimostrazioni. Per lavorare
sull'archivio serve l'eseguibile.

Questo è intenzionale: la versione precedente scriveva nomi, date di
nascita e diagnosi nel `localStorage` del browser, cioè in chiaro nel
profilo Edge di un PC condiviso.

## Sicurezza — in breve

* `contextIsolation`, `sandbox`, `nodeIntegration: false`
* la cartella dati vive **solo** nel processo principale; il renderer può
  nominare due soli file su allowlist, quindi il path traversal non è
  esprimibile
* CSP `script-src 'self'`, `connect-src 'none'`: nessuno script inline,
  nessuna connessione di rete possibile dalla pagina
* nessun dato del paziente viene mai concatenato in HTML senza escaping
* export XLSX/CSV neutralizzati contro la *formula injection*
* la finestra della safety net è una finestra a sé con gli stessi
  isolamenti, e ogni canale IPC dichiara da quale finestra può arrivare:
  quella di servizio non può scrivere sull'archivio

Dettaglio completo in [`AUDIT.md`](AUDIT.md).
