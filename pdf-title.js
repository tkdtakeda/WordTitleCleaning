/*!
 * pdf-title.js - 文書タイトル クリーニング
 * PDF の「タイトル」（ブラウザのタブに出る名前）だけを読み書きする層。UI には依存しない。
 *
 * タイトルは PDF の中の 2 か所にある。片方だけ消すとブラウザによって残るので、両方を扱う。
 *   文書情報辞書の /Title …… Edge / Chrome がタブに表示する
 *   XMP メタデータの dc:title …… Firefox が優先して表示する
 *
 *   clear … 該当バイトを同じ長さの空白で塗りつぶす。位置がずれないので、
 *           ファイルの大きさも構造も変わらない。圧縮されていて塗りつぶせない
 *           場所だけ、PDF 標準の追記保存で新しい版を足し、古い中身は無効にして消す
 *   set   … 古いタイトルを同じ方法で消したうえで、新しい値を追記保存で足す
 *
 * どちらも追記保存で残った「過去の版」のタイトルまで消し、最後に出力を
 * 読み直して、期待どおりになっていることを確かめてから返す。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Syntax = WTC.PdfSyntax;
  var Filters = WTC.PdfFilters;
  var Reader = WTC.PdfReader;
  var Writer = WTC.PdfWriter;
  var Xmp = WTC.PdfXmp;
  var KIND = Syntax.KIND;

  var MODE = { clear: 'clear', set: 'set' };
  var FORMAT = 'pdf';
  var CAPABILITIES = { clear: true, set: true };
  var SUPPORTED_EXTENSIONS = ['.pdf'];
  var PDF_MIME = 'application/pdf';
  var XMP_DICT = '/Type/Metadata/Subtype/XML';
  var LINEARIZED_SEARCH = 2048;   /* 線形化の辞書はファイルの先頭にある */

  var MESSAGE = {
    encrypted: 'パスワードまたは暗号化で保護された PDF のため処理できません',
    signed: '電子署名付きの PDF のため処理できません（書き換えると署名が無効になります）',
    repairedSet: 'PDF の相互参照が壊れているため、タイトルの書き込みには対応していません（「タイトルを空にする」は行えます）',
    repairedClear: 'PDF の相互参照が壊れており、圧縮された場所のタイトルを安全に消せないため処理できません'
  };

  /* ------------------------------------------------------------------ *
   * 小さなヘルパー
   * ------------------------------------------------------------------ */
  function hasSupportedExtension(fileName) {
    return /\.pdf$/i.test(String(fileName));
  }

  /** タブの表示を崩す制御文字を取り除く。 */
  function sanitizeTitle(text) {
    return String(text == null ? '' : text).replace(/[\u0000-\u001F\u007F]/g, '');
  }

  function textOf(value) {
    if (value && value.kind === KIND.string) { return Syntax.decodeTextString(value.value); }
    if (value && value.kind === KIND.name) { return value.value; }
    return '';
  }

  /** 配列の要素ごとに、前の処理が終わってから次を行う。 */
  function sequence(list, task) {
    return list.reduce(function (chain, item) {
      return chain.then(function () { return task(item); });
    }, Promise.resolve());
  }

  function ignore() { /* 読めない過去の版は対象にしない */ }

  function uniquePush(list, value) {
    if (list.indexOf(value) < 0) { list.push(value); }
  }

  function streamData(object) {
    return object.source.subarray(object.stream.dataStart, object.stream.dataEnd);
  }

  /* ------------------------------------------------------------------ *
   * 解析
   * ------------------------------------------------------------------ */
  function loadInfo(state) {
    var doc = state.doc;
    var ref = Syntax.refOf(Syntax.dictGet(doc.trailer, 'Info'));
    if (!ref) { return Promise.resolve(); }
    return doc.getObject(ref.num).then(function (object) {
      if (!object || object.value.kind !== KIND.dict) { return null; }
      state.info = { num: object.num, gen: object.gen, object: object, title: null };
      var entries = Syntax.dictEntries(object.value, 'Title');
      if (entries.length === 0) { return null; }
      var value = entries[entries.length - 1].value;
      var target = Syntax.refOf(value);
      if (!target) {
        state.info.title = textOf(value);
        return null;
      }
      return doc.getObject(target.num).then(function (string) {
        state.info.title = textOf(string ? string.value : null);
      });
    });
  }

  function loadCatalog(state) {
    var doc = state.doc;
    return doc.getObject(Syntax.refOf(Syntax.dictGet(doc.trailer, 'Root')).num).then(function (object) {
      state.catalog = object.value;
      return doc.resolve(Syntax.dictGet(object.value, 'ViewerPreferences'));
    }).then(function (preferences) {
      var flag = Syntax.dictGet(preferences, 'DisplayDocTitle');
      state.displayDocTitle = !!(flag && flag.kind === KIND.bool && flag.value);
    });
  }

  function loadXmp(state) {
    var doc = state.doc;
    var ref = Syntax.refOf(Syntax.dictGet(state.catalog, 'Metadata'));
    if (!ref) { return Promise.resolve(); }
    return doc.getObject(ref.num).then(function (object) {
      if (!object || !object.stream) { return null; }
      return doc.streamBytes(object).then(function (data) {
        var text = Xmp.decode(data);
        if (text === null) { throw new Error('XMP メタデータが UTF-8 として読めないため処理できません'); }
        state.xmp = {
          num: object.num, gen: object.gen, object: object, data: data, text: text,
          compressed: Filters.isFiltered(object.value), title: Xmp.readTitle(text)
        };
        state.pdfUa = Xmp.declaresPdfUa(text);
      }, function (error) {
        throw new Error('XMP メタデータを読めないため処理できません（' + error.message + '）');
      });
    });
  }

  /**
   * タイトルが入っている「物理的な場所」をすべて集める（過去の版も含む）。
   * trace = { kind: 'info' | 'string' | 'xmp', num, location, object, entries?, compressed? }
   */
  function findTraces(state) {
    var doc = state.doc;
    var traces = [];
    var infoNums = [];
    var stringNums = [];
    if (state.info) { uniquePush(infoNums, state.info.num); }
    doc.sections.forEach(function (section) {
      var ref = Syntax.refOf(Syntax.dictGet(section.trailer, 'Info'));
      if (ref) { uniquePush(infoNums, ref.num); }
    });

    var visit = function (nums, examine) {
      return sequence(nums, function (num) {
        return sequence(doc.copiesOf(num), function (location) {
          return doc.readAt(location).then(function (object) { return examine(num, location, object); }, ignore);
        });
      });
    };

    return visit(infoNums, function (num, location, object) {
      var entries = Syntax.dictEntries(object.value, 'Title');
      if (object.value.kind !== KIND.dict || entries.length === 0) { return; }
      entries.forEach(function (entry) {
        var ref = Syntax.refOf(entry.value);
        if (ref) { uniquePush(stringNums, ref.num); }
      });
      traces.push({ kind: 'info', num: num, location: location, object: object, entries: entries });
    }).then(function () {
      return visit(stringNums, function (num, location, object) {
        if (object.value.kind !== KIND.string && object.value.kind !== KIND.name) { return; }
        traces.push({ kind: 'string', num: num, location: location, object: object });
      });
    }).then(function () {
      if (!state.xmp) { return null; }
      return visit([state.xmp.num], function (num, location, object) {
        if (location.type !== 1 || !object.stream) { return null; }
        return doc.streamBytes(object).then(function (data) {
          var text = Xmp.decode(data);
          if (text === null || Xmp.readTitle(text) === null) { return; }
          traces.push({
            kind: 'xmp', num: num, location: location, object: object,
            compressed: Filters.isFiltered(object.value)
          });
        }, ignore);
      });
    }).then(function () { state.traces = traces; });
  }

  /** 暗号化・署名の有無を確かめ、タイトルに関わる情報をすべて集める。 */
  function analyze(bytes) {
    return Reader.open(bytes).then(function (doc) {
      if (Syntax.dictGet(doc.trailer, 'Encrypt')) { throw new Error(MESSAGE.encrypted); }
      if (Syntax.indexOf(bytes, '/ByteRange') >= 0) { throw new Error(MESSAGE.signed); }
      var state = {
        doc: doc, info: null, catalog: null, xmp: null, traces: [],
        displayDocTitle: false, pdfUa: false
      };
      return loadInfo(state)
        .then(function () { return loadCatalog(state); })
        .then(function () { return loadXmp(state); })
        .then(function () { return findTraces(state); })
        .then(function () { return state; });
    });
  }

  function infoTitle(state) { return state.info ? state.info.title : null; }

  function xmpTitle(state) { return state.xmp ? state.xmp.title : null; }

  /** 画面に出す「現在のタイトル」。Edge / Chrome が表示する /Title を優先する。 */
  function currentTitle(state) {
    return infoTitle(state) !== null ? infoTitle(state) : xmpTitle(state);
  }

  /** 空にするときに、追記保存が要る場所（圧縮されている場所）があるか。 */
  function clearNeedsAppend(state) {
    return state.traces.some(function (trace) {
      return trace.location.type === 2 || (trace.kind === 'xmp' && trace.compressed && trace.location.current);
    });
  }

  function capabilitiesOf(state) {
    if (!state.doc.repaired) { return { clear: true, set: true }; }
    return { clear: !clearNeedsAppend(state), set: false };
  }

  function limitationOf(state) {
    if (!state.doc.repaired) { return null; }
    return clearNeedsAppend(state) ? MESSAGE.repairedClear : MESSAGE.repairedSet;
  }

  /** Web 表示用の最適化（線形化）がされているか。先頭のオブジェクトに /Linearized が入る決まり。 */
  function isLinearized(bytes) {
    return Syntax.indexOf(bytes, '/Linearized', 0, LINEARIZED_SEARCH) >= 0;
  }

  function detailsOf(state) {
    return {
      linearized: isLinearized(state.doc.bytes),
      infoTitle: infoTitle(state),
      xmpTitle: xmpTitle(state),
      hasInfo: !!state.info,
      hasXmp: !!state.xmp,
      xmpCompressed: !!(state.xmp && state.xmp.compressed),
      displayDocTitle: state.displayDocTitle,
      pdfUa: state.pdfUa,
      version: state.doc.version,
      xrefKind: state.doc.xrefKind(),
      oldRevisionTraces: state.traces.filter(function (trace) { return !trace.location.current; }).length
    };
  }

  /* ------------------------------------------------------------------ *
   * 書き換えの組み立て
   * ------------------------------------------------------------------ */
  function traceLabel(trace, note) {
    var what = { info: '文書情報辞書の /Title', string: '/Title の文字列', xmp: 'XMP の dc:title' }[trace.kind];
    return 'オブジェクト ' + trace.num + '（' + what + (trace.location.current ? '' : '・過去の版') +
      (note ? '・' + note : '') + '）';
  }

  /** 新しいタイトルを入れた文書情報辞書。他の項目は元のバイト列をそのまま使う。 */
  function infoBody(state, title) {
    var parts = ['<</Title ' + Syntax.encodeTextStringHex(title)];
    if (state.info) {
      var source = state.info.object.source;
      state.info.object.value.value.entries.forEach(function (entry) {
        if (entry.key !== 'Title') { parts.push(source.subarray(entry.keyStart, entry.value.end)); }
      });
    }
    parts.push('>>');
    return Writer.concat(parts);
  }

  /** オブジェクトストリームから出し直すオブジェクトの本体（タイトルは取り除く）。 */
  function reemitBody(state, stm, item) {
    var body = stm.content.slice(item.start, item.end);
    var trace = state.traces.filter(function (candidate) {
      return candidate.location.type === 2 && candidate.num === item.num && candidate.object.source === stm.content;
    })[0];
    if (trace && trace.kind === 'info') {
      trace.entries.forEach(function (entry) {
        body.fill(0x20, entry.keyStart - item.start, entry.value.end - item.start);
      });
    } else if (trace && trace.kind === 'string') {
      body = Syntax.ascii('()');
    }
    return body;
  }

  /**
   * 書き換えの計画を立てて実行する。
   * @returns {Promise<{patcher, appended, update}>}
   */
  function build(state, mode, title) {
    var doc = state.doc;
    var patcher = new Writer.Patcher(doc.bytes);
    var appended = [];
    var added = Object.create(null);
    var overrides = {};
    var stmOffsets = [];

    var append = function (object, label) {
      if (added[object.num]) { return; }
      added[object.num] = true;
      object.label = label;
      appended.push(object);
    };

    /* 1) 設定するときは、新しい値を先に決める（同じ番号を二重に出さないため） */
    if (mode === MODE.set) {
      var infoNum = state.info ? state.info.num : doc.nextObjectNumber();
      append({ num: infoNum, gen: state.info ? state.info.gen : 0, body: infoBody(state, title) },
        'オブジェクト ' + infoNum + '（文書情報辞書・新しいタイトル）');
      if (!state.info) { overrides.Info = infoNum + ' 0 R'; }
      if (state.xmp) {
        append({ num: state.xmp.num, gen: state.xmp.gen, dict: XMP_DICT, data: Xmp.encode(Xmp.withTitle(state.xmp.text, title)) },
          'オブジェクト ' + state.xmp.num + '（XMP・新しいタイトル）');
      }
    }

    /* 2) タイトルが入っている場所を 1 つずつ消す */
    state.traces.forEach(function (trace) {
      var label = traceLabel(trace);
      if (trace.location.type === 2) {
        uniquePush(stmOffsets, trace.location.stmOffset);
      } else if (trace.kind === 'info') {
        trace.entries.forEach(function (entry) { patcher.blank(entry.keyStart, entry.value.end, label); });
      } else if (trace.kind === 'string') {
        patcher.put(trace.object.value.start, trace.object.value.end, '()', label);
      } else if (!trace.compressed) {
        var blanked = Xmp.blankTitle(streamData(trace.object));
        patcher.write(trace.object.stream.dataStart, blanked.bytes, label, blanked.blanked);
      } else {
        if (trace.location.current) {
          append({ num: trace.num, gen: trace.object.gen, dict: XMP_DICT, data: Xmp.blankTitle(state.xmp.data).bytes },
            'オブジェクト ' + trace.num + '（XMP・タイトルを除いて非圧縮で出し直し）');
        }
        patcher.nullify(trace.object, traceLabel(trace, '圧縮された古いデータ'));
      }
    });

    /* 3) タイトルを含むオブジェクトストリームを無効にし、今も使われている中身を出し直す */
    return sequence(stmOffsets, function (offset) {
      return doc.loadStmAt(offset).then(function (stm) {
        stm.items.forEach(function (item) {
          var location = doc.locateAt(-1, item.num);
          if (!location || location.type !== 2 || location.stmOffset !== offset) { return; }
          append({ num: item.num, gen: 0, body: reemitBody(state, stm, item) },
            'オブジェクト ' + item.num + '（オブジェクトストリームから出し直し）');
        });
        patcher.nullify(stm, 'オブジェクト ' + stm.num + '（タイトルを含む圧縮オブジェクトストリーム）');
      });
    }).then(function () {
      if (appended.length > 0 && doc.repaired) {
        throw new Error(mode === MODE.set ? MESSAGE.repairedSet : MESSAGE.repairedClear);
      }
      return {
        patcher: patcher,
        appended: appended,
        update: appended.length > 0 ? Writer.buildUpdate(doc, patcher.bytes, appended, overrides) : null
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 出力の確認
   * ------------------------------------------------------------------ */

  /** 出力を読み直し、タイトルが期待どおりか・過去の版に残っていないかを確かめる。 */
  function verify(bytes, before, mode, title) {
    return analyze(bytes).then(function (after) {
      var problems = [];
      if (after.doc.repaired && !before.doc.repaired) { problems.push('相互参照を読み直せません'); }
      if (mode === MODE.clear) {
        if (infoTitle(after) !== null) { problems.push('/Title が残っています'); }
        if (xmpTitle(after) !== null) { problems.push('dc:title が残っています'); }
        if (after.traces.length > 0) { problems.push('タイトルが ' + after.traces.length + ' か所に残っています'); }
      } else {
        if (infoTitle(after) !== title) { problems.push('/Title が指定した値になっていません'); }
        if (after.xmp && xmpTitle(after) !== title) { problems.push('dc:title が指定した値になっていません'); }
        var stale = after.traces.filter(function (trace) { return !trace.location.current; });
        if (stale.length > 0) { problems.push('過去の版にタイトルが ' + stale.length + ' か所残っています'); }
      }
      if (problems.length > 0) {
        throw new Error('出力の確認で問題が見つかったため保存を中止しました（' + problems.join(' / ') + '）');
      }
      return after;
    });
  }

  function report(state, mode, extra) {
    return Object.assign({
      format: FORMAT,
      mode: mode,
      changed: false,
      titleExisted: currentTitle(state) !== null,
      beforeTitle: currentTitle(state),
      afterTitle: null,
      before: { info: infoTitle(state), xmp: xmpTitle(state) },
      after: { info: null, xmp: null },
      method: 'none',
      changes: [],
      appended: [],
      byteSizeBefore: state.doc.bytes.length,
      byteSizeAfter: state.doc.bytes.length,
      details: detailsOf(state),
      verified: false
    }, extra || {});
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */

  /** ファイルを解析して現在のタイトルなどを返す（書き換えはしない）。 */
  function inspect(file) {
    return file.arrayBuffer().then(function (buffer) {
      return analyze(new Uint8Array(buffer));
    }).then(function (state) {
      return {
        currentTitle: currentTitle(state),
        needsClearing: state.traces.length > 0,
        byteSize: state.doc.bytes.length,
        capabilities: capabilitiesOf(state),
        limitation: limitationOf(state),
        details: detailsOf(state)
      };
    });
  }

  /**
   * 新しいファイルの Blob と、根拠レポートを返す。
   * @param {File}   file
   * @param {object} options { mode: 'clear' | 'set', title: string }
   */
  function apply(file, options) {
    options = options || {};
    var mode = options.mode === MODE.set ? MODE.set : MODE.clear;
    var title = sanitizeTitle(options.title);

    return file.arrayBuffer().then(function (buffer) {
      return analyze(new Uint8Array(buffer));
    }).then(function (state) {
      if (mode === MODE.clear && state.traces.length === 0) {
        return { blob: file.slice(0, file.size, PDF_MIME), report: report(state, mode, { verified: true }) };
      }
      if (mode === MODE.set && title === '') { throw new Error('設定するタイトルが空です'); }
      if (mode === MODE.set && state.doc.repaired) { throw new Error(MESSAGE.repairedSet); }

      return build(state, mode, title).then(function (built) {
        var parts = built.update ? [built.patcher.bytes, built.update] : [built.patcher.bytes];
        var output = Writer.concat(parts);
        return verify(output, state, mode, title).then(function (after) {
          return {
            blob: new Blob([output], { type: PDF_MIME }),
            report: report(state, mode, {
              changed: true,
              afterTitle: mode === MODE.set ? title : null,
              after: { info: infoTitle(after), xmp: xmpTitle(after) },
              method: built.update ? 'incremental' : 'in-place',
              changes: built.patcher.changes,
              appended: built.appended.map(function (object) { return { num: object.num, label: object.label }; }),
              byteSizeAfter: output.length,
              verified: true
            })
          };
        });
      });
    });
  }

  WTC.PdfTitle = {
    MODE: MODE,
    FORMAT: FORMAT,
    CAPABILITIES: CAPABILITIES,
    SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS,
    hasSupportedExtension: hasSupportedExtension,
    sanitizeTitle: sanitizeTitle,
    inspect: inspect,
    apply: apply
  };
}(window));
