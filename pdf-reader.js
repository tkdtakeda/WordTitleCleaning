/*!
 * pdf-reader.js - 文書タイトル クリーニング
 * PDF の相互参照（どのオブジェクトがファイルのどこにあるか）を読み、
 * 番号を指定してオブジェクトを取り出せるようにする層。DOM には触れない。
 *
 * 対応する形:
 *  - 従来の相互参照表（xref … trailer）
 *  - 相互参照ストリームとオブジェクトストリーム（PDF 1.5 以降）
 *  - 両方を併せ持つ併用型（Word の「PDF として保存」が出力する形）
 *  - 追記保存で /Prev につながった複数の版
 * 相互参照が壊れているときは、ファイル全体から「n g obj」を拾って組み立て直す。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Syntax = WTC.PdfSyntax;
  var Filters = WTC.PdfFilters;

  var MAX_SECTIONS = 4096;        /* /Prev が循環・暴走したときの上限 */
  var TAIL_SEARCH = 4096;         /* startxref を末尾から探す範囲（バイト） */
  var HEADER_SEARCH = 1024;       /* %PDF- を先頭から探す範囲（バイト） */
  var NEAR_SEARCH = 512;          /* 相互参照の位置が少しずれているときに探す範囲 */

  function streamData(bytes, stream) {
    return bytes.subarray(stream.dataStart, stream.dataEnd);
  }

  function locationKey(location) {
    return location.type === 1
      ? 'o' + location.offset
      : 's' + location.stmOffset + ':' + location.index;
  }

  /* ================================================================== *
   * 文書
   * ================================================================== */
  function PdfDocument(bytes) {
    this.bytes = bytes;
    this.version = null;
    this.startxref = -1;
    this.sections = [];                 /* 新しい版から順に並べた相互参照 */
    this.entries = Object.create(null); /* 合成した相互参照（新しい版が優先） */
    this.trailer = null;                /* 最新の trailer 辞書 */
    this.repaired = false;
    this.repairReason = null;
    this.stmCache = Object.create(null);
  }

  /** 相互参照の種類（画面の根拠表示と、追記するときの形の判断に使う）。 */
  PdfDocument.prototype.xrefKind = function () {
    if (this.repaired || this.sections.length === 0) { return 'repaired'; }
    var latest = this.sections[0];
    if (latest.kind === 'stream') { return 'stream'; }
    return latest.hybrid ? 'hybrid' : 'table';
  };

  /** これまでに使われたオブジェクト番号の次（新しいオブジェクトに振る番号）。 */
  PdfDocument.prototype.nextObjectNumber = function () {
    var size = Syntax.integerOf(Syntax.dictGet(this.trailer, 'Size')) || 0;
    Object.keys(this.entries).forEach(function (key) { size = Math.max(size, Number(key) + 1); });
    return size;
  };

  /** 版 index（0 が最新）以前の相互参照で num を引く。 */
  PdfDocument.prototype.entryAt = function (index, num) {
    for (var k = index; k < this.sections.length; k++) {
      var entry = this.sections[k].entries[num];
      if (entry !== undefined) { return entry; }
    }
    return undefined;
  };

  /**
   * num のオブジェクトが物理的にどこにあるか。
   * @param {number} index 版（-1 なら合成した最新の相互参照）
   * @returns {null|{type:1,offset,num}|{type:2,stmOffset,stmNum,index,num}}
   */
  PdfDocument.prototype.locateAt = function (index, num) {
    var entry = index < 0 ? this.entries[num] : this.entryAt(index, num);
    if (!entry || entry.type === 0) { return null; }
    if (entry.type === 1) { return { type: 1, offset: entry.offset, num: num }; }
    var stm = index < 0 ? this.entries[entry.stm] : this.entryAt(index, entry.stm);
    if (!stm || stm.type !== 1) { return null; }
    return { type: 2, stmOffset: stm.offset, stmNum: entry.stm, index: entry.index, num: num };
  };

  /**
   * num の「すべての版の」実体の場所を返す（同じ場所は 1 回だけ）。
   * 追記保存で残った古い版のタイトルも消すために使う。
   */
  PdfDocument.prototype.copiesOf = function (num) {
    var seen = Object.create(null);
    var copies = [];
    var current = this.locateAt(-1, num);
    var add = function (location) {
      if (!location) { return; }
      var key = locationKey(location);
      if (seen[key]) { return; }
      seen[key] = true;
      location.current = current !== null && locationKey(current) === key;
      copies.push(location);
    };
    add(current);
    for (var k = 0; k < this.sections.length; k++) {
      if (this.sections[k].entries[num] !== undefined) { add(this.locateAt(k, num)); }
    }
    return copies;
  };

  /** /Length が間接参照のときに値を引く関数（引けなければ null）。 */
  PdfDocument.prototype.lengthOf = function () {
    var doc = this;
    return function (ref) {
      var entry = doc.entries[ref.num];
      if (!entry || entry.type !== 1) { return null; }
      try {
        return Syntax.numberOf(Syntax.parseIndirectObject(doc.bytes, entry.offset, null).value);
      } catch (e) {
        return null;
      }
    };
  };

  /** ファイル上の位置からオブジェクトストリームを読み、中身の目次を作る。 */
  PdfDocument.prototype.loadStmAt = function (offset) {
    if (this.stmCache[offset]) { return this.stmCache[offset]; }
    var doc = this;
    var promise = new Promise(function (resolve) {
      resolve(Syntax.parseIndirectObject(doc.bytes, offset, doc.lengthOf()));
    }).then(function (object) {
      var n = Syntax.integerOf(Syntax.dictGet(object.value, 'N'));
      var first = Syntax.integerOf(Syntax.dictGet(object.value, 'First'));
      if (!object.stream || n === null || first === null) {
        throw new Error('オブジェクトストリームとして読めません（' + offset + ' バイト目）');
      }
      return Filters.decode(streamData(doc.bytes, object.stream), object.value).then(function (content) {
        return {
          num: object.num, gen: object.gen, start: object.start, end: object.end,
          content: content, items: readStmHeader(content, n, first)
        };
      });
    });
    this.stmCache[offset] = promise;
    return promise;
  };

  /**
   * 場所を指定してオブジェクトを読む。
   * source は値の位置（start / end）の基準になるバイト列
   * （ファイル本体、またはオブジェクトストリームを展開した中身）。
   */
  PdfDocument.prototype.readAt = function (location) {
    var doc = this;
    if (location.type === 1) {
      return new Promise(function (resolve) {
        var object = Syntax.parseIndirectObject(doc.bytes, location.offset, doc.lengthOf());
        if (object.num !== location.num) {
          throw new Error('オブジェクト ' + location.num + ' の位置が相互参照と一致しません');
        }
        resolve({
          num: object.num, gen: object.gen, value: object.value, stream: object.stream,
          source: doc.bytes, location: location, start: object.start, end: object.end
        });
      });
    }
    return this.loadStmAt(location.stmOffset).then(function (stm) {
      var item = stm.items[location.index];
      if (!item || item.num !== location.num) {
        item = stm.items.filter(function (candidate) { return candidate.num === location.num; })[0];
      }
      if (!item) { throw new Error('オブジェクト ' + location.num + ' がオブジェクトストリームにありません'); }
      return {
        num: item.num, gen: 0, value: Syntax.parseValueIn(stm.content, item.start, item.end), stream: null,
        source: stm.content, location: location, start: item.start, end: item.end
      };
    });
  };

  /** 最新の版でのオブジェクトを読む。無ければ null。 */
  PdfDocument.prototype.getObject = function (num) {
    var location = this.locateAt(-1, num);
    return location ? this.readAt(location) : Promise.resolve(null);
  };

  /** 間接参照なら参照先の値に、そうでなければそのまま返す。 */
  PdfDocument.prototype.resolve = function (value) {
    var ref = Syntax.refOf(value);
    if (!ref) { return Promise.resolve(value); }
    return this.getObject(ref.num).then(function (object) { return object ? object.value : null; });
  };

  /** ストリームの中身を（必要なら展開して）返す。 */
  PdfDocument.prototype.streamBytes = function (object) {
    var data = streamData(object.source, object.stream);
    return Filters.isFiltered(object.value) ? Filters.decode(data, object.value) : Promise.resolve(data);
  };

  /* ================================================================== *
   * 相互参照の読み取り
   * ================================================================== */
  function readStmHeader(content, n, first) {
    var cursor = new Syntax.Cursor(content, 0, first);
    var items = [];
    for (var i = 0; i < n; i++) {
      var num = Syntax.readToken(cursor);
      var offset = Syntax.readToken(cursor);
      if (!num || !offset || num.type !== 'number' || offset.type !== 'number') {
        throw new Error('オブジェクトストリームの目次が不正です');
      }
      items.push({ num: num.value, start: first + offset.value, end: content.length });
    }
    var starts = items.map(function (item) { return item.start; }).sort(function (a, b) { return a - b; });
    items.forEach(function (item) {
      for (var k = 0; k < starts.length; k++) {
        if (starts[k] > item.start) { item.end = starts[k]; break; }
      }
    });
    return items;
  }

  function readVersion(bytes) {
    var at = Syntax.indexOf(bytes, '%PDF-', 0, HEADER_SEARCH);
    if (at < 0) { throw new Error('PDF ではありません（先頭に %PDF- がありません）'); }
    var text = '';
    for (var i = at + 5; i < Math.min(bytes.length, at + 10); i++) {
      if (!Syntax.isDigit(bytes[i]) && bytes[i] !== 0x2e) { break; }
      text += String.fromCharCode(bytes[i]);
    }
    return text || '不明';
  }

  function findStartXref(bytes) {
    var at = Syntax.lastIndexOf(bytes, 'startxref', Math.max(0, bytes.length - TAIL_SEARCH));
    if (at < 0) { at = Syntax.lastIndexOf(bytes, 'startxref'); }
    if (at < 0) { return -1; }
    var value = Syntax.readToken(new Syntax.Cursor(bytes, at + 9));
    return (value && value.type === 'number' && value.integer) ? value.value : -1;
  }

  /** 相互参照の書き出し位置が少しずれていても、近くの xref を拾う。 */
  function sectionStart(bytes, offset) {
    if (offset < 0 || offset >= bytes.length) { throw new Error('相互参照の位置がファイルの範囲外です'); }
    var cursor = new Syntax.Cursor(bytes, offset);
    cursor.skipSpace();
    if (Syntax.matchesAt(bytes, cursor.pos, 'xref') || Syntax.isDigit(bytes[cursor.pos])) { return cursor.pos; }
    var near = Syntax.indexOf(bytes, 'xref', Math.max(0, offset - NEAR_SEARCH), offset + NEAR_SEARCH);
    if (near < 0) { throw new Error('相互参照が見つかりません（' + offset + ' バイト目）'); }
    return near;
  }

  function expectNumber(t) {
    if (!t || t.type !== 'number' || !t.integer) { throw new Error('相互参照表の形式が不正です'); }
    return t.value;
  }

  function readTable(bytes, at) {
    var cursor = new Syntax.Cursor(bytes, at + 4);
    var entries = Object.create(null);
    for (;;) {
      var head = Syntax.readToken(cursor);
      if (!head) { throw new Error('相互参照表が途中で終わっています'); }
      if (head.type === 'keyword' && head.value === 'trailer') { break; }
      var first = expectNumber(head);
      var count = expectNumber(Syntax.readToken(cursor));
      for (var i = 0; i < count; i++) {
        var offset = expectNumber(Syntax.readToken(cursor));
        var gen = expectNumber(Syntax.readToken(cursor));
        var mark = Syntax.readToken(cursor);
        if (!mark || mark.type !== 'keyword' || (mark.value !== 'n' && mark.value !== 'f')) {
          throw new Error('相互参照表の項目が不正です');
        }
        /* 「0 から始まる表」を 1 と書いてしまう出力ソフトの誤りを補正する */
        if (i === 0 && first === 1 && mark.value === 'f' && offset === 0 && gen === 65535) { first = 0; }
        var num = first + i;
        if (entries[num] !== undefined) { continue; }
        entries[num] = (mark.value === 'n' && offset > 0)
          ? { type: 1, offset: offset, gen: gen }
          : { type: 0, gen: gen };
      }
    }
    var trailer = Syntax.parseValue(cursor, 0);
    if (trailer.kind !== Syntax.KIND.dict) { throw new Error('trailer が辞書ではありません'); }
    return { entries: entries, trailer: trailer };
  }

  function readInt(data, at, width) {
    var value = 0;
    for (var i = 0; i < width; i++) { value = value * 256 + data[at + i]; }
    return value;
  }

  function parseXrefRows(data, dict) {
    var w = Syntax.numbersOf(Syntax.dictGet(dict, 'W'));
    if (w.length < 3) { throw new Error('相互参照ストリームの /W が不正です'); }
    var index = Syntax.numbersOf(Syntax.dictGet(dict, 'Index'));
    if (index.length === 0) { index = [0, Syntax.integerOf(Syntax.dictGet(dict, 'Size')) || 0]; }
    var rowLength = w[0] + w[1] + w[2];
    var entries = Object.create(null);
    var row = 0;

    for (var k = 0; k + 1 < index.length; k += 2) {
      for (var i = 0; i < index[k + 1]; i++, row++) {
        var at = row * rowLength;
        if (at + rowLength > data.length) { throw new Error('相互参照ストリームが途中で切れています'); }
        var type = w[0] === 0 ? 1 : readInt(data, at, w[0]);
        var second = readInt(data, at + w[0], w[1]);
        var third = readInt(data, at + w[0] + w[1], w[2]);
        var num = index[k] + i;
        if (entries[num] !== undefined) { continue; }
        if (type === 0) { entries[num] = { type: 0, gen: third }; }
        if (type === 1) { entries[num] = second > 0 ? { type: 1, offset: second, gen: third } : { type: 0, gen: third }; }
        if (type === 2) { entries[num] = { type: 2, stm: second, index: third, gen: 0 }; }
      }
    }
    return entries;
  }

  function readStreamSection(doc, offset) {
    return new Promise(function (resolve) {
      resolve(Syntax.parseIndirectObject(doc.bytes, offset, null));
    }).then(function (object) {
      if (!object.stream || Syntax.nameOf(Syntax.dictGet(object.value, 'Type')) !== 'XRef') {
        throw new Error('相互参照ストリームではありません（' + offset + ' バイト目）');
      }
      return Filters.decode(streamData(doc.bytes, object.stream), object.value).then(function (data) {
        return {
          kind: 'stream', offset: object.start, trailer: object.value,
          entries: parseXrefRows(data, object.value), hybrid: false
        };
      });
    });
  }

  function readSection(doc, offset) {
    var at = sectionStart(doc.bytes, offset);
    if (!Syntax.matchesAt(doc.bytes, at, 'xref')) { return readStreamSection(doc, at); }

    var table = readTable(doc.bytes, at);
    var section = { kind: 'table', offset: at, trailer: table.trailer, entries: table.entries, hybrid: false };
    var stmOffset = Syntax.integerOf(Syntax.dictGet(table.trailer, 'XRefStm'));
    if (!stmOffset) { return Promise.resolve(section); }

    /* 併用型: 表で「空き」になっている番号は、相互参照ストリームの側を使う */
    return readStreamSection(doc, stmOffset).then(function (extra) {
      section.hybrid = true;
      Object.keys(extra.entries).forEach(function (key) {
        var own = section.entries[key];
        if (own === undefined || own.type === 0) { section.entries[key] = extra.entries[key]; }
      });
      return section;
    });
  }

  function loadSections(doc) {
    var visited = Object.create(null);
    var next = function (offset) {
      if (!offset || visited[offset] || doc.sections.length >= MAX_SECTIONS) { return Promise.resolve(); }
      visited[offset] = true;
      return readSection(doc, offset).then(function (section) {
        doc.sections.push(section);
        return next(Syntax.integerOf(Syntax.dictGet(section.trailer, 'Prev')));
      });
    };
    return next(doc.startxref).then(function () {
      if (doc.sections.length === 0) { throw new Error('相互参照が見つかりません'); }
      doc.sections.forEach(function (section) {
        Object.keys(section.entries).forEach(function (key) {
          if (doc.entries[key] === undefined) { doc.entries[key] = section.entries[key]; }
        });
      });
      doc.trailer = doc.sections[0].trailer;
    });
  }

  /** 文書カタログと文書情報辞書が、相互参照どおりの場所で読めるか確かめる。 */
  function checkEssentials(doc) {
    var root = Syntax.refOf(Syntax.dictGet(doc.trailer, 'Root'));
    if (!root) { return Promise.reject(new Error('文書カタログ（/Root）がありません')); }
    var info = Syntax.refOf(Syntax.dictGet(doc.trailer, 'Info'));
    return Promise.all([doc.getObject(root.num), info ? doc.getObject(info.num) : null]).then(function (found) {
      if (!found[0] || found[0].value.kind !== Syntax.KIND.dict) { throw new Error('文書カタログを読めません'); }
    });
  }

  /* ================================================================== *
   * 相互参照が壊れているときの組み立て直し
   * ================================================================== */

  /** 「n g obj」の見出しなら、その先頭位置を返す。 */
  function headerStart(bytes, objAt) {
    var after = bytes[objAt + 3];
    if (after !== undefined && !Syntax.isWhite(after) && !Syntax.isDelimiter(after)) { return -1; }
    var i = objAt - 1;
    var readDigits = function () {
      var end = i;
      while (i >= 0 && Syntax.isDigit(bytes[i])) { i--; }
      return end - i;
    };
    var readWhite = function () {
      var end = i;
      while (i >= 0 && Syntax.isWhite(bytes[i])) { i--; }
      return end - i;
    };
    if (readWhite() === 0 || readDigits() === 0 || readWhite() === 0 || readDigits() === 0) { return -1; }
    if (i >= 0 && !Syntax.isWhite(bytes[i]) && !Syntax.isDelimiter(bytes[i])) { return -1; }
    return i + 1;
  }

  function scanObjects(bytes) {
    var found = { entries: Object.create(null), stms: [], xrefDicts: [] };
    var pos = 0;
    for (;;) {
      var at = Syntax.indexOf(bytes, 'obj', pos);
      if (at < 0) { break; }
      var start = headerStart(bytes, at);
      if (start < 0) { pos = at + 3; continue; }
      try {
        var object = Syntax.parseIndirectObject(bytes, start, null);
        found.entries[object.num] = { type: 1, offset: start, gen: object.gen };
        var type = Syntax.nameOf(Syntax.dictGet(object.value, 'Type'));
        if (object.stream && type === 'ObjStm') { found.stms.push(start); }
        if (object.stream && type === 'XRef') { found.xrefDicts.push(object.value); }
        pos = Math.max(object.end, at + 3);
      } catch (e) {
        pos = at + 3;
      }
    }
    return found;
  }

  /** 見つかった trailer をすべて重ね合わせる（後にあるものが優先）。 */
  function mergeTrailers(bytes, xrefDicts) {
    var dicts = [];
    var pos = 0;
    for (;;) {
      var at = Syntax.indexOf(bytes, 'trailer', pos);
      if (at < 0) { break; }
      try {
        var dict = Syntax.parseValue(new Syntax.Cursor(bytes, at + 7), 0);
        if (dict.kind === Syntax.KIND.dict) { dicts.push(dict); }
      } catch (e) { /* 壊れた trailer は使わない */ }
      pos = at + 7;
    }
    dicts = xrefDicts.concat(dicts);
    if (dicts.length === 0) { return null; }
    var entries = [];
    var map = Object.create(null);
    dicts.forEach(function (dict) {
      dict.value.entries.forEach(function (entry) {
        if (map[entry.key]) { entries.splice(entries.indexOf(map[entry.key]), 1); }
        map[entry.key] = entry;
        entries.push(entry);
      });
    });
    return { kind: Syntax.KIND.dict, value: { entries: entries, map: map }, start: -1, end: -1 };
  }

  function addCompressedEntries(doc, stmOffsets) {
    return stmOffsets.reduce(function (chain, offset) {
      return chain.then(function () {
        return doc.loadStmAt(offset).then(function (stm) {
          stm.items.forEach(function (item, index) {
            if (doc.entries[item.num] === undefined) {
              doc.entries[item.num] = { type: 2, stm: stm.num, index: index, gen: 0 };
            }
          });
        }, function () { /* 読めないオブジェクトストリームは飛ばす */ });
      });
    }, Promise.resolve());
  }

  function repair(doc, reason) {
    doc.repaired = true;
    doc.repairReason = (reason && reason.message) ? reason.message : String(reason);
    doc.sections = [];
    doc.stmCache = Object.create(null);
    var found = scanObjects(doc.bytes);
    doc.entries = found.entries;
    doc.trailer = mergeTrailers(doc.bytes, found.xrefDicts);
    if (!doc.trailer) {
      return Promise.reject(new Error('PDF の構造を読み取れませんでした（' + doc.repairReason + '）'));
    }
    return addCompressedEntries(doc, found.stms).then(function () {
      return checkEssentials(doc);
    }).catch(function (error) {
      throw new Error('PDF の構造を読み取れませんでした（' + doc.repairReason + ' / ' + error.message + '）');
    });
  }

  /* ================================================================== *
   * 公開 API
   * ================================================================== */

  /** バイト列を PDF として開く。相互参照が壊れていれば組み立て直す。 */
  function open(bytes) {
    var doc = new PdfDocument(bytes);
    try {
      doc.version = readVersion(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    doc.startxref = findStartXref(bytes);
    /* 同期的な例外も「組み立て直し」に回すため、必ず Promise の中で読む */
    var loading = Promise.resolve().then(function () {
      if (doc.startxref < 0) { throw new Error('startxref が見つかりません'); }
      return loadSections(doc);
    }).then(function () { return checkEssentials(doc); });

    return loading.catch(function (error) {
      return repair(doc, error);
    }).then(function () { return doc; });
  }

  WTC.PdfReader = {
    open: open,
    locationKey: locationKey
  };
}(window));
