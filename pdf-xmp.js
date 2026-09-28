/*!
 * pdf-xmp.js - 文書タイトル クリーニング
 * PDF に埋め込まれた XMP メタデータ（XML）から、文書のタイトル dc:title だけを
 * 読む・取り除く・書き込む層。DOM の DOMParser は読み取りの確認にだけ使う。
 *
 * Firefox（pdf.js）はタブの表示にこの dc:title を優先して使う。
 * 取り除くときは dc:title 要素を「同じバイト数の空白」に置き換える。
 * XML としては空白が残るだけなので、ストリームの長さも位置も変わらない。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var NS = {
    dc: 'http://purl.org/dc/elements/1.1/',
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xml: 'http://www.w3.org/XML/1998/namespace',
    pdfuaid: 'http://www.aiim.org/pdfua/ns/id/'
  };

  /* XML 1.0 で使えない制御文字 */
  var INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

  /* ------------------------------------------------------------------ *
   * 文字コード
   * ------------------------------------------------------------------ */

  /**
   * UTF-8 として読む。BOM も 1 文字として残すので、文字位置からバイト位置を
   * 正しく逆算できる。UTF-8 として不正なら null（位置の計算が狂うため扱わない）。
   */
  function decode(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function encode(text) {
    return new TextEncoder().encode(text);
  }

  function escapeXml(text) {
    return String(text)
      .replace(INVALID_XML_CHARS, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ *
   * dc:title の在りか
   * ------------------------------------------------------------------ */

  /** 名前空間 uri に結び付けられている接頭辞（dc など）をすべて返す。 */
  function prefixesFor(text, uri) {
    var found = [];
    var pattern = /xmlns:([A-Za-z_][\w.\-]*)\s*=\s*(["'])([^"']*)\2/g;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[3] === uri && found.indexOf(match[1]) < 0) { found.push(match[1]); }
    }
    return found;
  }

  /** dc:title の文字位置（要素形 <dc:title>…</dc:title> と、属性形 dc:title="…"）。 */
  function titleSpans(text) {
    var spans = [];
    prefixesFor(text, NS.dc).forEach(function (prefix) {
      var p = escapeRegExp(prefix);
      var patterns = [
        new RegExp('<' + p + ':title(?:\\s[^>]*?)?(?:/>|>[\\s\\S]*?</' + p + ':title\\s*>)', 'g'),
        new RegExp('\\s' + p + ':title\\s*=\\s*(?:"[^"]*"|\'[^\']*\')', 'g')
      ];
      patterns.forEach(function (pattern) {
        var match;
        while ((match = pattern.exec(text)) !== null) {
          spans.push({ start: match.index, end: match.index + match[0].length });
        }
      });
    });
    spans.sort(function (a, b) { return a.start - b.start; });
    return spans.filter(function (span, i) { return i === 0 || span.start >= spans[i - 1].end; });
  }

  function parse(text) {
    try {
      var doc = new DOMParser().parseFromString(text, 'application/xml');
      return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
    } catch (e) {
      return null;
    }
  }

  /** rdf:Alt の中から既定言語（x-default）の値を選ぶ。 */
  function altText(element) {
    var items = element.getElementsByTagNameNS(NS.rdf, 'li');
    if (items.length === 0) { return element.textContent.trim(); }
    for (var i = 0; i < items.length; i++) {
      var lang = items[i].getAttributeNS(NS.xml, 'lang') || items[i].getAttribute('xml:lang');
      if (lang === 'x-default') { return items[i].textContent; }
    }
    return items[0].textContent;
  }

  function stripTags(fragment) {
    return fragment.replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .trim();
  }

  /**
   * XMP の文字列から dc:title を読む。無ければ null。
   * XML として読めない壊れた XMP でも、正規表現で拾えれば返す。
   */
  function readTitle(text) {
    var doc = parse(text);
    if (doc) {
      var elements = doc.getElementsByTagNameNS(NS.dc, 'title');
      if (elements.length > 0) { return altText(elements[0]); }
      var descriptions = doc.getElementsByTagNameNS(NS.rdf, 'Description');
      for (var i = 0; i < descriptions.length; i++) {
        if (descriptions[i].hasAttributeNS(NS.dc, 'title')) {
          return descriptions[i].getAttributeNS(NS.dc, 'title');
        }
      }
      return null;
    }
    var spans = titleSpans(text);
    return spans.length === 0 ? null : stripTags(text.slice(spans[0].start, spans[0].end));
  }

  /** PDF/UA（アクセシビリティ規格）への準拠を宣言しているか。 */
  function declaresPdfUa(text) {
    return prefixesFor(text, NS.pdfuaid).some(function (prefix) {
      return new RegExp('[<\\s]' + escapeRegExp(prefix) + ':part[\\s>=/]').test(text);
    });
  }

  /* ------------------------------------------------------------------ *
   * 書き換え
   * ------------------------------------------------------------------ */

  /**
   * dc:title を同じバイト数の空白で塗りつぶした、新しいバイト列を返す。
   * 取り除くものが無ければ null。長さは必ず元と同じ。
   */
  function blankTitle(bytes) {
    var text = decode(bytes);
    if (text === null) { throw new Error('XMP メタデータが UTF-8 として読めないため、タイトルを取り除けません'); }
    var spans = titleSpans(text);
    if (spans.length === 0) { return null; }

    var out = bytes.slice();
    var blanked = 0;
    spans.forEach(function (span) {
      var from = encode(text.slice(0, span.start)).length;
      var to = from + encode(text.slice(span.start, span.end)).length;
      out.fill(0x20, from, to);
      blanked += to - from;
    });
    var after = decode(out);
    if (after === null || readTitle(after) !== null) {
      throw new Error('XMP メタデータのタイトルを取り除けませんでした（想定外の書き方です）');
    }
    return { bytes: out, blanked: blanked };
  }

  /**
   * dc:title を指定した文字列にした、新しい XMP の文字列を返す（長さは変わる）。
   * 既存の dc:title はすべて取り除き、同じ rdf:about をもつ rdf:Description を
   * rdf:RDF の末尾に 1 つ足す（XMP ではこの書き方が認められている）。
   */
  function withTitle(text, title) {
    var cleaned = text;
    titleSpans(text).reverse().forEach(function (span) {
      cleaned = cleaned.slice(0, span.start) + cleaned.slice(span.end);
    });
    var rdf = prefixesFor(cleaned, NS.rdf)[0];
    var close = rdf ? cleaned.lastIndexOf('</' + rdf + ':RDF') : -1;
    if (close < 0) { throw new Error('XMP メタデータの構造（rdf:RDF）が見つからないため、タイトルを書き込めません'); }

    var aboutMatch = cleaned.match(new RegExp('\\s' + escapeRegExp(rdf) + ':about\\s*=\\s*(["\'])([^"\']*)\\1'));
    var about = aboutMatch ? aboutMatch[2] : '';
    var block =
      '<' + rdf + ':Description ' + rdf + ':about="' + escapeXml(about) + '" xmlns:dc="' + NS.dc + '">' +
      '<dc:title><' + rdf + ':Alt><' + rdf + ':li xml:lang="x-default">' + escapeXml(title) + '</' + rdf + ':li>' +
      '</' + rdf + ':Alt></dc:title></' + rdf + ':Description>\n';
    var result = cleaned.slice(0, close) + block + cleaned.slice(close);

    /* 元が XML として読めたなら、書き込んだ後も読めて、値が一致することを確かめる */
    var expected = String(title).replace(INVALID_XML_CHARS, '');
    if (parse(text) && (!parse(result) || readTitle(result) !== expected)) {
      throw new Error('XMP メタデータにタイトルを書き込めませんでした');
    }
    return result;
  }

  WTC.PdfXmp = {
    decode: decode,
    encode: encode,
    readTitle: readTitle,
    declaresPdfUa: declaresPdfUa,
    blankTitle: blankTitle,
    withTitle: withTitle
  };
}(window));
