/*!
 * title-service.js - Word Title Tool
 * ファイル形式ごとの実装（OOXML / 旧形式 .doc）を選び分ける窓口。
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

  var LIMITATION_DOC =
    '旧形式（.doc）は「タイトルを空にする」のみ対応しています。' +
    '設定するには Word で .docx として保存し直してください';

  function handlers() {
    return [WTC.DocxTitle, WTC.DocTitle];
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

  /** 中身の先頭バイトから実装を決める。判別できなければ拡張子で決める。 */
  function resolveHandler(file) {
    var byExtension = handlerFor(file.name);
    if (!byExtension) {
      return Promise.reject(new Error(
        '対応していない拡張子です（対応: ' + allExtensions().join(' / ') + '）'));
    }
    return file.slice(0, 8).arrayBuffer().then(function (head) {
      var bytes = new Uint8Array(head);
      if (WTC.Ole.isOleFile(bytes)) { return WTC.DocTitle; }
      if (isZip(bytes)) { return WTC.DocxTitle; }
      return byExtension;
    }, function () { return byExtension; });
  }

  /** この形式が、指定した処理に対応しているか（capabilities から判断する）。 */
  function supportsMode(capabilities, mode) {
    if (!capabilities) { return true; }
    return mode === MODE.set ? capabilities.set !== false : capabilities.clear !== false;
  }

  function limitationFor(handler) {
    return handler.CAPABILITIES.set ? null : LIMITATION_DOC;
  }

  function inspect(file) {
    return resolveHandler(file).then(function (handler) {
      return handler.inspect(file).then(function (info) {
        return {
          format: handler.FORMAT,
          capabilities: handler.CAPABILITIES,
          limitation: limitationFor(handler),
          currentTitle: info.currentTitle,
          needsClearing: !!info.needsClearing,
          hasCorePart: info.hasCorePart === undefined ? null : info.hasCorePart,
          byteSize: info.byteSize
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
