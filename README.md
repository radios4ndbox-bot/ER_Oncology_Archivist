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

Push su `main` (o *Actions → Build Windows → Run workflow*). Al termine si
scarica l'artifact **`ER-Oncology-Archivist-Windows`**, che resta
disponibile 30 giorni e richiede di essere loggati su GitHub.

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

### In locale (dove npm funziona)

```bash
npm install
npm start                                    # avvia l'app
npx electron-builder --win portable nsis     # produce dist/
```

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
   navigazione; contemporaneamente lo sfondo si dissolve e l'interfaccia
   entra a cascata (nav, wizard, footer)

Circa 3,3 secondi in tutto. Il volo del logo usa la tecnica FLIP: si
misura dove il logo si trova e dove deve atterrare, e si anima la sola
differenza con una `transform` — nessun ricalcolo di layout per frame.

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

A intro conclusa i filtri SVG vengono spenti: 51 filtri `blur` attivi
costerebbero frame per nulla sulle postazioni di reparto. La sequenza
rispetta anche `prefers-reduced-motion`.

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

Dettaglio completo in [`AUDIT.md`](AUDIT.md).
