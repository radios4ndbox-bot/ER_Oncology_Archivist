'use strict';

/* ══════════════════════════════════════════════════════════════════
   Generatore .pptx senza dipendenze.

   Un .pptx è un archivio ZIP di XML OOXML: si costruisce con lo stesso
   ZipWriter usato per l'.xlsx. Niente libreria da CDN, funziona offline.

   Formato 16:9. Ogni diapositiva può contenere titolo, righe di testo,
   un'immagine PNG e una tabella.

   API:
     PptxWriter.build([
       { titolo, sottotitolo, righe: [...], immagini: [{png, x, y, w, h}],
         tabella: { intestazioni: [...], righe: [[...]] } }
     ]) → Uint8Array
   ══════════════════════════════════════════════════════════════════ */

window.PptxWriter = (function () {

  const Z = window.ZipWriter;
  const esc = (v) => Z.escXml(v);

  // Diapositiva 16:9 in EMU (1 pollice = 914400 EMU)
  const LARG = 12192000;
  const ALT = 6858000;
  const EMU_PX = 9525;            // 1 px a 96 dpi

  const COL_TITOLO = 'A82255';    // l'accent del tool
  const COL_TESTO = '18170F';
  const COL_TENUE = '6B6A62';

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

  // ── forme ───────────────────────────────────────────────────────
  let idForma = 1;
  const prossimoId = () => ++idForma;

  function riquadro(x, y, w, h) {
    return '<a:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
           '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(h) + '"/></a:xfrm>';
  }

  function paragrafo(testo, dim, colore, grassetto, allineamento) {
    return '<a:p><a:pPr algn="' + (allineamento || 'l') + '"/><a:r><a:rPr lang="it-IT" sz="' + dim +
           '" b="' + (grassetto ? 1 : 0) + '" dirty="0"><a:solidFill><a:srgbClr val="' + colore +
           '"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>' + esc(testo) + '</a:t></a:r></a:p>';
  }

  function casellaTesto(x, y, w, h, paragrafi) {
    const id = prossimoId();
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Testo ' + id + '"/>' +
      '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr>' + riquadro(x, y, w, h) +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
      '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>' +
      paragrafi.join('') + '</p:txBody></p:sp>';
  }

  function barra(x, y, w, h, colore) {
    const id = prossimoId();
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Barra ' + id + '"/>' +
      '<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' + riquadro(x, y, w, h) +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '<a:solidFill><a:srgbClr val="' + colore + '"/></a:solidFill><a:ln><a:noFill/></a:ln>' +
      '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
  }

  function immagine(idRel, x, y, w, h) {
    const id = prossimoId();
    return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="Grafico ' + id + '"/>' +
      '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="' + idRel + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr>' + riquadro(x, y, w, h) +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  }

  function tabella(x, y, w, intestazioni, righe) {
    const id = prossimoId();
    const nCol = intestazioni.length;
    const largCol = Math.round(w / nCol);
    const hRiga = 280000;

    const cella = (testo, testa) =>
      '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="' + (testa ? 'ctr' : 'l') + '"/>' +
      '<a:r><a:rPr lang="it-IT" sz="1100" b="' + (testa ? 1 : 0) + '">' +
      '<a:solidFill><a:srgbClr val="' + (testa ? 'FFFFFF' : COL_TESTO) + '"/></a:solidFill>' +
      '</a:rPr><a:t>' + esc(testo) + '</a:t></a:r></a:p></a:txBody>' +
      '<a:tcPr marL="68580" marR="68580" marT="34290" marB="34290">' +
      (testa ? '<a:solidFill><a:srgbClr val="' + COL_TITOLO + '"/></a:solidFill>' : '') +
      '</a:tcPr></a:tc>';

    const corpo = righe.map((r) =>
      '<a:tr h="' + hRiga + '">' + r.map((c) => cella(c, false)).join('') + '</a:tr>').join('');

    return '<p:graphicFrame><p:nvGraphicFramePr>' +
      '<p:cNvPr id="' + id + '" name="Tabella ' + id + '"/><p:cNvGraphicFramePr/><p:nvPr/>' +
      '</p:nvGraphicFramePr><p:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
      '<a:ext cx="' + Math.round(w) + '" cy="' + ((righe.length + 1) * hRiga) + '"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>' +
      intestazioni.map(() => '<a:gridCol w="' + largCol + '"/>').join('') +
      '</a:tblGrid>' +
      '<a:tr h="' + hRiga + '">' + intestazioni.map((t) => cella(t, true)).join('') + '</a:tr>' +
      corpo +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  }

  // ── diapositiva ─────────────────────────────────────────────────
  function diapositiva(dia, relImmagini) {
    const forme = [];
    const MARG = 640000;
    let y = MARG;

    if (dia.titolo) {
      forme.push(barra(MARG, y, 150000, 460000, COL_TITOLO));
      forme.push(casellaTesto(MARG + 260000, y - 60000, LARG - MARG * 2, 560000,
        [paragrafo(dia.titolo, 2800, COL_TESTO, true)]));
      y += 560000;
    }
    if (dia.sottotitolo) {
      forme.push(casellaTesto(MARG + 260000, y - 120000, LARG - MARG * 2, 360000,
        [paragrafo(dia.sottotitolo, 1300, COL_TENUE, false)]));
      y += 300000;
    }

    (dia.righe || []).forEach((riga, i) => {
      forme.push(casellaTesto(MARG, y + i * 380000, LARG - MARG * 2, 360000,
        [paragrafo(riga, 1600, COL_TESTO, false)]));
    });
    if (dia.righe && dia.righe.length) y += dia.righe.length * 380000 + 120000;

    (dia.immagini || []).forEach((img, i) => {
      forme.push(immagine(relImmagini[i], img.x, img.y, img.w, img.h));
    });

    if (dia.tabella) {
      forme.push(tabella(MARG, y, LARG - MARG * 2,
        dia.tabella.intestazioni, dia.tabella.righe));
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr/>' + forme.join('') + '</p:spTree></p:cSld>' +
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

    const xmlDia = dia.map((d) => {
      const rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
      ];
      const idImmagini = [];
      (d.immagini || []).forEach((img) => {
        nMedia++;
        const nome = 'image' + nMedia + '.png';
        media.push({ name: 'ppt/media/' + nome, data: img.png });
        const rid = 'rId' + (rels.length + 1);
        rels.push('<Relationship Id="' + rid +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + nome + '"/>');
        idImmagini.push(rid);
      });
      return { xml: diapositiva(d, idImmagini), rels: rels };
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
