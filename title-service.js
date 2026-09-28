/*!
 * title-service.js - 文書タイトル クリーニング
 * ファイル形式ごとの実装（OOXML / 旧形式 .doc / PDF）を選び分ける窓口。
 * 呼び出し側はこの層だけを見ればよく、形式が増えても手を入れずに済む。
 *
 * 形式は「中身の先頭バイト」で判定する。拡張子だけを信じると、
 * .doc を .docx に付け替えただけのファイルで読み取りに失敗するため。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var MODE = { clear: 'clear', set: 'set' };
  var ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
  var PDF_SIGNATURE = '%PDF-';
  var HEAD_BYTES = 1024;       /* PDF は先頭 1024 バイト以内に %PDF- があればよい決まり */

  var LIMITATION_DOC =
    '旧形式（.doc）は「タイトルを空にする」のみ対応しています。' +
    'タイトルを書き込むには Word で .docx として保存し直してください';

  function handlers() {
    return [WTC.DocxTitle, WTC.DocTitle, WTC.PdfTitle];
  }

  /** この拡張子を扱える実装を返す。無ければ null。 */
  function handlerFor(fileName) {
    var list = handlers();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].hasSupportedExtension(fileName)) { return list[i]; }
    }
    return null;
  }

  function allExtensions() {
    var list = handlers();
    var all = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) { all = all.concat(list[i].SUPPORTED_EXTENSIONS); }
    }
    return all;
  }

  function hasSupportedExtension(fileName) {
    return handlerFor(fileName) !== null;
  }

  function isZip(bytes) {
    if (bytes.length < ZIP_SIGNATURE.length) { return false; }
    for (var i = 0; i < ZIP_SIGNATURE.length; i++) {
      if (bytes[i] !== ZIP_SIGNATURE[i]) { return false; }
    }
    return true;
  }

  function isPdf(bytes) {
    for (var i = 0; i + PDF_SIGNATURE.length <= bytes.length; i++) {
      var matched = true;
      for (var k = 0; k < PDF_SIGNATURE.length; k++) {
        if (bytes[i + k] !== PDF_SIGNATURE.charCodeAt(k)) { matched = false; break; }
      }
      if (matched) { return true; }
    }
    return false;
  }

  /** 中身の先頭バイトから実装を決める。判別できなければ拡張子で決める。 */
  function resolveHandler(file) {
    var byExtension = handlerFor(file.name);
    if (!byExtension) {
      return Promise.reject(new Error(
        '対応していない拡張子です（対応: ' + allExtensions().join(' / ') + '）'));
    }
    return file.slice(0, HEAD_BYTES).arrayBuffer().then(function (head) {
      var bytes = new Uint8Array(head);
      if (WTC.Ole.isOleFile(bytes)) { return WTC.DocTitle; }
      if (isZip(bytes)) { return WTC.DocxTitle; }
      if (isPdf(bytes)) { return WTC.PdfTitle; }
      return byExtension;
    }, function () { return byExtension; });
  }

  /** この形式が、指定した処理に対応しているか（capabilities から判断する）。 */
  function supportsMode(capabilities, mode) {
    if (!capabilities) { return true; }
    return WTC.isWriteMode(mode) ? capabilities.set !== false : capabilities.clear !== false;
  }

  function limitationFor(handler) {
    return handler.CAPABILITIES.set ? null : LIMITATION_DOC;
  }

  /**
   * 解析結果を返す。対応できる処理や制限がファイルごとに変わる形式（PDF）は、
   * 実装が返した値を優先する。
   */
  function inspect(file) {
    return resolveHandler(file).then(function (handler) {
      return handler.inspect(file).then(function (info) {
        return {
          format: handler.FORMAT,
          capabilities: info.capabilities || handler.CAPABILITIES,
          limitation: info.limitation !== undefined ? info.limitation : limitationFor(handler),
          currentTitle: info.currentTitle,
          needsClearing: !!info.needsClearing,
          hasCorePart: info.hasCorePart === undefined ? null : info.hasCorePart,
          byteSize: info.byteSize,
          details: info.details || null
        };
      });
    });
  }

  function apply(file, options) {
    return resolveHandler(file).then(function (handler) {
      return handler.apply(file, options);
    });
  }

  function isEmptyTitle(title) {
    return title === null || title === undefined || title === '';
  }

  WTC.TitleService = {
    MODE: MODE,
    allExtensions: allExtensions,
    handlerFor: handlerFor,
    hasSupportedExtension: hasSupportedExtension,
    supportsMode: supportsMode,
    isEmptyTitle: isEmptyTitle,
    inspect: inspect,
    apply: apply
  };
}(window));
