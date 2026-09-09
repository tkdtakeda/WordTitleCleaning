/*!
 * zip.js - Word Title Tool
 * ZIP(PKZIP) の読み書きだけを担当する層。DOM には一切触れない。
 *
 * 設計方針:
 *  - 外部ライブラリを使わない。展開/圧縮はブラウザ標準の
 *    DecompressionStream / CompressionStream('deflate-raw') を使う。
 *  - 書き換えないパートは「圧縮済みバイト列のまま」コピーする。
 *    再圧縮しないので、内容がバイト単位で保持される。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var SIG_LOCAL = 0x04034b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_EOCD = 0x06054b50;
  var SIG_ZIP64_LOCATOR = 0x07064b50;

  var MAX_U16 = 0xffff;
  var MAX_U32 = 0xffffffff;

  /* ------------------------------------------------------------------ *
   * CRC-32 (IEEE 802.3)
   * ------------------------------------------------------------------ */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  }());

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function toHex8(value) {
    var s = (value >>> 0).toString(16).toUpperCase();
    while (s.length < 8) { s = '0' + s; }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 動作環境チェック
   * ------------------------------------------------------------------ */
  function checkSupport() {
    var missing = [];
    if (typeof global.DecompressionStream !== 'function') { missing.push('DecompressionStream'); }
    if (typeof global.CompressionStream !== 'function') { missing.push('CompressionStream'); }
    if (typeof global.TextDecoder !== 'function') { missing.push('TextDecoder'); }
    if (typeof global.DOMParser !== 'function') { missing.push('DOMParser'); }
    return { ok: missing.length === 0, missing: missing };
  }

  /* ------------------------------------------------------------------ *
   * 圧縮 / 展開
   * ------------------------------------------------------------------ */
  function pipeThrough(bytes, transform) {
    var stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function inflateRaw(bytes) {
    return pipeThrough(bytes, new global.DecompressionStream('deflate-raw'));
  }

  function deflateRaw(bytes) {
    return pipeThrough(bytes, new global.CompressionStream('deflate-raw'));
  }

  /** エントリの中身を平文の Uint8Array で取り出す。 */
  function readEntryBytes(entry) {
    if (entry.method === 0) { return Promise.resolve(entry.data); }
    if (entry.method === 8) { return inflateRaw(entry.data); }
    return Promise.reject(new Error('未対応の圧縮方式です (method=' + entry.method + ')'));
  }

  /* ------------------------------------------------------------------ *
   * 読み込み
   * ------------------------------------------------------------------ */
  function findEndOfCentralDirectory(view, length) {
    var minPos = Math.max(0, length - (MAX_U16 + 22));
    for (var i = length - 22; i >= minPos; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) { return i; }
    }
    return -1;
  }

  function decodeName(bytes, utf8Flag) {
    try {
      return new TextDecoder(utf8Flag ? 'utf-8' : 'utf-8', { fatal: false }).decode(bytes);
    } catch (e) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
      return s;
    }
  }

  /**
   * ArrayBuffer を解析してエントリ配列を返す。
   * 各エントリの data は「圧縮されたままの生バイト列」。
   */
  function read(buffer) {
    var bytes = new Uint8Array(buffer);
    var view = new DataView(buffer);
    var length = bytes.length;

    if (length < 22) { throw new Error('ZIP 形式ではありません（ファイルが小さすぎます）'); }
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new Error('中身が ZIP ではありません（パスワード保護された文書の可能性があります）');
    }

    var eocd = findEndOfCentralDirectory(view, length);
    if (eocd < 0) { throw new Error('ZIP 形式ではありません（終端レコードが見つかりません）'); }

    var totalEntries = view.getUint16(eocd + 10, true);
    var centralSize = view.getUint32(eocd + 12, true);
    var centralOffset = view.getUint32(eocd + 16, true);

    if (totalEntries === MAX_U16 || centralSize === MAX_U32 || centralOffset === MAX_U32 ||
        (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR)) {
      throw new Error('ZIP64 形式のファイルには対応していません');
    }

    var entries = [];
    var pos = centralOffset;
    for (var n = 0; n < totalEntries; n++) {
      if (pos + 46 > length || view.getUint32(pos, true) !== SIG_CENTRAL) {
        throw new Error('中央ディレクトリが壊れています（' + (n + 1) + ' 件目）');
      }
      var flags = view.getUint16(pos + 8, true);
      if (flags & 0x0001) { throw new Error('暗号化された ZIP には対応していません'); }

      var nameLength = view.getUint16(pos + 28, true);
      var extraLength = view.getUint16(pos + 30, true);
      var commentLength = view.getUint16(pos + 32, true);
      var compressedSize = view.getUint32(pos + 20, true);
      var uncompressedSize = view.getUint32(pos + 24, true);
      var localOffset = view.getUint32(pos + 42, true);

      if (compressedSize === MAX_U32 || uncompressedSize === MAX_U32 || localOffset === MAX_U32) {
        throw new Error('ZIP64 形式のファイルには対応していません');
      }

      var nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);

      if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
        throw new Error('ローカルヘッダーが壊れています');
      }
      var localNameLength = view.getUint16(localOffset + 26, true);
      var localExtraLength = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > length) {
        throw new Error('ファイルが途中で切れています');
      }

      entries.push({
        nameBytes: nameBytes.slice(),
        name: decodeName(nameBytes, (flags & 0x0800) !== 0),
        versionMadeBy: view.getUint16(pos + 4, true),
        versionNeeded: view.getUint16(pos + 6, true),
        flags: flags,
        method: view.getUint16(pos + 10, true),
        time: view.getUint16(pos + 12, true),
        date: view.getUint16(pos + 14, true),
        crc: view.getUint32(pos + 16, true),
        compressedSize: compressedSize,
        uncompressedSize: uncompressedSize,
        internalAttributes: view.getUint16(pos + 36, true),
        externalAttributes: view.getUint32(pos + 38, true),
        data: bytes.slice(dataStart, dataStart + compressedSize)
      });

      pos += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  }

  /* ------------------------------------------------------------------ *
   * 書き出し
   * ------------------------------------------------------------------ */
  function encodeName(name) {
    return new TextEncoder().encode(name);
  }

  function dosDateTime(date) {
    var year = date.getFullYear();
    if (year < 1980) { year = 1980; }
    return {
      date: (((year - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
    };
  }

  /**
   * 平文バイト列から新しいエントリを作る。
   * compress:false を渡すと無圧縮(stored)で格納する。
   */
  function createEntry(name, contentBytes, options) {
    options = options || {};
    var stamp = dosDateTime(options.date || new Date());
    var checksum = crc32(contentBytes);
    var utf8Name = encodeName(name);
    var isAscii = /^[\x20-\x7e]*$/.test(name);

    var finish = function (data, method) {
      return {
        nameBytes: utf8Name,
        name: name,
        versionMadeBy: 20,
        versionNeeded: 20,
        flags: isAscii ? 0 : 0x0800,
        method: method,
        time: stamp.time,
        date: stamp.date,
        crc: checksum,
        compressedSize: data.length,
        uncompressedSize: contentBytes.length,
        internalAttributes: 0,
        externalAttributes: 0,
        data: data
      };
    };

    if (options.compress === false || contentBytes.length === 0) {
      return Promise.resolve(finish(contentBytes, 0));
    }
    return deflateRaw(contentBytes).then(function (deflated) {
      return deflated.length < contentBytes.length
        ? finish(deflated, 8)
        : finish(contentBytes, 0);
    }).catch(function () {
      return finish(contentBytes, 0);
    });
  }

  /** エントリ配列から ZIP のバイト列を組み立てる。 */
  function build(entries) {
    var i, entry;
    var localTotal = 0;
    var centralTotal = 0;
    for (i = 0; i < entries.length; i++) {
      localTotal += 30 + entries[i].nameBytes.length + entries[i].data.length;
      centralTotal += 46 + entries[i].nameBytes.length;
    }

    var out = new Uint8Array(localTotal + centralTotal + 22);
    var view = new DataView(out.buffer);
    var offsets = new Array(entries.length);
    var p = 0;

    for (i = 0; i < entries.length; i++) {
      entry = entries[i];
      offsets[i] = p;
      view.setUint32(p, SIG_LOCAL, true);
      view.setUint16(p + 4, entry.versionNeeded || 20, true);
      view.setUint16(p + 6, entry.flags & ~0x0008, true); /* データ記述子ビットは落とす */
      view.setUint16(p + 8, entry.method, true);
      view.setUint16(p + 10, entry.time, true);
      view.setUint16(p + 12, entry.date, true);
      view.setUint32(p + 14, entry.crc, true);
      view.setUint32(p + 18, entry.data.length, true);
      view.setUint32(p + 22, entry.uncompressedSize, true);
      view.setUint16(p + 26, entry.nameBytes.length, true);
      view.setUint16(p + 28, 0, true);
      p += 30;
      out.set(entry.nameBytes, p); p += entry.nameBytes.length;
      out.set(entry.data, p); p += entry.data.length;
    }

    var centralStart = p;
    for (i = 0; i < entries.length; i++) {
      entry = entries[i];
      view.setUint32(p, SIG_CENTRAL, true);
      view.setUint16(p + 4, entry.versionMadeBy || 20, true);
      view.setUint16(p + 6, entry.versionNeeded || 20, true);
      view.setUint16(p + 8, entry.flags & ~0x0008, true);
      view.setUint16(p + 10, entry.method, true);
      view.setUint16(p + 12, entry.time, true);
      view.setUint16(p + 14, entry.date, true);
      view.setUint32(p + 16, entry.crc, true);
      view.setUint32(p + 20, entry.data.length, true);
      view.setUint32(p + 24, entry.uncompressedSize, true);
      view.setUint16(p + 28, entry.nameBytes.length, true);
      view.setUint16(p + 30, 0, true);
      view.setUint16(p + 32, 0, true);
      view.setUint16(p + 34, 0, true);
      view.setUint16(p + 36, entry.internalAttributes || 0, true);
      view.setUint32(p + 38, entry.externalAttributes || 0, true);
      view.setUint32(p + 42, offsets[i], true);
      p += 46;
      out.set(entry.nameBytes, p); p += entry.nameBytes.length;
    }

    view.setUint32(p, SIG_EOCD, true);
    view.setUint16(p + 4, 0, true);
    view.setUint16(p + 6, 0, true);
    view.setUint16(p + 8, entries.length, true);
    view.setUint16(p + 10, entries.length, true);
    view.setUint32(p + 12, p - centralStart, true);
    view.setUint32(p + 16, centralStart, true);
    view.setUint16(p + 20, 0, true);

    return out;
  }

  WTC.Zip = {
    checkSupport: checkSupport,
    read: read,
    build: build,
    createEntry: createEntry,
    readEntryBytes: readEntryBytes,
    crc32: crc32,
    toHex8: toHex8
  };
}(window));
