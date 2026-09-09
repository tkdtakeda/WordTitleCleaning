/*!
 * saver.js - Word Title Tool
 * 出来上がったファイルの保存だけを担当する層。
 * 1 件なら個別、複数なら ZIP といった振り分けもここで持つ。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var SAVE_GAP_MS = 280;      /* 連続ダウンロード時に間を空ける */
  var REVOKE_AFTER_MS = 60000;

  function delay(milliseconds) {
    return new Promise(function (resolve) { global.setTimeout(resolve, milliseconds); });
  }

  /** ブラウザにファイルを保存させる。 */
  function download(blob, fileName) {
    var url = global.URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, REVOKE_AFTER_MS);
  }

  function zipFileName(settings) {
    var base = WTC.Naming.sanitizePart(settings.zipName) || 'word-titles';
    return base + '.zip';
  }

  function willUseZip(settings, count) {
    return settings.saveMode === 'zip' || (settings.saveMode === 'auto' && count > 1);
  }

  /** 実行前の案内に出す説明文。 */
  function describe(settings, count) {
    return willUseZip(settings, count)
      ? 'ZIP 1 つにまとめて保存します'
      : (count > 1 ? count + ' 件を 1 つずつ保存します' : '1 件を保存します');
  }

  function saveAsZip(results, settings) {
    return Promise.all(results.map(function (result) {
      return result.blob.arrayBuffer().then(function (buffer) {
        /* 中身は既に圧縮済み、または旧形式のバイナリなので再圧縮しない */
        return WTC.Zip.createEntry(result.name, new Uint8Array(buffer), { compress: false });
      });
    })).then(function (entries) {
      var bytes = WTC.Zip.build(entries);
      var name = zipFileName(settings);
      download(new Blob([bytes], { type: 'application/zip' }), name);
      return { kind: 'zip', name: name, count: results.length };
    });
  }

  function saveEachFile(results) {
    return results.reduce(function (chain, result, index) {
      return chain.then(function () {
        download(result.blob, result.name);
        return index < results.length - 1 ? delay(SAVE_GAP_MS) : null;
      });
    }, Promise.resolve()).then(function () {
      return { kind: 'each', count: results.length };
    });
  }

  /**
   * @param {Array}  results  [{ name, blob }]
   * @param {object} settings saveMode / zipName を見る
   */
  function save(results, settings) {
    if (results.length === 0) { return Promise.resolve(null); }
    return willUseZip(settings, results.length)
      ? saveAsZip(results, settings)
      : saveEachFile(results);
  }

  WTC.Saver = {
    download: download,
    zipFileName: zipFileName,
    willUseZip: willUseZip,
    describe: describe,
    save: save
  };
}(window));
