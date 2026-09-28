/*!
 * samples-pdf.js - 文書タイトル クリーニング
 * 動作確認用のサンプル PDF をブラウザ内で組み立てる層。
 *
 * どれも Edge / Chrome でそのまま開ける 1 ページの PDF で、
 * 開いたときにタブに出る名前（タイトル）を処理の前後で見比べられる。
 * 実在する出力ソフトの形（従来の相互参照表 / Word と同じ併用型 /
 * 圧縮された相互参照ストリーム）をそれぞれ再現している。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Syntax = WTC.PdfSyntax;
  var Writer = WTC.PdfWriter;
  var Filters = WTC.PdfFilters;

  var PDF_MIME = 'application/pdf';
  var BINARY_MARK = new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);   /* バイナリを含む印（%âãÏÓ） */
  var XMP_PADDING = 1600;
  var DOC_ID = '[<5754432D53414D504C452D5044462D31><5754432D53414D504C452D5044462D31>]';

  /* ------------------------------------------------------------------ *
   * 文字列の書き方
   * ------------------------------------------------------------------ */
  function pad(value, width) {
    var text = String(value);
    while (text.length < width) { text = '0' + text; }
    return text;
  }

  /** 本文用: UTF-16BE の 16 進（UniJIS-UCS2-HW-H で表示する）。 */
  function ucs2Hex(text) {
    var hex = '<';
    for (var i = 0; i < text.length; i++) { hex += pad(text.charCodeAt(i).toString(16).toUpperCase(), 4); }
    return hex + '>';
  }

  /** Word と同じ書き方: UTF-16BE（BOM 付き）を 8 進エスケープのリテラル文字列にする。 */
  function literalUtf16(text) {
    var codes = [0xfe, 0xff];
    for (var i = 0; i < text.length; i++) { codes.push(text.charCodeAt(i) >> 8, text.charCodeAt(i) & 0xff); }
    return '(' + codes.map(function (b) {
      var printable = b >= 0x20 && b <= 0x7e && b !== 0x28 && b !== 0x29 && b !== 0x5c;
      return printable ? String.fromCharCode(b) : '\\' + pad(b.toString(8), 3);
    }).join('') + ')';
  }

  function utf8(text) { return new TextEncoder().encode(text); }

  function xmpPacket(title, declaresPdfUa) {
    return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n' +
      '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + title + '</rdf:li></rdf:Alt></dc:title>\n' +
      '<dc:creator><rdf:Seq><rdf:li>サンプル作成者</rdf:li></rdf:Seq></dc:creator>\n' +
      '<pdf:Producer>文書タイトル クリーニング（サンプル）</pdf:Producer>\n' +
      '</rdf:Description>\n' +
      (declaresPdfUa
        ? '<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></rdf:Description>\n'
        : '') +
      '</rdf:RDF></x:xmpmeta>\n' + new Array(XMP_PADDING).join(' ') + '\n<?xpacket end="w"?>';
  }

  /* ------------------------------------------------------------------ *
   * ページ（本文）と共通のオブジェクト
   *  1 カタログ / 2 ページ群 / 3 ページ / 4 本文 / 5 欧文フォント /
   *  6〜8 和文フォント（埋め込みなし。表示には Windows の日本語フォントが使われる）
   * ------------------------------------------------------------------ */
  function pageContent(lines) {
    var text = 'BT /F1 10 Tf 56 800 Td (Document Title Cleaning - sample PDF) Tj ET\n';
    lines.forEach(function (line, index) {
      text += 'BT /F2 ' + (index === 0 ? 18 : 12) + ' Tf 56 ' + (760 - index * 30) + ' Td ' + ucs2Hex(line) + ' Tj ET\n';
    });
    return Syntax.ascii(text);
  }

  function pageObjects(catalogExtra) {
    return [
      { num: 1, body: '<</Type/Catalog/Pages 2 0 R' + (catalogExtra || '') + '>>' },
      { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { num: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R' +
        '/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>>>' },
      { num: 5, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
      /* 英数字は半角の字形（CID 231〜325・幅 500）に割り当てる CMap を使う */
      { num: 6, body: '<</Type/Font/Subtype/Type0/BaseFont/HeiseiKakuGo-W5/Encoding/UniJIS-UCS2-HW-H/DescendantFonts[7 0 R]>>' },
      { num: 7, body: '<</Type/Font/Subtype/CIDFontType0/BaseFont/HeiseiKakuGo-W5' +
        '/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 2>>/FontDescriptor 8 0 R/DW 1000/W[231 325 500]>>' },
      { num: 8, body: '<</Type/FontDescriptor/FontName/HeiseiKakuGo-W5/Flags 4/FontBBox[-92 -250 1010 922]' +
        '/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 737/StemV 114>>' }
    ];
  }

  /* ------------------------------------------------------------------ *
   * 組み立て
   * ------------------------------------------------------------------ */

  /** オブジェクトを順に並べ、各オブジェクトの位置を記録する。 */
  function Layout(version) {
    this.parts = ['%PDF-' + version + '\n', BINARY_MARK];
    this.length = 6 + version.length + BINARY_MARK.length;
    this.offsets = {};
  }

  /** 文字列は ASCII だけを渡す（1 文字＝1 バイトとして位置を数えるため）。 */
  Layout.prototype.add = function (part) {
    this.parts.push(part);
    this.length += part.length;
  };

  Layout.prototype.object = function (object) {
    this.offsets[object.num] = this.length;
    this.add(object.num + ' 0 obj\n');
    if (object.data) {
      this.add('<<' + object.dict + '/Length ' + object.data.length + '>>\nstream\n');
      this.add(object.data);
      this.add('\nendstream');
    } else {
      this.add(object.body);
    }
    this.add('\nendobj\n');
  };

  /** 従来の相互参照表。free に挙げた番号は「空き」として書く（併用型で使う）。 */
  Layout.prototype.table = function (size, trailer, free) {
    var at = this.length;
    var lines = 'xref\n0 ' + size + '\n0000000000 65535 f\r\n';
    for (var num = 1; num < size; num++) {
      var used = this.offsets[num] !== undefined && !(free && free.indexOf(num) >= 0);
      lines += used ? pad(this.offsets[num], 10) + ' 00000 n\r\n' : '0000000000 65535 f\r\n';
    }
    this.add(lines + 'trailer\n<</Size ' + size + trailer + '>>\nstartxref\n' + at + '\n%%EOF\n');
  };

  Layout.prototype.file = function (name) {
    return new File([Writer.concat(this.parts)], name, { type: PDF_MIME });
  };

  /** オブジェクトストリームの中身（目次＋本体）を作って圧縮する。 */
  function objectStream(num, objects) {
    var head = '';
    var body = '';
    objects.forEach(function (object) {
      head += object.num + ' ' + body.length + ' ';
      body += object.body + '\n';
    });
    return Filters.deflate(Syntax.ascii(head + body)).then(function (data) {
      return { num: num, dict: '/Type/ObjStm/N ' + objects.length + '/First ' + head.length + '/Filter/FlateDecode', data: data };
    });
  }

  /** 相互参照ストリームの行（種類 1 / 位置 4 / 番号 2 バイト）。 */
  function xrefRow(type, second, third) {
    return [type, (second >>> 24) & 0xff, (second >>> 16) & 0xff, (second >>> 8) & 0xff, second & 0xff,
      (third >> 8) & 0xff, third & 0xff];
  }

  /** PNG 予測子（Up）をかける。Acrobat などが相互参照ストリームに使う形。 */
  function pngUp(rows) {
    var out = [];
    var previous = [0, 0, 0, 0, 0, 0, 0];
    rows.forEach(function (row) {
      out.push(2);
      row.forEach(function (value, i) { out.push((value - previous[i]) & 0xff); });
      previous = row;
    });
    return Uint8Array.from(out);
  }

  /* ------------------------------------------------------------------ *
   * サンプルごとの組み立て
   * ------------------------------------------------------------------ */

  /** 従来の相互参照表の PDF（Chrome の印刷や多くの PDF 作成ソフトと同じ形）。 */
  function buildClassic(fileName, spec) {
    var layout = new Layout(spec.version || '1.4');
    pageObjects().forEach(function (object) { layout.object(object); });
    layout.object({ num: 4, dict: '', data: pageContent(spec.lines) });
    layout.object({ num: 9, body: spec.info });
    var trailer = '/Root 1 0 R/Info 9 0 R/ID ' + DOC_ID + (spec.trailerExtra || '');
    if (spec.encrypt) { layout.object({ num: 10, body: spec.encrypt }); }
    layout.table(spec.encrypt ? 11 : 10, trailer);
    return Promise.resolve(layout.file(fileName));
  }

  /**
   * Word の「PDF として保存」と同じ併用型:
   * 従来の表（古いソフト向け）に加え、構造タグなどは圧縮してオブジェクトストリームに入れ、
   * その在りかを /XRefStm の相互参照ストリームで示す。
   */
  function buildWordLike(fileName, spec) {
    var layout = new Layout('1.7');
    var catalogExtra = '/Lang(ja-JP)/StructTreeRoot 12 0 R/MarkInfo<</Marked true>>/Metadata 10 0 R' +
      '/ViewerPreferences<</DisplayDocTitle true>>';
    pageObjects(catalogExtra).forEach(function (object) { layout.object(object); });
    layout.object({ num: 4, dict: '', data: pageContent(spec.lines) });
    layout.object({ num: 9, body: '<</Title' + literalUtf16(spec.title) + '/Author' + literalUtf16('サンプル作成者') +
      '/Creator' + literalUtf16('Microsoft® Word 相当') + '/CreationDate(D:20240101090000+09\'00\')>>' });
    layout.object({ num: 10, dict: '/Type/Metadata/Subtype/XML', data: utf8(xmpPacket(spec.title, true)) });

    return objectStream(11, [
      { num: 12, body: '<</Type/StructTreeRoot/K 13 0 R>>' },
      { num: 13, body: '<</Type/StructElem/S/Document/P 12 0 R>>' }
    ]).then(function (stm) {
      layout.object(stm);
      var xrefAt = layout.length;
      var rows = [].concat(xrefRow(2, 11, 0), xrefRow(2, 11, 1), xrefRow(1, xrefAt, 0));
      layout.object({ num: 14, dict: '/Type/XRef/Size 15/W[1 4 2]/Index[12 3]', data: Uint8Array.from(rows) });
      layout.table(15, '/Root 1 0 R/Info 9 0 R/ID ' + DOC_ID + '/XRefStm ' + xrefAt, [12, 13, 14]);
      return layout.file(fileName);
    });
  }

  /**
   * 圧縮した形（Acrobat で最適化した PDF などと同じ）:
   * 文書情報辞書を含む多くのオブジェクトをオブジェクトストリームに入れ、
   * XMP も圧縮し、相互参照は予測子つきの圧縮ストリームで書く。
   */
  function buildCompressed(fileName, spec) {
    var layout = new Layout('1.6');
    var packed = pageObjects('/Metadata 10 0 R').concat([
      { num: 9, body: '<</Title' + Syntax.encodeTextStringHex(spec.title) + '/Producer(Sample optimizer)>>' }
    ]);
    return Promise.all([
      Filters.deflate(pageContent(spec.lines)),
      Filters.deflate(utf8(xmpPacket(spec.title, false))),
      objectStream(11, packed)
    ]).then(function (made) {
      layout.object({ num: 4, dict: '/Filter/FlateDecode', data: made[0] });
      layout.object({ num: 10, dict: '/Type/Metadata/Subtype/XML/Filter/FlateDecode', data: made[1] });
      layout.object(made[2]);
      var xrefAt = layout.length;
      var rows = [xrefRow(0, 0, 65535)];
      var inStream = packed.map(function (object) { return object.num; });
      for (var num = 1; num <= 12; num++) {
        var index = inStream.indexOf(num);
        if (index >= 0) { rows.push(xrefRow(2, 11, index)); }
        else if (num === 12) { rows.push(xrefRow(1, xrefAt, 0)); }
        else { rows.push(xrefRow(1, layout.offsets[num], 0)); }
      }
      return Filters.deflate(pngUp(rows)).then(function (data) {
        layout.object({
          num: 12, data: data,
          dict: '/Type/XRef/Size 13/W[1 4 2]/Root 1 0 R/Info 9 0 R/ID ' + DOC_ID +
            '/Filter/FlateDecode/DecodeParms<</Columns 7/Predictor 12>>'
        });
        layout.add('startxref\n' + xrefAt + '\n%%EOF\n');
        return layout.file(fileName);
      });
    });
  }

  /** パスワード付き（開くのにパスワードが要る）。処理できない理由の表示を確かめる用。 */
  function buildPasswordProtected(fileName, spec) {
    var owner = '<' + new Array(33).join('A7') + '>';
    var user = '<' + new Array(33).join('3C') + '>';
    return buildClassic(fileName, {
      version: '1.6',
      lines: spec.lines,
      info: '<</Title(Protected sample)>>',
      encrypt: '<</Filter/Standard/V 2/R 3/Length 128/O ' + owner + '/U ' + user + '/P -3904>>',
      trailerExtra: '/Encrypt 10 0 R'
    });
  }

  function infoWith(title) {
    return '<</Title(' + title + ')/Author(Sample)/Producer(Sample printer)/CreationDate(D:20240101090000Z)>>';
  }

  WTC.SamplesPdf = {
    buildClassic: buildClassic,
    buildWordLike: buildWordLike,
    buildCompressed: buildCompressed,
    buildPasswordProtected: buildPasswordProtected,
    infoWith: infoWith
  };
}(window));
