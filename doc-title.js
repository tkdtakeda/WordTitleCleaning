/*!
 * doc-title.js - Word Title Tool
 * 旧形式 .doc のタイトルを読み、空にする層。UI には依存しない。
 *
 * タイトルは OLE2 の \005SummaryInformation ストリームにある
 * プロパティセットの PIDSI_TITLE(0x02) に入っている。
 * 空にするときは、その値をその場で「空文字」に書き換え、
 * 元の文字が入っていたバイトをゼロで塗りつぶす。
 * 長さが変わらないので、他のバイトは 1 つも動かない。
 *
 * タイトルの「設定」には対応しない。文字列の長さが変わると
 * プロパティセットとストリームを作り直すことになり、
 * 旧形式のファイルを壊す危険が高いため。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Ole = WTC.Ole;

  var MODE = { clear: 'clear', set: 'set' };
  var FORMAT = 'doc';
  var DOC_MIME = 'application/msword';

  var SUPPORTED_EXTENSIONS = ['.doc', '.dot'];

  var STREAM = {
    summary: '\u0005SummaryInformation',
    summaryLabel: 'SummaryInformation（名前の先頭に 0x05）',   /* 画面表示用 */
    word: 'WordDocument'
  };

  /* FMTID_SummaryInformation をバイト列で表したもの */
  var FMTID_SUMMARY = [
    0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10,
    0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9
  ];

  var PID = { codePage: 1, title: 2 };
  var VT = { empty: 0, i2: 2, lpstr: 30, lpwstr: 31 };

  /* コードページ番号から TextDecoder のラベルへ */
  var CODEPAGE_LABELS = {
    932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
    1200: 'utf-16le', 1250: 'windows-1250', 1251: 'windows-1251',
    1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
    1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
    1258: 'windows-1258', 10000: 'macintosh', 65001: 'utf-8'
  };

  function hasSupportedExtension(fileName) {
    var lower = String(fileName).toLowerCase();
    for (var i = 0; i < SUPPORTED_EXTENSIONS.length; i++) {
      var ext = SUPPORTED_EXTENSIONS[i];
      if (lower.slice(-ext.length) === ext) { return true; }
    }
    return false;
  }

  function decodeText(bytes, codePage) {
    var label = CODEPAGE_LABELS[codePage] || 'windows-1252';
    try {
      return new TextDecoder(label).decode(bytes);
    } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  /* ------------------------------------------------------------------ *
   * プロパティセットの解析
   * ------------------------------------------------------------------ */
  function findSummarySection(bytes) {
    if (bytes.length < 48) { return null; }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== 0xfffe) { return null; }

    var count = view.getUint32(24, true);
    for (var i = 0; i < count && 28 + i * 20 + 20 <= bytes.length; i++) {
      var at = 28 + i * 20;
      var matched = true;
      for (var k = 0; k < 16; k++) {
        if (bytes[at + k] !== FMTID_SUMMARY[k]) { matched = false; break; }
      }
      if (matched) {
        var offset = view.getUint32(at + 16, true);
        return (offset + 8 <= bytes.length) ? offset : null;
      }
    }
    return null;
  }

  /** セクション内のプロパティ位置表を作る。 */
  function readSectionProperties(bytes, sectionOffset) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var propertyCount = view.getUint32(sectionOffset + 4, true);
    var properties = {};

    for (var i = 0; i < propertyCount; i++) {
      var at = sectionOffset + 8 + i * 8;
      if (at + 8 > bytes.length) { break; }
      var id = view.getUint32(at, true);
      var valueAt = sectionOffset + view.getUint32(at + 4, true);
      if (valueAt + 4 <= bytes.length) { properties[id] = valueAt; }
    }
    return properties;
  }

  function readCodePage(bytes, properties) {
    if (properties[PID.codePage] === undefined) { return 1252; }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var at = properties[PID.codePage];
    if (view.getUint32(at, true) !== VT.i2 || at + 6 > bytes.length) { return 1252; }
    var value = view.getInt16(at + 4, true);
    return value < 0 ? value + 65536 : value;
  }

  /**
   * タイトルの値を読む。
   * @returns {null|{type,valueAt,byteLength,text}} 要素が無ければ null
   */
  function readTitleValue(bytes, properties, codePage) {
    var at = properties[PID.title];
    if (at === undefined) { return null; }

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var type = view.getUint32(at, true);

    if (type === VT.lpstr) {
      var byteCount = view.getUint32(at + 4, true);
      if (at + 8 + byteCount > bytes.length) { return null; }
      var raw = bytes.subarray(at + 8, at + 8 + byteCount);
      var end = raw.indexOf(0);
      return {
        type: type, valueAt: at, byteLength: byteCount,
        text: decodeText(raw.subarray(0, end < 0 ? raw.length : end), codePage)
      };
    }
    if (type === VT.lpwstr) {
      var charCount = view.getUint32(at + 4, true);
      if (at + 8 + charCount * 2 > bytes.length) { return null; }
      var text = '';
      for (var i = 0; i < charCount; i++) {
        var code = view.getUint16(at + 8 + i * 2, true);
        if (code === 0) { break; }
        text += String.fromCharCode(code);
      }
      return { type: type, valueAt: at, byteLength: charCount * 2, text: text };
    }
    if (type === VT.empty) {
      return { type: type, valueAt: at, byteLength: 0, text: '' };
    }
    return null;
  }

  /**
   * タイトルの値を空文字にし、元の文字が入っていたバイトをゼロで埋める。
   * 長さを変えないので、後続プロパティの位置はそのまま使える。
   */
  function blankTitleValue(bytes, value) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var dataAt = value.valueAt + 8;
    var cleared = 0;

    if (value.type === VT.lpstr) {
      view.setUint32(value.valueAt + 4, 1, true);      /* 終端 NUL のみ＝空文字 */
      for (var i = 0; i < value.byteLength; i++) {
        if (bytes[dataAt + i] !== 0) { cleared++; }
        bytes[dataAt + i] = 0;
      }
      return cleared;
    }
    if (value.type === VT.lpwstr) {
      view.setUint32(value.valueAt + 4, 1, true);
      for (var k = 0; k < value.byteLength; k++) {
        if (bytes[dataAt + k] !== 0) { cleared++; }
        bytes[dataAt + k] = 0;
      }
      return cleared;
    }
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */
  function checkWordDocument(container) {
    var word = Ole.findStream(container, STREAM.word);
    if (!word) {
      throw new Error('Word 文書ではありません（WordDocument ストリームが見つかりません）');
    }
    if (word.size >= 12) {
      var head = Ole.readStream(container, word, 12);
      var view = new DataView(head.buffer, head.byteOffset, 12);
      if (view.getUint16(0, true) !== 0xa5ec) {
        throw new Error('Word 文書として読み取れませんでした');
      }
      if (view.getUint16(10, true) & 0x0100) {
        throw new Error('パスワードで保護された文書のため処理できません');
      }
    }
  }

  /** ファイルを解析して現在のタイトルを返す（書き換えはしない）。 */
  function inspect(file) {
    return file.arrayBuffer().then(function (buffer) {
      var container;
      try {
        container = Ole.read(buffer);
      } catch (error) {
        throw new Error('旧形式（.doc）として読み取れませんでした（' + error.message + '）');
      }
      checkWordDocument(container);

      var summary = Ole.findStream(container, STREAM.summary);
      if (!summary) {
        return {
          format: FORMAT, container: container, summary: null,
          currentTitle: null, needsClearing: false,
          codePage: 1252, byteSize: buffer.byteLength
        };
      }
      var bytes = Ole.readStream(container, summary);
      var sectionOffset = findSummarySection(bytes);
      if (sectionOffset === null) {
        return {
          format: FORMAT, container: container, summary: summary,
          currentTitle: null, needsClearing: false,
          codePage: 1252, byteSize: buffer.byteLength
        };
      }
      var properties = readSectionProperties(bytes, sectionOffset);
      var codePage = readCodePage(bytes, properties);
      var value = readTitleValue(bytes, properties, codePage);

      return {
        format: FORMAT,
        container: container,
        summary: summary,
        summaryBytes: bytes,
        titleValue: value,
        currentTitle: value === null ? null : value.text,
        /* 旧形式では項目を消せないので、中身が空なら書き換えても変化しない */
        needsClearing: value !== null && value.text !== '',
        codePage: codePage,
        byteSize: buffer.byteLength
      };
    });
  }

  function unchangedResult(file, info) {
    return {
      blob: file.slice(0, file.size, DOC_MIME),
      report: {
        format: FORMAT, mode: MODE.clear, changed: false,
        titleExisted: info.currentTitle !== null,
        beforeTitle: info.currentTitle, afterTitle: null,
        changedStream: null, clearedByteCount: 0,
        codePage: info.codePage, valueType: null,
        byteSizeBefore: info.byteSize, byteSizeAfter: info.byteSize
      }
    };
  }

  /** タイトルを空にする。要素が無ければ元のファイルをそのまま返す。 */
  function applyClear(file, info) {
    if (!info.needsClearing) {
      return Promise.resolve(unchangedResult(file, info));
    }
    var working = info.summaryBytes.slice();
    var cleared = blankTitleValue(working, info.titleValue);
    var bytes = Ole.replaceStream(info.container, info.summary, working);

    return Promise.resolve({
      blob: new Blob([bytes], { type: DOC_MIME }),
      report: {
        format: FORMAT, mode: MODE.clear, changed: true,
        titleExisted: true,
        beforeTitle: info.currentTitle, afterTitle: '',
        changedStream: STREAM.summaryLabel,
        clearedByteCount: cleared,
        codePage: info.codePage,
        valueType: info.titleValue.type === VT.lpwstr ? 'VT_LPWSTR' : 'VT_LPSTR',
        byteSizeBefore: info.byteSize, byteSizeAfter: bytes.length
      }
    });
  }

  function apply(file, options) {
    options = options || {};
    if (options.mode === MODE.set) {
      return Promise.reject(new Error(
        '.doc（旧形式）ではタイトルの設定に対応していません。「タイトルを空にする」のみ行えます'));
    }
    return inspect(file).then(function (info) { return applyClear(file, info); });
  }

  WTC.DocTitle = {
    FORMAT: FORMAT,
    SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS,
    CAPABILITIES: { clear: true, set: false },
    hasSupportedExtension: hasSupportedExtension,
    inspect: inspect,
    apply: apply
  };
}(window));
