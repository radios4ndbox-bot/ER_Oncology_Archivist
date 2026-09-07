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

Il proxy ospedaliero blocca npm in locale: si compila su **GitHub Actions**.

1. Push su `main` (o *Actions → Build Windows → Run workflow*).
2. Al termine, scaricare l'artifact **`ER-Oncology-Archivist-Windows`**:
   contiene il `.exe` portable e l'installer NSIS.

La pipeline esegue prima dei controlli automatici: sintassi JavaScript,
assenza di gestori di evento inline, assenza di risorse remote, presenza
delle impostazioni di sicurezza in `main.js`. Se uno fallisce non si compila.

### Icona

Copiare l'icona in `build/icon.ico` (ICO, almeno 256×256). electron-builder
la rileva da sola: **non** va aggiunta nessuna chiave `icon` in
`package.json`. Se il file manca, la build usa l'icona predefinita.

### In locale (dove npm funziona)

```bash
npm install
npm start
```

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
