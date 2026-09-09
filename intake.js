/*!
 * intake.js - Word Title Tool
 * 「ファイルがどうやって入ってくるか」だけを担当する層。
 * ファイル選択 / ドラッグ&ドロップ（フォルダー再帰）/ Ctrl+V を扱い、
 * 集めた File を呼び出し側に渡すところまでで役目を終える。
 * 受け取ったあと何をするかは app.js が決める。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var SOURCE = { pick: 'pick', drop: 'drop', paste: 'paste' };

  function byId(id) { return document.getElementById(id); }

  function toArray(list) { return Array.prototype.slice.call(list || []); }

  /* ------------------------------------------------------------------ *
   * ドロップされた項目をたどる
   * ------------------------------------------------------------------ */

  /** 1 項目（ファイルまたはフォルダー）を再帰的にたどって File を集める。 */
  function walkEntry(entry, fromFolder) {
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(
          function (file) { resolve([{ file: file, fromFolder: fromFolder }]); },
          function () { resolve([]); }
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
        }, function () { resolve([]); });
      };
      readBatch();
    });
  }

  /**
   * DataTransfer から File を集める。
   * webkitGetAsEntry が使えない場合は files をそのまま使う。
   */
  function collectDropped(dataTransfer) {
    var plain = toArray(dataTransfer.files).map(function (file) {
      return { file: file, fromFolder: false };
    });
    var items = dataTransfer.items;
    if (!items || items.length === 0 || typeof items[0].webkitGetAsEntry !== 'function') {
      return Promise.resolve(plain);
    }
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry();
      if (entry) { entries.push(entry); }
    }
    if (entries.length === 0) { return Promise.resolve(plain); }
    return Promise.all(entries.map(function (entry) { return walkEntry(entry, false); }))
      .then(function (lists) {
        return lists.reduce(function (all, list) { return all.concat(list); }, []);
      });
  }

  /**
   * フォルダーの中の Word 以外は黙って除く。
   * 直接ドロップされたものは、理由が見えるように残して呼び出し側へ渡す。
   */
  function sortOutFiles(picked) {
    var accepted = [];
    var skipped = 0;
    picked.forEach(function (entry) {
      if (WTC.DocxTitle.hasSupportedExtension(entry.file.name) || !entry.fromFolder) {
        accepted.push(entry.file);
      } else {
        skipped++;
      }
    });
    return { accepted: accepted, skipped: skipped };
  }

  /* ------------------------------------------------------------------ *
   * 画面への結線
   * ------------------------------------------------------------------ */

  /**
   * @param {object} handlers
   *   onFiles(files, meta) … meta = { source, skipped }
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
      handlers.onFiles(files, { source: SOURCE.pick, skipped: 0 });
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
        handlers.onFiles(sorted.accepted, { source: SOURCE.drop, skipped: sorted.skipped });
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
      handlers.onFiles(files, { source: SOURCE.paste, skipped: 0 });
    });
  }

  WTC.Intake = {
    SOURCE: SOURCE,
    bind: bind,
    collectDropped: collectDropped,
    sortOutFiles: sortOutFiles
  };
}(window));
