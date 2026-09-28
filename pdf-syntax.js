/*!
 * pdf-syntax.js - 文書タイトル クリーニング
 * PDF のバイト列を字句に分け、オブジェクトとして読む層。DOM には触れない。
 *
 * 読み取った値には必ず「ファイル内の位置（start / end）」を持たせる。
 * タイトルを取り除くとき、その位置のバイトだけを同じ長さの空白で
 * 塗りつぶすため（位置がずれないので、相互参照表を書き直さずに済む）。
 *
 * 文字列の符号化（PDFDocEncoding / UTF-16BE / UTF-8）の読み書きもここで扱う。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var KIND = {
    number: 'number', name: 'name', string: 'string', array: 'array',
    dict: 'dict', ref: 'ref', bool: 'bool', nil: 'null', keyword: 'keyword'
  };

  var MAX_DEPTH = 64;          /* 壊れたファイルで再帰が止まらないようにする上限 */

  /* PDFDocEncoding のうち Latin-1 と異なる文字（ISO 32000-1 附属書 D） */
  var PDF_DOC_ENCODING = {
    0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9,
    0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
    0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026,
    0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
    0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030,
    0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
    0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01,
    0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
    0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142,
    0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0x9f: 0xfffd,
    0xa0: 0x20ac, 0xad: 0xfffd
  };

  /* ------------------------------------------------------------------ *
   * 文字の分類
   * ------------------------------------------------------------------ */
  function isWhite(c) {
    return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
  }

  function isDelimiter(c) {
    return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
      c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
  }

  function isRegular(c) { return !isWhite(c) && !isDelimiter(c); }

  function isDigit(c) { return c >= 0x30 && c <= 0x39; }

  function hexValue(c) {
    if (c >= 0x30 && c <= 0x39) { return c - 0x30; }
    if (c >= 0x41 && c <= 0x46) { return c - 0x37; }
    if (c >= 0x61 && c <= 0x66) { return c - 0x57; }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * バイト列の検索（ASCII のキーワード用）
   * ------------------------------------------------------------------ */
  function matchesAt(bytes, at, text) {
    if (at < 0 || at + text.length > bytes.length) { return false; }
    for (var i = 0; i < text.length; i++) {
      if (bytes[at + i] !== text.charCodeAt(i)) { return false; }
    }
    return true;
  }

  function indexOf(bytes, text, from, to) {
    var last = Math.min(to === undefined ? bytes.length : to, bytes.length) - text.length;
    var first = text.charCodeAt(0);
    for (var i = Math.max(0, from || 0); i <= last; i++) {
      if (bytes[i] === first && matchesAt(bytes, i, text)) { return i; }
    }
    return -1;
  }

  function lastIndexOf(bytes, text, from, to) {
    var start = Math.max(0, from || 0);
    var first = text.charCodeAt(0);
    for (var i = Math.min(to === undefined ? bytes.length : to, bytes.length) - text.length; i >= start; i--) {
      if (bytes[i] === first && matchesAt(bytes, i, text)) { return i; }
    }
    return -1;
  }

  /** ASCII（と Latin-1）の文字列をバイト列にする。 */
  function ascii(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) { out[i] = text.charCodeAt(i) & 0xff; }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 字句解析
   * ------------------------------------------------------------------ */
  function Cursor(bytes, pos, end) {
    this.bytes = bytes;
    this.pos = pos || 0;
    this.end = end === undefined ? bytes.length : Math.min(end, bytes.length);
  }

  /** 空白とコメントを読み飛ばす。 */
  Cursor.prototype.skipSpace = function () {
    var b = this.bytes;
    while (this.pos < this.end) {
      var c = b[this.pos];
      if (isWhite(c)) {
        this.pos++;
      } else if (c === 0x25) {
        while (this.pos < this.end && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) { this.pos++; }
      } else {
        break;
      }
    }
  };

  function token(type, start, end, value) {
    return { type: type, start: start, end: end, value: value };
  }

  function readLiteralString(cursor) {
    var b = cursor.bytes;
    var start = cursor.pos;
    var i = start + 1;
    var depth = 1;
    var out = [];

    while (i < cursor.end) {
      var c = b[i];
      if (c === 0x5c) {
        i = readEscape(b, i + 1, cursor.end, out);
        continue;
      }
      if (c === 0x28) {
        depth++;
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) { i++; break; }
      }
      if (c === 0x0d) {                           /* 改行は LF 1 つとして扱う */
        out.push(0x0a);
        i += (b[i + 1] === 0x0a) ? 2 : 1;
        continue;
      }
      out.push(c);
      i++;
    }
    if (depth !== 0) { throw new Error('文字列が閉じていません（' + start + ' バイト目）'); }
    cursor.pos = i;
    var result = token('string', start, i, Uint8Array.from(out));
    result.hex = false;
    return result;
  }

  /* \n \r \t \b \f */
  var SIMPLE_ESCAPES = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };

  /** バックスラッシュの次の位置から 1 つ読み、次に読む位置を返す。 */
  function readEscape(b, i, end, out) {
    if (i >= end) { return i; }
    var e = b[i];
    if (SIMPLE_ESCAPES[e] !== undefined) { out.push(SIMPLE_ESCAPES[e]); return i + 1; }
    if (e === 0x0d) { return (b[i + 1] === 0x0a) ? i + 2 : i + 1; }   /* 行の継続 */
    if (e === 0x0a) { return i + 1; }
    if (e >= 0x30 && e <= 0x37) {
      var value = 0;
      var n = 0;
      while (n < 3 && i < end && b[i] >= 0x30 && b[i] <= 0x37) {
        value = value * 8 + (b[i] - 0x30);
        i++;
        n++;
      }
      out.push(value & 0xff);
      return i;
    }
    out.push(e);                                   /* \( \) \\ と未知の文字 */
    return i + 1;
  }

  function readHexString(cursor) {
    var b = cursor.bytes;
    var start = cursor.pos;
    var i = start + 1;
    var out = [];
    var high = -1;

    while (i < cursor.end && b[i] !== 0x3e) {
      var v = hexValue(b[i]);
      if (v < 0) {
        if (!isWhite(b[i])) { throw new Error('16 進文字列が不正です（' + i + ' バイト目）'); }
      } else if (high < 0) {
        high = v;
      } else {
        out.push(high * 16 + v);
        high = -1;
      }
      i++;
    }
    if (i >= cursor.end) { throw new Error('16 進文字列が閉じていません（' + start + ' バイト目）'); }
    if (high >= 0) { out.push(high * 16); }
    cursor.pos = i + 1;
    var result = token('string', start, i + 1, Uint8Array.from(out));
    result.hex = true;
    return result;
  }

  function readName(cursor) {
    var b = cursor.bytes;
    var start = cursor.pos;
    var i = start + 1;
    var text = '';
    while (i < cursor.end && isRegular(b[i])) {
      if (b[i] === 0x23 && i + 2 < cursor.end && hexValue(b[i + 1]) >= 0 && hexValue(b[i + 2]) >= 0) {
        text += String.fromCharCode(hexValue(b[i + 1]) * 16 + hexValue(b[i + 2]));
        i += 3;
      } else {
        text += String.fromCharCode(b[i]);
        i++;
      }
    }
    cursor.pos = i;
    return token('name', start, i, text);
  }

  function readNumber(cursor) {
    var b = cursor.bytes;
    var start = cursor.pos;
    var i = start;
    var text = '';
    while (i < cursor.end && (isDigit(b[i]) || b[i] === 0x2b || b[i] === 0x2d || b[i] === 0x2e)) {
      text += String.fromCharCode(b[i]);
      i++;
    }
    cursor.pos = i;
    var value = parseFloat(text);
    var result = token('number', start, i, isNaN(value) ? 0 : value);
    result.integer = /^[+-]?\d+$/.test(text);
    return result;
  }

  function readKeyword(cursor) {
    var b = cursor.bytes;
    var start = cursor.pos;
    var i = start;
    while (i < cursor.end && isRegular(b[i])) { i++; }
    if (i === start) { i++; }                      /* 単独の区切り文字は 1 文字で進める */
    cursor.pos = i;
    var text = '';
    for (var k = start; k < i; k++) { text += String.fromCharCode(b[k]); }
    return token('keyword', start, i, text);
  }

  /** 次の字句を 1 つ読む。終端なら null。 */
  function readToken(cursor) {
    cursor.skipSpace();
    if (cursor.pos >= cursor.end) { return null; }
    var b = cursor.bytes;
    var start = cursor.pos;
    var c = b[start];

    if (c === 0x3c) {
      if (b[start + 1] === 0x3c) { cursor.pos += 2; return token('dictOpen', start, start + 2); }
      return readHexString(cursor);
    }
    if (c === 0x3e) {
      if (b[start + 1] === 0x3e) { cursor.pos += 2; return token('dictClose', start, start + 2); }
      cursor.pos++;
      return token('other', start, start + 1, '>');
    }
    if (c === 0x5b) { cursor.pos++; return token('arrayOpen', start, start + 1); }
    if (c === 0x5d) { cursor.pos++; return token('arrayClose', start, start + 1); }
    if (c === 0x28) { return readLiteralString(cursor); }
    if (c === 0x2f) { return readName(cursor); }
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) { return readNumber(cursor); }
    if (c === 0x29 || c === 0x7b || c === 0x7d) {
      cursor.pos++;
      return token('other', start, start + 1, String.fromCharCode(c));
    }
    return readKeyword(cursor);
  }

  /* ------------------------------------------------------------------ *
   * オブジェクトの解析
   * ------------------------------------------------------------------ */
  function node(kind, value, start, end) {
    return { kind: kind, value: value, start: start, end: end };
  }

  function isInteger(t) {
    return t && t.type === 'number' && t.integer && t.value >= 0;
  }

  /** 数値の直後が「整数 R」なら間接参照として読む。 */
  function numberOrRef(cursor, first) {
    if (isInteger(first)) {
      var save = cursor.pos;
      var second = readToken(cursor);
      if (isInteger(second)) {
        var third = readToken(cursor);
        if (third && third.type === 'keyword' && third.value === 'R') {
          return node(KIND.ref, { num: first.value, gen: second.value }, first.start, third.end);
        }
      }
      cursor.pos = save;
    }
    return node(KIND.number, first.value, first.start, first.end);
  }

  function parseDict(cursor, start, depth) {
    var entries = [];
    var map = Object.create(null);
    for (;;) {
      var key = readToken(cursor);
      if (!key) { throw new Error('辞書が閉じていません（' + start + ' バイト目）'); }
      if (key.type === 'dictClose') {
        return node(KIND.dict, { entries: entries, map: map }, start, key.end);
      }
      if (key.type !== 'name') { throw new Error('辞書のキーが名前ではありません（' + key.start + ' バイト目）'); }
      var value = parseValue(cursor, depth + 1);
      var entry = { key: key.value, keyStart: key.start, value: value };
      entries.push(entry);
      map[key.value] = entry;
    }
  }

  function parseArray(cursor, start, depth) {
    var items = [];
    for (;;) {
      cursor.skipSpace();
      if (cursor.pos >= cursor.end) { throw new Error('配列が閉じていません（' + start + ' バイト目）'); }
      if (cursor.bytes[cursor.pos] === 0x5d) {
        cursor.pos++;
        return node(KIND.array, items, start, cursor.pos);
      }
      items.push(parseValue(cursor, depth + 1));
    }
  }

  /** 値を 1 つ読む（辞書・配列は中まで読む）。 */
  function parseValue(cursor, depth) {
    if (depth > MAX_DEPTH) { throw new Error('入れ子が深すぎます'); }
    var t = readToken(cursor);
    if (!t) { throw new Error('値の途中でデータが終わっています'); }
    switch (t.type) {
      case 'dictOpen': return parseDict(cursor, t.start, depth);
      case 'arrayOpen': return parseArray(cursor, t.start, depth);
      case 'number': return numberOrRef(cursor, t);
      case 'name': return node(KIND.name, t.value, t.start, t.end);
      case 'string': {
        var s = node(KIND.string, t.value, t.start, t.end);
        s.hex = t.hex;
        return s;
      }
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') { return node(KIND.bool, t.value === 'true', t.start, t.end); }
        if (t.value === 'null') { return node(KIND.nil, null, t.start, t.end); }
        return node(KIND.keyword, t.value, t.start, t.end);
      default:
        throw new Error('予期しない記号です（' + t.start + ' バイト目）');
    }
  }

  /** start から end までの範囲で値を 1 つ読む（オブジェクトストリームの中身用）。 */
  function parseValueIn(bytes, start, end) {
    return parseValue(new Cursor(bytes, start, end), 0);
  }

  /* ------------------------------------------------------------------ *
   * 間接オブジェクト（n g obj … endobj）
   * ------------------------------------------------------------------ */
  function eolAfterStreamKeyword(bytes, at) {
    if (bytes[at] === 0x0d && bytes[at + 1] === 0x0a) { return at + 2; }
    if (bytes[at] === 0x0a || bytes[at] === 0x0d) { return at + 1; }
    return at;
  }

  /** データ末尾の直前にある改行 1 つを除いた位置を返す。 */
  function trimEol(bytes, start, end) {
    if (end - 1 >= start && bytes[end - 1] === 0x0a) { end--; }
    if (end - 1 >= start && bytes[end - 1] === 0x0d) { end--; }
    return end;
  }

  /**
   * ストリーム本体の範囲を決める。/Length を信じるが、
   * その先に endstream が無ければ endstream を探して決め直す。
   */
  function locateStream(bytes, afterKeyword, dict, lengthOf) {
    var dataStart = eolAfterStreamKeyword(bytes, afterKeyword);
    var lengthEntry = dict.value.map.Length;
    var length = null;
    if (lengthEntry && lengthEntry.value.kind === KIND.number) {
      length = lengthEntry.value.value;
    } else if (lengthEntry && lengthEntry.value.kind === KIND.ref && lengthOf) {
      length = lengthOf(lengthEntry.value.value);
    }

    if (length !== null && length >= 0 && dataStart + length <= bytes.length) {
      var probe = new Cursor(bytes, dataStart + length);
      probe.skipSpace();
      if (matchesAt(bytes, probe.pos, 'endstream')) {
        return { dataStart: dataStart, dataEnd: dataStart + length, afterEnd: probe.pos + 9, searched: false };
      }
    }
    var found = indexOf(bytes, 'endstream', dataStart);
    if (found < 0) { throw new Error('ストリームの終わり（endstream）が見つかりません'); }
    return { dataStart: dataStart, dataEnd: trimEol(bytes, dataStart, found), afterEnd: found + 9, searched: true };
  }

  /**
   * offset から間接オブジェクトを 1 つ読む。
   * @param {function} [lengthOf] /Length が間接参照のとき、その値を返す（分からなければ null）
   * @returns {{num, gen, start, end, value, stream}}
   */
  function parseIndirectObject(bytes, offset, lengthOf) {
    var cursor = new Cursor(bytes, offset);
    var num = readToken(cursor);
    var gen = readToken(cursor);
    var keyword = readToken(cursor);
    if (!isInteger(num) || !isInteger(gen) || !keyword || keyword.type !== 'keyword' || keyword.value !== 'obj') {
      throw new Error('オブジェクトが見つかりません（' + offset + ' バイト目）');
    }
    var value = parseValue(cursor, 0);
    var result = { num: num.value, gen: gen.value, start: num.start, end: cursor.pos, value: value, stream: null };

    var save = cursor.pos;
    var next = readToken(cursor);
    if (next && next.type === 'keyword' && next.value === 'stream') {
      if (value.kind !== KIND.dict) { throw new Error('ストリームの前に辞書がありません'); }
      result.stream = locateStream(bytes, next.end, value, lengthOf);
      cursor.pos = result.stream.afterEnd;
      save = cursor.pos;
      next = readToken(cursor);
    }
    result.end = (next && next.type === 'keyword' && next.value === 'endobj') ? next.end : save;
    return result;
  }

  /* ------------------------------------------------------------------ *
   * 値の取り出し
   * ------------------------------------------------------------------ */
  function dictGet(dict, key) {
    if (!dict || dict.kind !== KIND.dict) { return null; }
    var entry = dict.value.map[key];
    return entry ? entry.value : null;
  }

  /** 同じキーが複数ある壊れた辞書にも備え、該当するものをすべて返す。 */
  function dictEntries(dict, key) {
    if (!dict || dict.kind !== KIND.dict) { return []; }
    return dict.value.entries.filter(function (entry) { return entry.key === key; });
  }

  function nameOf(value) { return value && value.kind === KIND.name ? value.value : null; }

  function numberOf(value) { return value && value.kind === KIND.number ? value.value : null; }

  function integerOf(value) {
    var n = numberOf(value);
    return n === null ? null : Math.floor(n);
  }

  function refOf(value) { return value && value.kind === KIND.ref ? value.value : null; }

  function numbersOf(value) {
    if (!value || value.kind !== KIND.array) { return []; }
    return value.value.map(function (item) { return item.kind === KIND.number ? item.value : 0; });
  }

  /* ------------------------------------------------------------------ *
   * テキスト文字列（タイトルなど）の符号化
   * ------------------------------------------------------------------ */
  function decodeUtf16(bytes, littleEndian) {
    var text = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(littleEndian
        ? bytes[i] | (bytes[i + 1] << 8)
        : (bytes[i] << 8) | bytes[i + 1]);
    }
    return text.replace(/\u001b[^\u001b]*\u001b/g, '');   /* 言語指定のエスケープを除く */
  }

  /** PDF のテキスト文字列を JavaScript の文字列にする。 */
  function decodeTextString(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { return decodeUtf16(bytes.subarray(2), false); }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { return decodeUtf16(bytes.subarray(2), true); }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    var text = '';
    for (var i = 0; i < bytes.length; i++) {
      var mapped = PDF_DOC_ENCODING[bytes[i]];
      text += String.fromCharCode(mapped === undefined ? bytes[i] : mapped);
    }
    return text;
  }

  /** 文字列を UTF-16BE（BOM 付き）の 16 進文字列 <FEFF…> にする。日本語もそのまま入る。 */
  function encodeTextStringHex(text) {
    var hex = '<FEFF';
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i).toString(16).toUpperCase();
      hex += '0000'.slice(code.length) + code;
    }
    return hex + '>';
  }

  WTC.PdfSyntax = {
    KIND: KIND,
    Cursor: Cursor,
    isWhite: isWhite,
    isDelimiter: isDelimiter,
    isDigit: isDigit,
    matchesAt: matchesAt,
    indexOf: indexOf,
    lastIndexOf: lastIndexOf,
    ascii: ascii,
    readToken: readToken,
    parseValue: parseValue,
    parseValueIn: parseValueIn,
    parseIndirectObject: parseIndirectObject,
    dictGet: dictGet,
    dictEntries: dictEntries,
    nameOf: nameOf,
    numberOf: numberOf,
    integerOf: integerOf,
    refOf: refOf,
    numbersOf: numbersOf,
    decodeTextString: decodeTextString,
    encodeTextStringHex: encodeTextStringHex
  };
}(window));
