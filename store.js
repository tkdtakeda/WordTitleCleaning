/*!
 * store.js - Word Title Tool
 * 画面状態と設定の保持だけを担当する層。DOM には触れない。
 * 変更は notify() で購読者に通知する。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var STORAGE_KEY = 'wtc.settings.v1';

  var STATUS = {
    pending: 'pending',      /* 待機（解析前） */
    ready: 'ready',          /* 解析済み・変換できる */
    working: 'working',      /* 処理中 */
    done: 'done',            /* 変換済み */
    error: 'error'           /* 読み取れない・変換できない */
  };

  var SAVE_MODE = { auto: 'auto', each: 'each', zip: 'zip' };

  var TITLE_MODE = { clear: 'clear', set: 'set' };

  var DEFAULT_SETTINGS = {
    titleMode: TITLE_MODE.clear,   /* このツールの主目的はタイトルを空にすること */
    nameMode: 'same',
    nameText: '_改',
    namePosition: 'suffix',
    serialStart: 1,
    serialDigits: 3,
    serialSeparator: '_',
    saveMode: SAVE_MODE.auto,
    zipName: 'タイトル処理済み',
    autoRunOnDrop: true,
    showHelpOnStart: true
  };

  /* 保存しない項目（毎回入力してもらう） */
  var VOLATILE_SETTINGS = { title: '' };

  function loadSettings() {
    var stored = null;
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) { stored = JSON.parse(raw); }
    } catch (e) {
      stored = null; /* file:// で localStorage が使えない環境でも動かす */
    }
    return Object.assign({}, DEFAULT_SETTINGS, VOLATILE_SETTINGS, stored || {}, VOLATILE_SETTINGS);
  }

  function Store() {
    this.items = [];
    this.settings = loadSettings();
    this.processing = false;
    this.progress = { done: 0, total: 0 };
    this.lastRemoval = null;
    this.listeners = [];
    this.sequence = 0;
  }

  Store.prototype.subscribe = function (listener) {
    this.listeners.push(listener);
  };

  Store.prototype.notify = function () {
    for (var i = 0; i < this.listeners.length; i++) { this.listeners[i](this); }
  };

  Store.prototype.persist = function () {
    try {
      var toSave = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        toSave[key] = this.settings[key];
      }, this);
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) { /* 保存できない環境ではそのまま動かす */ }
  };

  Store.prototype.updateSettings = function (patch) {
    Object.assign(this.settings, patch);
    this.persist();
    this.notify();
  };

  /* ---------------------------------------------------------------- *
   * 一覧の操作
   * ---------------------------------------------------------------- */
  Store.prototype.addFiles = function (files, options) {
    options = options || {};
    var added = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      this.sequence += 1;
      var item = {
        id: 'item-' + this.sequence,
        file: file,
        name: file.name,
        size: file.size,
        isSample: !!options.isSample,
        status: STATUS.pending,
        currentTitle: null,
        hasCorePart: null,
        alreadyEmpty: null,
        outputName: file.name,
        savedName: null,
        error: null,
        report: null,
        resultBlob: null,
        detailOpen: false
      };
      this.items.push(item);
      added.push(item);
    }
    this.notify();
    return added;
  };

  Store.prototype.find = function (id) {
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].id === id) { return this.items[i]; }
    }
    return null;
  };

  Store.prototype.patchItem = function (id, patch, silent) {
    var item = this.find(id);
    if (!item) { return null; }
    Object.assign(item, patch);
    if (!silent) { this.notify(); }
    return item;
  };

  /** 取り消しできる削除。remove の対象は predicate が true を返した項目。 */
  Store.prototype.removeWhere = function (predicate, label) {
    var kept = [];
    var removed = [];
    for (var i = 0; i < this.items.length; i++) {
      if (predicate(this.items[i])) {
        removed.push({ index: i, item: this.items[i] });
      } else {
        kept.push(this.items[i]);
      }
    }
    if (removed.length === 0) { return null; }
    this.items = kept;
    this.lastRemoval = { entries: removed, label: label || '削除' };
    this.notify();
    return this.lastRemoval;
  };

  Store.prototype.undoRemoval = function () {
    if (!this.lastRemoval) { return false; }
    var entries = this.lastRemoval.entries.slice().sort(function (a, b) {
      return a.index - b.index;
    });
    for (var i = 0; i < entries.length; i++) {
      var at = Math.min(entries[i].index, this.items.length);
      this.items.splice(at, 0, entries[i].item);
    }
    this.lastRemoval = null;
    this.notify();
    return true;
  };

  Store.prototype.clearRemovalHistory = function () {
    this.lastRemoval = null;
  };

  /* ---------------------------------------------------------------- *
   * 集計（画面に件数を出すため、数えるのは必ずこちら側で行う）
   * ---------------------------------------------------------------- */
  Store.prototype.counts = function () {
    var result = {
      total: this.items.length, convertible: 0, error: 0,
      done: 0, sample: 0, pending: 0, needsClearing: 0
    };
    for (var i = 0; i < this.items.length; i++) {
      var item = this.items[i];
      if (item.isSample) { result.sample++; }
      if (item.status === STATUS.error) { result.error++; continue; }
      result.convertible++;
      /* dc:title 要素があるものは、中身が空でも取り除く対象になる */
      if (item.currentTitle !== null) { result.needsClearing++; }
      if (item.status === STATUS.done) { result.done++; }
      if (item.status === STATUS.pending || item.status === STATUS.ready) { result.pending++; }
    }
    return result;
  };

  Store.prototype.convertibleItems = function () {
    return this.items.filter(function (item) { return item.status !== STATUS.error; });
  };

  WTC.STATUS = STATUS;
  WTC.SAVE_MODE = SAVE_MODE;
  WTC.TITLE_MODE = TITLE_MODE;
  WTC.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  WTC.Store = Store;
}(window));
