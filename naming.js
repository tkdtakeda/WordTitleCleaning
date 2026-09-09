/*!
 * naming.js - Word Title Tool
 * 出力ファイル名の組み立てだけを担当する層。DOM には触れない。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  /* Windows のファイル名に使えない文字 */
  var FORBIDDEN_CHARS = /[\\/:*?"<>|]/g;

  var MODE = { same: 'same', text: 'text', serial: 'serial' };
  var POSITION = { suffix: 'suffix', prefix: 'prefix' };

  var DEFAULTS = {
    mode: MODE.same,
    text: '_改',
    position: POSITION.suffix,
    serialStart: 1,
    serialDigits: 3,
    serialSeparator: '_'
  };

  function splitName(fileName) {
    var dot = fileName.lastIndexOf('.');
    if (dot <= 0) { return { base: fileName, extension: '' }; }
    return { base: fileName.slice(0, dot), extension: fileName.slice(dot) };
  }

  /** ファイル名に使えない文字を取り除く。 */
  function sanitizePart(text) {
    return String(text == null ? '' : text).replace(FORBIDDEN_CHARS, '').trim();
  }

  /** sanitizePart で削られる文字が含まれているか。 */
  function hasForbiddenChars(text) {
    FORBIDDEN_CHARS.lastIndex = 0;
    return FORBIDDEN_CHARS.test(String(text == null ? '' : text));
  }

  function padNumber(value, digits) {
    var s = String(value);
    while (s.length < digits) { s = '0' + s; }
    return s;
  }

  function clampInteger(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) { return fallback; }
    return Math.min(max, Math.max(min, n));
  }

  /**
   * 1 件分の出力ファイル名を組み立てる。
   * @param {string} originalName 元のファイル名（拡張子つき）
   * @param {number} index        0 起点の連番用インデックス
   * @param {object} options      DEFAULTS と同じ形
   */
  function buildName(originalName, index, options) {
    var settings = Object.assign({}, DEFAULTS, options || {});
    var parts = splitName(originalName);

    if (settings.mode === MODE.same) { return originalName; }

    var addition;
    if (settings.mode === MODE.serial) {
      var start = clampInteger(settings.serialStart, 0, 999999, DEFAULTS.serialStart);
      var digits = clampInteger(settings.serialDigits, 1, 6, DEFAULTS.serialDigits);
      addition = sanitizePart(settings.serialSeparator) + padNumber(start + index, digits);
    } else {
      addition = sanitizePart(settings.text);
    }

    if (addition === '') { return originalName; }
    return settings.position === POSITION.prefix
      ? addition + parts.base + parts.extension
      : parts.base + addition + parts.extension;
  }

  /**
   * 名前の重複を解消する（同じ名前には (2), (3) … を付ける）。
   * ZIP にまとめる場合も個別保存の場合も、この結果を使う。
   * @param {string[]} names
   * @returns {{names: string[], duplicateCount: number}}
   */
  function resolveDuplicates(names) {
    var seen = Object.create(null);
    var result = [];
    var duplicateCount = 0;

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var key = name.toLowerCase();
      if (seen[key] === undefined) {
        seen[key] = 1;
        result.push(name);
        continue;
      }
      var parts = splitName(name);
      var candidate;
      var candidateKey;
      do {
        seen[key] += 1;
        candidate = parts.base + ' (' + seen[key] + ')' + parts.extension;
        candidateKey = candidate.toLowerCase();
      } while (seen[candidateKey] !== undefined);
      seen[candidateKey] = 1;
      result.push(candidate);
      duplicateCount++;
    }
    return { names: result, duplicateCount: duplicateCount };
  }

  /**
   * 一覧全体の出力名をまとめて作る（重複解消込み）。
   * @param {string[]} originalNames
   * @param {object} options
   */
  function buildAll(originalNames, options) {
    var draft = originalNames.map(function (name, index) {
      return buildName(name, index, options);
    });
    return resolveDuplicates(draft);
  }

  /** 設定の説明文（画面に根拠として出す用）。 */
  function describe(options) {
    var settings = Object.assign({}, DEFAULTS, options || {});
    if (settings.mode === MODE.same) { return '元のファイル名をそのまま使います'; }
    var where = settings.position === POSITION.prefix ? '先頭' : '末尾';
    if (settings.mode === MODE.serial) {
      var digits = clampInteger(settings.serialDigits, 1, 6, DEFAULTS.serialDigits);
      var start = clampInteger(settings.serialStart, 0, 999999, DEFAULTS.serialStart);
      return '拡張子を除いた名前の' + where + 'に「' +
        sanitizePart(settings.serialSeparator) + padNumber(start, digits) + '」から始まる連番を付けます';
    }
    return '拡張子を除いた名前の' + where + 'に「' + sanitizePart(settings.text) + '」を付けます';
  }

  WTC.Naming = {
    MODE: MODE,
    POSITION: POSITION,
    DEFAULTS: DEFAULTS,
    splitName: splitName,
    sanitizePart: sanitizePart,
    hasForbiddenChars: hasForbiddenChars,
    buildName: buildName,
    buildAll: buildAll,
    resolveDuplicates: resolveDuplicates,
    describe: describe
  };
}(window));
