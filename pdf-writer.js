/*!
 * pdf-writer.js - 文書タイトル クリーニング
 * PDF を書き換える層。やることは次の 3 つだけで、DOM には触れない。
 *
 *   1) 塗りつぶす …… 指定した範囲を同じ長さの空白にする。位置がずれないので、
 *                    相互参照表も他のオブジェクトも一切書き直さずに済む
 *   2) 無効にする …… 使われなくなった古いオブジェクトを「n g obj null endobj」と
 *                    空白に置き換え、中に残っていた文字を消す（長さは同じ）
 *   3) 追記する  …… 新しい版のオブジェクトと相互参照を末尾に足す（PDF 標準の
 *                    追記保存）。元のバイト列はそのまま残る
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Syntax = WTC.PdfSyntax;

  /* 追記する trailer に引き継がない項目（相互参照の作りに関するもの） */
  var TRAILER_SKIP = {
    Size: true, Prev: true, XRefStm: true, Type: true, W: true, Index: true,
    Length: true, Filter: true, DecodeParms: true, F: true, FFilter: true,
    FDecodeParms: true, DL: true
  };

  /* ------------------------------------------------------------------ *
   * バイト列の組み立て
   * ------------------------------------------------------------------ */
  function Chunks() {
    this.parts = [];
    this.length = 0;
  }

  Chunks.prototype.text = function (text) { this.bytes(Syntax.ascii(text)); };

  Chunks.prototype.bytes = function (data) {
    this.parts.push(data);
    this.length += data.length;
  };

  Chunks.prototype.join = function () {
    var out = new Uint8Array(this.length);
    var at = 0;
    this.parts.forEach(function (part) { out.set(part, at); at += part.length; });
    return out;
  };

  function concat(parts) {
    var chunks = new Chunks();
    parts.forEach(function (part) {
      if (typeof part === 'string') { chunks.text(part); } else { chunks.bytes(part); }
    });
    return chunks.join();
  }

  function pad(value, width) {
    var text = String(value);
    while (text.length < width) { text = '0' + text; }
    return text;
  }

  /* ------------------------------------------------------------------ *
   * 同じ長さでの書き換え
   * ------------------------------------------------------------------ */

  /** 元のバイト列の写しに、同じ長さの書き換えを記録しながら施す。 */
  function Patcher(original) {
    this.bytes = original.slice();
    this.changes = [];
  }

  /** start から end までを空白にする。 */
  Patcher.prototype.blank = function (start, end, label) {
    this.bytes.fill(0x20, start, end);
    this.changes.push({ kind: 'blank', start: start, length: end - start, label: label });
  };

  /**
   * start から、同じ長さの別のバイト列で置き換える（塗りつぶし済みの XMP など）。
   * blanked は、そのうち実際に塗りつぶしたバイト数（根拠の表示用）。
   */
  Patcher.prototype.write = function (start, data, label, blanked) {
    this.bytes.set(data, start);
    this.changes.push({ kind: 'blank', start: start, length: blanked, label: label });
  };

  /** 範囲を空白にしてから、先頭に短い文字（例: 空文字列 "()"）を置く。 */
  Patcher.prototype.put = function (start, end, text, label) {
    var data = Syntax.ascii(text);
    if (data.length > end - start) { throw new Error('書き換える領域が足りません'); }
    this.bytes.fill(0x20, start, end);
    this.bytes.set(data, start);
    this.changes.push({ kind: 'blank', start: start, length: end - start, label: label });
  };

  /** 使われなくなったオブジェクト（start から end）を null に置き換える。 */
  Patcher.prototype.nullify = function (object, label) {
    var data = Syntax.ascii(object.num + ' ' + object.gen + ' obj null endobj');
    if (data.length > object.end - object.start) { throw new Error('古いオブジェクトを消去できませんでした'); }
    this.bytes.fill(0x20, object.start, object.end);
    this.bytes.set(data, object.start);
    this.changes.push({ kind: 'nullify', start: object.start, length: object.end - object.start, label: label });
  };

  /* ------------------------------------------------------------------ *
   * 追記保存
   * ------------------------------------------------------------------ */

  /** 番号順に並べ、連続する番号ごとにまとめる（相互参照の小区分）。 */
  function groupRows(rows) {
    var sorted = rows.slice().sort(function (a, b) { return a.num - b.num; });
    var groups = [];
    sorted.forEach(function (row) {
      var last = groups[groups.length - 1];
      if (last && last[last.length - 1].num + 1 === row.num) { last.push(row); } else { groups.push([row]); }
    });
    return groups;
  }

  /** 最新の trailer から引き継ぐ項目（元のバイト列をそのまま使う）と、上書きする項目。 */
  function trailerBody(doc, overrides) {
    var parts = [];
    doc.trailer.value.entries.forEach(function (entry) {
      if (TRAILER_SKIP[entry.key] || overrides[entry.key] !== undefined) { return; }
      parts.push(doc.bytes.subarray(entry.keyStart, entry.value.end));
    });
    Object.keys(overrides).forEach(function (key) { parts.push('/' + key + ' ' + overrides[key]); });
    return parts;
  }

  function writeTable(out, rows, size, doc, overrides, startAt) {
    var xrefAt = startAt + out.length;
    out.text('xref\n');
    groupRows(rows).forEach(function (group) {
      out.text(group[0].num + ' ' + group.length + '\n');
      group.forEach(function (row) { out.text(pad(row.offset, 10) + ' ' + pad(row.gen, 5) + ' n\r\n'); });
    });
    out.text('trailer\n<</Size ' + size);
    trailerBody(doc, overrides).forEach(function (part) {
      if (typeof part === 'string') { out.text(part); } else { out.bytes(part); }
    });
    out.text('/Prev ' + doc.sections[0].offset + '>>\nstartxref\n' + xrefAt + '\n%%EOF\n');
  }

  function writeStream(out, rows, selfNum, doc, overrides, startAt) {
    var selfAt = startAt + out.length;
    var all = rows.concat([{ num: selfNum, gen: 0, offset: selfAt }]);
    var groups = groupRows(all);
    var width = selfAt > 0xffffffff ? 6 : 4;
    var data = new Uint8Array(all.length * (3 + width));
    var at = 0;
    var index = [];
    groups.forEach(function (group) {
      index.push(group[0].num + ' ' + group.length);
      group.forEach(function (row) {
        data[at++] = 1;
        for (var k = width - 1; k >= 0; k--) { data[at + k] = Math.floor(row.offset / Math.pow(256, width - 1 - k)) & 0xff; }
        at += width;
        data[at++] = (row.gen >> 8) & 0xff;
        data[at++] = row.gen & 0xff;
      });
    });

    out.text(selfNum + ' 0 obj\n<</Type/XRef/Size ' + (selfNum + 1) +
      '/W[1 ' + width + ' 2]/Index[' + index.join(' ') + ']');
    trailerBody(doc, overrides).forEach(function (part) {
      if (typeof part === 'string') { out.text(part); } else { out.bytes(part); }
    });
    out.text('/Prev ' + doc.sections[0].offset + '/Length ' + data.length + '>>\nstream\n');
    out.bytes(data);
    out.text('\nendstream\nendobj\nstartxref\n' + selfAt + '\n%%EOF\n');
  }

  /**
   * 追記保存の部分（末尾に足すバイト列）を作る。
   * 相互参照は、元の最新の版と同じ形（表 / ストリーム）で書く。
   * @param {object}     doc        PdfReader で開いた文書
   * @param {Uint8Array} base       追記の前にあるバイト列（塗りつぶし済みの本体）
   * @param {Array}      objects    [{ num, gen, body }] または [{ num, gen, dict, data }]（ストリーム）
   * @param {object}     overrides  trailer で上書きする値 { Info: '12 0 R' }
   */
  function buildUpdate(doc, base, objects, overrides) {
    var out = new Chunks();
    var last = base[base.length - 1];
    if (last !== 0x0a && last !== 0x0d) { out.text('\n'); }

    var rows = [];
    var highest = 0;
    objects.forEach(function (object) {
      rows.push({ num: object.num, gen: object.gen, offset: base.length + out.length });
      highest = Math.max(highest, object.num);
      out.text(object.num + ' ' + object.gen + ' obj\n');
      if (object.data) {
        out.text('<<' + object.dict + '/Length ' + object.data.length + '>>\nstream\n');
        out.bytes(object.data);
        out.text('\nendstream');
      } else {
        out.bytes(object.body);
      }
      out.text('\nendobj\n');
    });

    var size = Math.max(doc.nextObjectNumber(), highest + 1);
    if (doc.sections[0].kind === 'stream') {
      writeStream(out, rows, size, doc, overrides || {}, base.length);
    } else {
      writeTable(out, rows, size, doc, overrides || {}, base.length);
    }
    return out.join();
  }

  WTC.PdfWriter = {
    Patcher: Patcher,
    concat: concat,
    buildUpdate: buildUpdate
  };
}(window));
