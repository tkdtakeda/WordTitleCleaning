/*!
 * intake.js - Word Title Tool
 * 「ファイルがどうやって入ってくるか」だけを担当する層。
 * ファイル選択 / ドラッグ&ドロップ（フォルダー再帰）/ Ctrl+V を扱い、
 * 集めた File を呼び出し側に渡すところまでで役目を終える。
 * 受け取ったあと何をするかは app.js が決める。
 *
 * ドロップは環境差が出やすいので、受け取った内容を必ず診断ログに残す。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var SOURCE = { pick: 'pick', drop: 'drop', paste: 'paste' };

  /* ファイルが 1 件も取れなかったときの理由 */
  var REASON = {
    ok: 'ok',
    empty: 'empty',           /* ドラッグに項目自体が無い */
    noFileData: 'no-file-data', /* 項目はあるがファイルの実体が渡されない */
    filtered: 'filtered'      /* Word ファイルが無く、すべて除外した */
  };

  function byId(id) { return document.getElementById(id); }

  function toArray(list) { return Array.prototype.slice.call(list || []); }

  function log() { return WTC.Log; }

  /* ------------------------------------------------------------------ *
   * ドロップされた内容の記録
   * ------------------------------------------------------------------ */
  function describeDataTransfer(dataTransfer) {
    var items = [];
    var i;
    if (dataTransfer.items) {
      for (i = 0; i < dataTransfer.items.length; i++) {
        items.push(dataTransfer.items[i].kind + ':' + (dataTransfer.items[i].type || '(型なし)'));
      }
    }
    var files = toArray(dataTransfer.files).map(function (file) {
      return { 名前: file.name, サイズ: file.size, 種類: file.type || '(型なし)' };
    });
    return {
      types: toArray(dataTransfer.types),
      項目数: dataTransfer.items ? dataTransfer.items.length : -1,
      項目: items,
      ファイル数: files.length,
      ファイル: files
    };
  }

  /**
   * ドラッグ項目を 1 つずつ「entry」と「File」の対にして取り出す。
   * どちらも drop の処理中に同期で呼ぶ必要がある。
   * 対にしておけば、どれがフォルダーかを名前で推測せずに判別できる。
   */
  function readItems(dataTransfer) {
    var items = dataTransfer.items;
    var pairs = [];
    var unresolved = 0;
    var canUseEntry = typeof DataTransferItem !== 'undefined' &&
      typeof DataTransferItem.prototype.webkitGetAsEntry === 'function';

    if (!items) { return { pairs: pairs, unresolved: unresolved, canUseEntry: canUseEntry }; }

    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') { continue; }
      var entry = null;
      var file = null;
      if (canUseEntry) {
        try {
          entry = items[i].webkitGetAsEntry();
        } catch (error) {
          log().warn('webkitGetAsEntry が失敗しました', { 位置: i, 理由: String(error && error.message) });
        }
      }
      try {
        file = items[i].getAsFile();
      } catch (error) {
        log().warn('getAsFile が失敗しました', { 位置: i, 理由: String(error && error.message) });
      }
      if (!entry && !file) { unresolved++; continue; }
      pairs.push({ entry: entry, file: file });
    }
    return { pairs: pairs, unresolved: unresolved, canUseEntry: canUseEntry };
  }

  /* ------------------------------------------------------------------ *
   * フォルダーをたどる
   * ------------------------------------------------------------------ */

  /** 1 項目（ファイルまたはフォルダー）を再帰的にたどって File を集める。 */
  function walkEntry(entry, fromFolder) {
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(
          function (file) { resolve([{ file: file, fromFolder: fromFolder }]); },
          function (error) {
            log().warn('ファイルの実体を取得できませんでした',
              { 名前: entry.name, 理由: String(error && (error.message || error.name)) });
            resolve([]);
          }
        );
      });
    }
    var reader = entry.createReader();
    var children = [];
    return new Promise(function (resolve) {
      var readBatch = function () {
        reader.readEntries(function (batch) {
          if (batch.length === 0) {
            Promise.all(children.map(function (child) { return walkEntry(child, true); }))
              .then(function (lists) {
                resolve(lists.reduce(function (all, list) { return all.concat(list); }, []));
              });
            return;
          }
          children = children.concat(toArray(batch));
          readBatch();
        }, function (error) {
          log().warn('フォルダーを読めませんでした',
            { 名前: entry.name, 理由: String(error && (error.message || error.name)) });
          resolve([]);
        });
      };
      readBatch();
    });
  }

  /* ------------------------------------------------------------------ *
   * ドロップ内容の収集
   * ------------------------------------------------------------------ */

  /**
   * ドロップされた内容から File を集める。
   * ファイルの実体は getAsFile()（＝dataTransfer.files と同じもの）を優先し、
   * entry API はフォルダーを広げるためと、実体が取れないときの保険に使う。
   */
  function collectDropped(dataTransfer) {
    log().info('ドロップを受け取りました', describeDataTransfer(dataTransfer));

    var read = readItems(dataTransfer);
    log().info('ドラッグ項目の解決結果', {
      entryAPI: read.canUseEntry ? '使える' : '使えない',
      項目: read.pairs.map(function (pair) {
        var kind = pair.entry
          ? (pair.entry.isDirectory ? 'フォルダー' : 'ファイル')
          : (pair.file ? 'ファイル(entryなし)' : '不明');
        var name = (pair.entry && pair.entry.name) || (pair.file && pair.file.name) || '(名前なし)';
        return '[' + kind + '] ' + name;
      }),
      解決できなかった項目数: read.unresolved
    });

    if (read.pairs.length === 0) {
      /* items が使えない古い経路のための保険 */
      var plain = toArray(dataTransfer.files);
      if (plain.length > 0) {
        log().warn('items から取れなかったため dataTransfer.files を使います', { 件数: plain.length });
        return Promise.resolve(plain.map(function (file) {
          return { file: file, fromFolder: false };
        }));
      }
      log().error('ファイルの実体をひとつも受け取れませんでした', {
        ヒント: 'メールの添付や ZIP の中、ネットワーク上の場所からのドラッグでは実体が渡らないことがあります'
      });
      return Promise.resolve([]);
    }

    var tasks = read.pairs.map(function (pair) {
      if (pair.entry && pair.entry.isDirectory) {
        return walkEntry(pair.entry, false);        /* 中身は fromFolder=true になる */
      }
      if (pair.file) {
        return Promise.resolve([{ file: pair.file, fromFolder: false }]);
      }
      return walkEntry(pair.entry, false);          /* 実体が取れないときだけ entry から */
    });

    return Promise.all(tasks).then(function (lists) {
      var picked = lists.reduce(function (all, list) { return all.concat(list); }, []);
      log().info('取り込む候補がそろいました', {
        件数: picked.length,
        名前: picked.slice(0, 30).map(function (item) { return item.file.name; })
      });
      return picked;
    });
  }

  /**
   * フォルダーの中は Word ファイル（.doc を含む）だけを拾う。
   * 直接ドロップされたものは、理由が見えるようにすべて呼び出し側へ渡す。
   */
  function sortOutFiles(picked) {
    var accepted = [];
    var skippedNames = [];
    picked.forEach(function (entry) {
      if (WTC.TitleService.hasSupportedExtension(entry.file.name) || !entry.fromFolder) {
        accepted.push(entry.file);
      } else {
        skippedNames.push(entry.file.name);
      }
    });
    return { accepted: accepted, skipped: skippedNames.length, skippedNames: skippedNames };
  }

  function reasonFor(picked, sorted) {
    if (sorted.accepted.length > 0) { return REASON.ok; }
    if (picked.length > 0) { return REASON.filtered; }
    return REASON.noFileData;
  }

  /* ------------------------------------------------------------------ *
   * 画面への結線
   * ------------------------------------------------------------------ */

  /**
   * @param {object} handlers
   *   onFiles(files, meta) … meta = { source, skipped, skippedNames, reason }
   *   veilText()           … ドロップ中に出す補足文を返す
   */
  function bind(handlers) {
    bindFilePicker(handlers);
    bindDragAndDrop(handlers);
    bindPaste(handlers);
  }

  function bindFilePicker(handlers) {
    var input = byId('file-input');
    byId('btn-pick').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var files = toArray(input.files);
      input.value = '';                       /* 同じファイルを続けて選べるようにする */
      log().info('ファイル選択から追加', {
        件数: files.length,
        名前: files.map(function (f) { return f.name; })
      });
      handlers.onFiles(files, { source: SOURCE.pick, skipped: 0, skippedNames: [], reason: REASON.ok });
    });
  }

  function bindDragAndDrop(handlers) {
    var veil = byId('dropveil');
    var depth = 0;

    var show = function () {
      byId('dropveil-sub').textContent = handlers.veilText();
      veil.hidden = false;
    };
    var hide = function () { depth = 0; veil.hidden = true; };

    global.addEventListener('dragenter', function (event) {
      event.preventDefault();
      depth++;
      show();
    });
    global.addEventListener('dragover', function (event) { event.preventDefault(); });
    global.addEventListener('dragleave', function (event) {
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) { hide(); }
    });
    global.addEventListener('drop', function (event) {
      event.preventDefault();
      hide();
      collectDropped(event.dataTransfer).then(function (picked) {
        var sorted = sortOutFiles(picked);
        if (sorted.skipped > 0) {
          log().info('Word 以外を除外しました',
            { 件数: sorted.skipped, 名前: sorted.skippedNames.slice(0, 20) });
        }
        handlers.onFiles(sorted.accepted, {
          source: SOURCE.drop,
          skipped: sorted.skipped,
          skippedNames: sorted.skippedNames,
          reason: reasonFor(picked, sorted)
        });
      }, function (error) {
        log().error('ドロップの処理中にエラーが発生しました', { 理由: String(error && error.message) });
        handlers.onFiles([], {
          source: SOURCE.drop, skipped: 0, skippedNames: [], reason: REASON.noFileData
        });
      });
    });
  }

  function bindPaste(handlers) {
    document.addEventListener('paste', function (event) {
      var tag = (event.target && event.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
      var files = toArray(event.clipboardData && event.clipboardData.files);
      if (files.length === 0) { return; }
      event.preventDefault();
      log().info('貼り付けから追加', {
        件数: files.length,
        名前: files.map(function (f) { return f.name; })
      });
      handlers.onFiles(files, { source: SOURCE.paste, skipped: 0, skippedNames: [], reason: REASON.ok });
    });
  }

  WTC.Intake = {
    SOURCE: SOURCE,
    REASON: REASON,
    bind: bind,
    collectDropped: collectDropped,
    sortOutFiles: sortOutFiles
  };
}(window));
