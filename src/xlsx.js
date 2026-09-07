'use strict';

/* ══════════════════════════════════════════════════════════════════
   Generatore .xlsx senza dipendenze esterne.

   Sostituisce SheetJS caricato da CDN: l'app deve funzionare offline
   dietro il proxy ospedaliero e non deve eseguire codice di terze parti
   scaricato a runtime.

   Le celle di testo sono scritte come <is><t> (inline string): Excel le
   tratta sempre come testo, quindi una cella che inizia con "=" non
   diventa mai una formula (niente CSV/formula injection).

   API:  XlsxWriter.build([{ name: 'Foglio', rows: [[...], [...]] }])
         → Uint8Array del file .xlsx
   ══════════════════════════════════════════════════════════════════ */

window.XlsxWriter = (function () {

  // ── CRC32 ───────────────────────────────────────────────────────
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const ENCODER = new TextEncoder();
  const bytes = (s) => ENCODER.encode(s);

  // ── ZIP (metodo "stored": nessuna compressione, nessuna libreria) ──
  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F),
      date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
    };
  }

  function zip(entries) {
    const stamp = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = bytes(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);   // nomi in UTF-8
      local.setUint16(8, 0, true);        // stored
      local.setUint16(10, stamp.time, true);
      local.setUint16(12, stamp.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014B50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, stamp.time, true);
      cd.setUint16(14, stamp.date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    });

    const centralSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);

    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const total = all.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    all.forEach((p) => { out.set(p, pos); pos += p.length; });
    return out;
  }

  // ── XML ─────────────────────────────────────────────────────────
  function escXml(value) {
    let s = String(value == null ? '' : value);
    // XML 1.0 non ammette i caratteri di controllo (tranne \t \n \r)
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    return s.replace(/[&<>"']/g, (c) => (
      c === '&' ? '&amp;' :
      c === '<' ? '&lt;'  :
      c === '>' ? '&gt;'  :
      c === '"' ? '&quot;' : '&apos;'
    ));
  }

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

    return zip(entries);
  }

  /** Uint8Array → base64, a blocchi per non saturare lo stack. */
  function toBase64(u8) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  return { build, toBase64, escXml };
})();
