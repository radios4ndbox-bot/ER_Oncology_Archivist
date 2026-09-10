'use strict';

/* ══════════════════════════════════════════════════════════════════
   Generatore .pptx senza dipendenze.

   Un .pptx è un archivio ZIP di XML OOXML: si costruisce con lo stesso
   ZipWriter usato per l'.xlsx. Niente libreria da CDN, funziona offline.

   Formato 16:9, impaginazione da presentazione: copertina scura,
   intestazione con filo di colore, piè di pagina numerato, KPI come
   schede, grafici con legenda e didascalia di lettura.

   Tipi di diapositiva:
     { tipo: 'copertina', etichetta, titolo, righe: [...], piede }
     { titolo, sottotitolo, kpi: [{ valore, etichetta, nota, colore }] }
     { titolo, sottotitolo, grafico: { png, w, h },
       legenda: [{ colore, etichetta, valore }], legendaSotto: bool,
       didascalia }
     { titolo, sottotitolo, tabella: { intestazioni, righe, allineamenti },
       didascalia }
   Ogni diapositiva non di copertina accetta anche `piede`.

   API:  PptxWriter.build([...]) → Uint8Array
   ══════════════════════════════════════════════════════════════════ */

window.PptxWriter = (function () {

  const Z = window.ZipWriter;
  const esc = (v) => Z.escXml(v);

  // Diapositiva 16:9 in EMU (1 pollice = 914400 EMU)
  const LARG = 12192000;
  const ALT = 6858000;
  const EMU_PX = 9525;            // 1 px a 96 dpi
  const MARG = 560000;

  const C = {
    accent: 'A82255', accentChiaro: 'FF4D6D',
    testo: '18170F', tenue: '6B6A62', debole: 'A09E97',
    scuro: '18170F', carta: 'FFFFFF', fondoTenue: 'F7F6F2', bordo: 'E0DED7'
  };

  // area utile delle diapositive di contenuto
  const AREA = {
    x: MARG,
    y: MARG + 820000,
    w: LARG - MARG * 2,
    h: (ALT - 640000) - (MARG + 820000)
  };

  // ── parti fisse del pacchetto ───────────────────────────────────
  const RELS_RADICE =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>';

  const TEMA =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ER">' +
    '<a:themeElements><a:clrScheme name="ER">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="18170F"/></a:dk2><a:lt2><a:srgbClr val="F4F3EF"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="A82255"/></a:accent1><a:accent2><a:srgbClr val="6B1A7A"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="8B1A1A"/></a:accent3><a:accent4><a:srgbClr val="E8A020"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="1A6040"/></a:accent5><a:accent6><a:srgbClr val="C8C6BE"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="A82255"/></a:hlink><a:folHlink><a:srgbClr val="6B1A7A"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="ER">' +
    '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="ER">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>';

  const MASTER =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/></p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>';

  const MASTER_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';

  const LAYOUT =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
    '<p:cSld name="Vuota"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

  const LAYOUT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    '</Relationships>';

  // ── primitive ───────────────────────────────────────────────────
  let idForma = 1;
  const prossimoId = () => ++idForma;
  const r0 = (v) => Math.round(v);

  function riquadro(x, y, w, h) {
    return '<a:xfrm><a:off x="' + r0(x) + '" y="' + r0(y) + '"/>' +
           '<a:ext cx="' + r0(Math.max(1, w)) + '" cy="' + r0(Math.max(1, h)) + '"/></a:xfrm>';
  }

  /** dim in centesimi di punto (1400 = 14pt). */
  function paragrafo(testo, dim, colore, opz) {
    const o = opz || {};
    return '<a:p><a:pPr algn="' + (o.allinea || 'l') + '">' +
      (o.interlinea ? '<a:lnSpc><a:spcPct val="' + o.interlinea + '"/></a:lnSpc>' : '') +
      (o.dopo ? '<a:spcAft><a:spcPts val="' + o.dopo + '"/></a:spcAft>' : '') +
      '</a:pPr><a:r><a:rPr lang="it-IT" sz="' + dim + '" b="' + (o.grassetto ? 1 : 0) + '"' +
      (o.spaziatura ? ' spc="' + o.spaziatura + '"' : '') + ' dirty="0">' +
      '<a:solidFill><a:srgbClr val="' + colore + '"/></a:solidFill>' +
      '<a:latin typeface="Calibri"/></a:rPr>' +
      '<a:t>' + esc(testo) + '</a:t></a:r></a:p>';
  }

  function casellaTesto(x, y, w, h, paragrafi, ancora) {
    const id = prossimoId();
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Testo ' + id + '"/>' +
      '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>' + riquadro(x, y, w, h) +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
      '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="' +
      (ancora || 't') + '"><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
      paragrafi.join('') + '</p:txBody></p:sp>';
  }

  /** Rettangolo pieno, eventualmente arrotondato e bordato. */
  function forma(x, y, w, h, o) {
    const id = prossimoId();
    const geom = o.arrotonda
      ? '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ' + o.arrotonda + '"/></a:avLst></a:prstGeom>'
      : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
    const fill = o.colore ? '<a:solidFill><a:srgbClr val="' + o.colore + '"/></a:solidFill>' : '<a:noFill/>';
    const ln = o.bordo
      ? '<a:ln w="9525"><a:solidFill><a:srgbClr val="' + o.bordo + '"/></a:solidFill></a:ln>'
      : '<a:ln><a:noFill/></a:ln>';
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Forma ' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr>' + riquadro(x, y, w, h) + geom + fill + ln + '</p:spPr>' +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
  }

  function immagine(idRel, x, y, w, h) {
    const id = prossimoId();
    return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="Grafico ' + id + '"/>' +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="' + idRel + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr>' + riquadro(x, y, w, h) +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  }

  function tabella(x, y, w, intestazioni, righe, allineamenti) {
    const id = prossimoId();
    const nCol = intestazioni.length;
    const primo = r0(w * (nCol > 2 ? 0.34 : 0.5));
    const altre = r0((w - primo) / Math.max(1, nCol - 1));
    const larghezze = intestazioni.map((_t, i) => (i === 0 ? primo : altre));
    const hRiga = 300000;

    const cella = (testo, testa, col, pari) => {
      const alg = (allineamenti && allineamenti[col]) || (col === 0 ? 'l' : 'ctr');
      const fondo = testa ? C.accent : (pari ? C.fondoTenue : C.carta);
      // solo filetti orizzontali chiari: la griglia nera predefinita
      // appesantisce la tabella
      const filo = (t, colore) => colore
        ? '<a:' + t + ' w="6350"><a:solidFill><a:srgbClr val="' + colore + '"/></a:solidFill></a:' + t + '>'
        : '<a:' + t + ' w="6350"><a:noFill/></a:' + t + '>';
      const bordi = filo('lnL') + filo('lnR') + filo('lnT', testa ? C.accent : C.bordo) +
        filo('lnB', testa ? C.accent : C.bordo);
      return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="' + alg + '"/>' +
        '<a:r><a:rPr lang="it-IT" sz="' + (testa ? 1050 : 1150) + '" b="' + (testa ? 1 : 0) + '">' +
        '<a:solidFill><a:srgbClr val="' + (testa ? 'FFFFFF' : C.testo) + '"/></a:solidFill>' +
        '<a:latin typeface="Calibri"/></a:rPr><a:t>' + esc(testo) + '</a:t></a:r></a:p></a:txBody>' +
        '<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">' + bordi +
        '<a:solidFill><a:srgbClr val="' + fondo + '"/></a:solidFill></a:tcPr></a:tc>';
    };

    const corpo = righe.map((r, i) =>
      '<a:tr h="' + hRiga + '">' + r.map((c, col) => cella(c, false, col, i % 2 === 1)).join('') + '</a:tr>'
    ).join('');

    return '<p:graphicFrame><p:nvGraphicFramePr>' +
      '<p:cNvPr id="' + id + '" name="Tabella ' + id + '"/><p:cNvGraphicFramePr/><p:nvPr/>' +
      '</p:nvGraphicFramePr><p:xfrm><a:off x="' + r0(x) + '" y="' + r0(y) + '"/>' +
      '<a:ext cx="' + r0(w) + '" cy="' + ((righe.length + 1) * hRiga) + '"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>' +
      larghezze.map((lw) => '<a:gridCol w="' + lw + '"/>').join('') +
      '</a:tblGrid>' +
      '<a:tr h="' + hRiga + '">' + intestazioni.map((t, col) => cella(t, true, col, false)).join('') + '</a:tr>' +
      corpo + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  }

  // ── componenti di impaginazione ─────────────────────────────────
  function intestazione(d) {
    let s = forma(MARG, MARG + 30000, 76200, d.sottotitolo ? 620000 : 440000, { colore: C.accent });
    s += casellaTesto(MARG + 240000, MARG, AREA.w - 240000, 420000,
      [paragrafo(d.titolo || '', 2600, C.testo, { grassetto: true })]);
    if (d.sottotitolo) {
      s += casellaTesto(MARG + 240000, MARG + 400000, AREA.w - 240000, 260000,
        [paragrafo(d.sottotitolo, 1250, C.tenue)]);
    }
    return s;
  }

  function piede(testo, numero, totale) {
    const y = ALT - 420000;
    return forma(MARG, y - 70000, AREA.w, 9525, { colore: C.bordo }) +
      casellaTesto(MARG, y, AREA.w * 0.75, 200000, [paragrafo(testo || '', 900, C.debole)]) +
      casellaTesto(MARG + AREA.w * 0.75, y, AREA.w * 0.25, 200000,
        [paragrafo(numero + ' / ' + totale, 900, C.debole, { allinea: 'r' })]);
  }

  /** Riquadro di lettura sotto al grafico: filo di colore, etichetta, testo. */
  function didascalia(testo, x, y, w, h) {
    return forma(x, y, w, h, { colore: C.fondoTenue, arrotonda: 5000 }) +
      forma(x, y + 60000, 38100, h - 120000, { colore: C.accent }) +
      casellaTesto(x + 220000, y + 120000, w - 360000, h - 200000, [
        paragrafo('LETTURA DEL DATO', 850, C.accent, { grassetto: true, spaziatura: 80, dopo: 300 }),
        paragrafo(testo || '', 1200, C.testo, { interlinea: 120000 })
      ]);
  }

  function legenda(voci, x, y, w, orizzontale) {
    let s = '';
    if (orizzontale) {
      // passo fisso e gruppo centrato: distribuite su tutta la larghezza
      // le voci finirebbero lontane fra loro e dal grafico
      const passo = Math.min(w / Math.max(1, voci.length), 2900000);
      const x0 = x + (w - passo * voci.length) / 2;
      voci.forEach((v, i) => {
        const vx = x0 + passo * i;
        s += forma(vx, y + 50000, 150000, 150000, { colore: v.colore, arrotonda: 20000 });
        s += casellaTesto(vx + 230000, y, passo - 260000, 260000,
          [paragrafo(v.etichetta + (v.valore != null ? '  ' + v.valore : ''), 1150, C.tenue)]);
      });
      return s;
    }
    voci.forEach((v, i) => {
      const vy = y + i * 460000;
      s += forma(x, vy + 70000, 190000, 190000, { colore: v.colore, arrotonda: 20000 });
      s += casellaTesto(x + 300000, vy, w * 0.62, 330000,
        [paragrafo(v.etichetta, 1400, C.testo)], 'ctr');
      if (v.valore != null) {
        s += casellaTesto(x + 300000 + w * 0.62, vy, w * 0.38 - 300000, 330000,
          [paragrafo(String(v.valore), 1300, C.tenue, { allinea: 'r', grassetto: true })], 'ctr');
      }
    });
    return s;
  }

  function grigliaKpi(kpi) {
    const col = 3;
    const gap = 228600;
    const w = (AREA.w - gap * (col - 1)) / col;
    const righeKpi = Math.ceil(kpi.length / col);
    const h = Math.min(1900000, (AREA.h - gap * (righeKpi - 1)) / righeKpi);
    let s = '';
    kpi.forEach((k, i) => {
      const x = AREA.x + (i % col) * (w + gap);
      const y = AREA.y + Math.floor(i / col) * (h + gap);
      const colore = k.colore || C.accent;
      s += forma(x, y, w, h, { colore: C.carta, bordo: C.bordo, arrotonda: 6000 });
      s += forma(x + 140000, y, w - 280000, 50800, { colore: colore });
      s += casellaTesto(x + 260000, y + 280000, w - 520000, 700000,
        [paragrafo(String(k.valore), 4000, colore, { grassetto: true })]);
      s += casellaTesto(x + 260000, y + 1020000, w - 520000, 260000,
        [paragrafo(String(k.etichetta).toUpperCase(), 1050, C.tenue, { grassetto: true, spaziatura: 60 })]);
      if (k.nota) {
        s += casellaTesto(x + 260000, y + 1330000, w - 520000, h - 1420000,
          [paragrafo(k.nota, 1150, C.tenue, { interlinea: 115000 })]);
      }
    });
    return s;
  }

  function copertina(d) {
    let s = forma(0, 0, LARG, ALT, { colore: C.scuro });
    s += forma(0, 0, 228600, ALT, { colore: C.accent });
    const x = MARG * 2;
    const w = LARG - MARG * 3;
    s += casellaTesto(x, ALT * 0.28, w, 320000,
      [paragrafo(String(d.etichetta || 'Report statistico').toUpperCase(), 1150, C.accentChiaro, { grassetto: true, spaziatura: 200 })]);
    s += casellaTesto(x, ALT * 0.28 + 420000, w, 1000000,
      [paragrafo(d.titolo || '', 4400, 'FFFFFF', { grassetto: true })]);
    s += forma(x, ALT * 0.28 + 1480000, 1100000, 25400, { colore: C.accentChiaro });
    s += casellaTesto(x, ALT * 0.28 + 1680000, w, 1000000,
      (d.righe || []).map((r) => paragrafo(r, 1600, 'C8C6BE', { interlinea: 135000 })));
    s += casellaTesto(x, ALT - 760000, w, 260000, [paragrafo(d.piede || '', 1000, '8A8880')]);
    return s;
  }

  // ── diapositiva ─────────────────────────────────────────────────
  function diapositiva(d, relImmagine, numero, totale) {
    let forme = '';

    if (d.tipo === 'copertina') {
      forme = copertina(d);
    } else {
      forme = intestazione(d);
      const hDid = d.didascalia ? 1120000 : 0;
      const gapDid = d.didascalia ? 200000 : 0;
      const hUtile = AREA.h - hDid - gapDid;

      if (d.kpi) forme += grigliaKpi(d.kpi);

      if (d.grafico && relImmagine) {
        const conLegendaLato = d.legenda && d.legenda.length && !d.legendaSotto;
        const hLeg = d.legenda && d.legendaSotto ? 300000 : 0;
        const larghezzaImg = conLegendaLato ? AREA.w * 0.46 : AREA.w;
        const hImg = hUtile - hLeg - (hLeg ? 120000 : 0);
        const sc = Math.min(larghezzaImg / d.grafico.w, hImg / d.grafico.h);
        const iw = d.grafico.w * sc;
        const ih = d.grafico.h * sc;
        const ix = AREA.x + (larghezzaImg - iw) / 2;
        const iy = AREA.y + (hImg - ih) / 2;
        forme += immagine(relImmagine, ix, iy, iw, ih);

        if (conLegendaLato) {
          const lx = AREA.x + AREA.w * 0.52;
          const hLista = d.legenda.length * 460000;
          forme += legenda(d.legenda, lx, AREA.y + Math.max(0, (hUtile - hLista) / 2), AREA.w * 0.48, false);
        } else if (d.legenda && d.legendaSotto) {
          forme += legenda(d.legenda, AREA.x + AREA.w * 0.15, AREA.y + hImg + 120000, AREA.w * 0.7, true);
        }
      }

      if (d.tabella) {
        forme += tabella(AREA.x, AREA.y, AREA.w, d.tabella.intestazioni,
          d.tabella.righe, d.tabella.allineamenti);
      }

      if (d.didascalia) {
        forme += didascalia(d.didascalia, AREA.x, AREA.y + AREA.h - hDid, AREA.w, hDid);
      }

      forme += piede(d.piede, numero, totale);
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr/>' + forme + '</p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }

  // ── pacchetto ───────────────────────────────────────────────────
  function build(diapositive) {
    const dia = (diapositive || []).filter(Boolean);
    if (!dia.length) throw new Error('Nessuna diapositiva da esportare.');
    idForma = 1;

    const parti = [];
    const media = [];
    let nMedia = 0;

    const xmlDia = dia.map((d, i) => {
      const rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
      ];
      let relImmagine = null;
      if (d.grafico && d.grafico.png) {
        nMedia++;
        const nome = 'image' + nMedia + '.png';
        media.push({ name: 'ppt/media/' + nome, data: d.grafico.png });
        relImmagine = 'rId2';
        rels.push('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + nome + '"/>');
      }
      return { xml: diapositiva(d, relImmagine, i + 1, dia.length), rels: rels };
    });

    const presentazione =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst>' + dia.map((_d, i) =>
        '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>').join('') + '</p:sldIdLst>' +
      '<p:sldSz cx="' + LARG + '" cy="' + ALT + '"/>' +
      '<p:notesSz cx="' + ALT + '" cy="' + LARG + '"/></p:presentation>';

    const presRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      dia.map((_d, i) => '<Relationship Id="rId' + (i + 2) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' +
        (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (dia.length + 2) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
      '</Relationships>';

    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      dia.map((_d, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') +
      '</Types>';

    parti.push({ name: '[Content_Types].xml', data: Z.bytes(contentTypes) });
    parti.push({ name: '_rels/.rels', data: Z.bytes(RELS_RADICE) });
    parti.push({ name: 'ppt/presentation.xml', data: Z.bytes(presentazione) });
    parti.push({ name: 'ppt/_rels/presentation.xml.rels', data: Z.bytes(presRels) });
    parti.push({ name: 'ppt/theme/theme1.xml', data: Z.bytes(TEMA) });
    parti.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: Z.bytes(MASTER) });
    parti.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: Z.bytes(MASTER_RELS) });
    parti.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: Z.bytes(LAYOUT) });
    parti.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: Z.bytes(LAYOUT_RELS) });

    xmlDia.forEach((d, i) => {
      parti.push({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: Z.bytes(d.xml) });
      parti.push({
        name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels',
        data: Z.bytes('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          d.rels.join('') + '</Relationships>')
      });
    });
    media.forEach((m) => parti.push(m));

    return Z.build(parti);
  }

  return { build: build, LARG: LARG, ALT: ALT, EMU_PX: EMU_PX };
})();
