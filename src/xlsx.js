'use strict';

/* ══════════════════════════════════════════════════════════════════
   Generatore .xlsx senza dipendenze esterne.

   Sostituisce SheetJS caricato da CDN: l'app deve funzionare offline
   dietro il proxy ospedaliero e non deve eseguire codice di terze parti
   scaricato a runtime.

   Le celle di testo sono scritte come <is><t> (inline string): Excel le
   tratta sempre come testo, quindi una cella che inizia con "=" non
   diventa mai una formula (niente CSV/formula injection).

   L'archivio ZIP lo costruisce ZipWriter (src/zip.js), condiviso con
   il generatore .pptx.

   API:  XlsxWriter.build([{ name: 'Foglio', rows: [[...], [...]] }])
         → Uint8Array del file .xlsx
   ══════════════════════════════════════════════════════════════════ */

window.XlsxWriter = (function () {

  const Z = window.ZipWriter;
  const bytes = Z.bytes;

  // ── XML ─────────────────────────────────────────────────────────
  const escXml = Z.escXml;

  function colName(index) {
    let n = index;
    let name = '';
    while (n >= 0) {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    }
    return name;
  }

  function sheetName(raw, fallback) {
    let s = String(raw == null ? '' : raw).replace(/[\\/\[\]:*?]/g, ' ').trim().slice(0, 31);
    return s || fallback;
  }

  function sheetXml(rows) {
    const body = rows.map((row, r) => {
      const cells = (row || []).map((value, c) => {
        const ref = colName(c) + (r + 1);
        if (value === null || value === undefined || value === '') return '';
        if (typeof value === 'number' && isFinite(value)) {
          return '<c r="' + ref + '"><v>' + value + '</v></c>';
        }
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
               escXml(value) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + body + '</sheetData></worksheet>';
  }

  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '</styleSheet>';

  function build(sheets) {
    const list = (sheets || []).filter(Boolean);
    if (!list.length) throw new Error('Nessun foglio da esportare.');

    const names = [];
    list.forEach((s, i) => {
      let name = sheetName(s.name, 'Foglio' + (i + 1));
      let candidate = name;
      let dup = 2;
      while (names.indexOf(candidate) !== -1) candidate = name.slice(0, 28) + '_' + (dup++);
      names.push(candidate);
    });

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      list.map((_s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => '<sheet name="' + escXml(n) + '" sheetId="' + (i + 1) +
        '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets></workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list.map((_s, i) => '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (list.length + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const entries = [
      { name: '[Content_Types].xml',    data: bytes(contentTypes) },
      { name: '_rels/.rels',            data: bytes(rootRels) },
      { name: 'xl/workbook.xml',        data: bytes(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: bytes(workbookRels) },
      { name: 'xl/styles.xml',          data: bytes(STYLES_XML) }
    ];
    list.forEach((s, i) => {
      entries.push({
        name: 'xl/worksheets/sheet' + (i + 1) + '.xml',
        data: bytes(sheetXml(s.rows || []))
      });
    });

    return Z.build(entries);
  }

  return { build: build, toBase64: Z.toBase64, escXml: escXml };
})();
