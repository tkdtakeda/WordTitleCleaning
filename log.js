/*!
 * log.js - Word Title Tool
 * 診断ログ。何が起きたかを画面から追えるように記録しておく層。
 * DOM には触れない。記録するだけで、表示は ui.js が行う。
 *
 * 「なぜそう表示されているか」を後から追えることを目的にしているので、
 * 例外時だけでなく、ドロップの中身や解析の結果も残す。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var VERSION = '2026-09-09.4';       /* 画面と突き合わせて版を確認するための印 */
  var LIMIT = 400;                    /* 古いものから捨てる上限 */

  var LEVEL = { info: 'info', warn: 'warn', error: 'error' };

  var entries = [];

  function timestamp() {
    var now = new Date();
    var pad = function (value, width) {
      var s = String(value);
      while (s.length < width) { s = '0' + s; }
      return s;
    };
    return pad(now.getHours(), 2) + ':' + pad(now.getMinutes(), 2) + ':' +
      pad(now.getSeconds(), 2) + '.' + pad(now.getMilliseconds(), 3);
  }

  function add(level, message, data) {
    entries.push({ time: timestamp(), level: level, message: message, data: data });
    if (entries.length > LIMIT) { entries.splice(0, entries.length - LIMIT); }
  }

  function info(message, data) { add(LEVEL.info, message, data); }
  function warn(message, data) { add(LEVEL.warn, message, data); }
  function error(message, data) { add(LEVEL.error, message, data); }

  function formatData(data) {
    if (data === undefined || data === null) { return ''; }
    try {
      return JSON.stringify(data);
    } catch (e) {
      return String(data);
    }
  }

  var MARKS = { info: '  ', warn: '! ', error: 'x ' };

  /** 貼り付けて渡せる 1 枚のテキストにする。 */
  function toText() {
    var lines = [
      '== Word タイトル クリーニング 診断ログ ==',
      '版: ' + VERSION,
      '出力日時: ' + new Date().toString(),
      ''
    ];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var data = formatData(entry.data);
      lines.push(entry.time + ' ' + (MARKS[entry.level] || '  ') + entry.message + (data ? ' ' + data : ''));
    }
    return lines.join('\n');
  }

  function clear() { entries = []; }

  function all() { return entries; }

  function count() { return entries.length; }

  function problemCount() {
    var n = 0;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].level !== LEVEL.info) { n++; }
    }
    return n;
  }

  WTC.Log = {
    VERSION: VERSION,
    LEVEL: LEVEL,
    info: info,
    warn: warn,
    error: error,
    all: all,
    count: count,
    problemCount: problemCount,
    toText: toText,
    clear: clear
  };
}(window));
