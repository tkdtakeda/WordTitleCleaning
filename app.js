/*!
 * app.js - Word Title Tool
 * 画面と各層をつなぐ制御役。状態は Store、描画は UI、
 * 変換は DocxTitle、名前は Naming に任せる。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC;
  var UI = WTC.UI;
  var Zip = WTC.Zip;
  var DocxTitle = WTC.DocxTitle;
  var Naming = WTC.Naming;
  var Samples = WTC.Samples;
  var STATUS = WTC.STATUS;

  var $ = UI.$;
  var store = new WTC.Store();
  var rowCache = Object.create(null);
  var PLACEHOLDER_NAMES = ['報告書.docx', '議事録.docx'];

  /* ================================================================ *
   * 共通ユーティリティ
   * ================================================================ */
  function messageOf(error) {
    return (error && error.message) ? error.message : String(error);
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) { global.setTimeout(resolve, milliseconds); });
  }

  function downloadBlob(blob, fileName) {
    var url = global.URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 60000);
  }

  /* ================================================================ *
   * 出力ファイル名の再計算
   * ================================================================ */
  function namingOptions() {
    var settings = store.settings;
    return {
      mode: settings.nameMode,
      text: settings.nameText,
      position: settings.namePosition,
      serialStart: settings.serialStart,
      serialDigits: settings.serialDigits,
      serialSeparator: settings.serialSeparator
    };
  }

  /**
   * 「次に実行したときの出力名」を常に最新の設定で計算し直す。
   * 実際に保存した名前は savedName に別で残るので、上書きしても履歴は消えない。
   */
  function recomputeOutputNames() {
    var targets = store.items.filter(function (item) { return item.status !== STATUS.error; });
    var built = Naming.buildAll(targets.map(function (item) { return item.name; }), namingOptions());
    targets.forEach(function (item, index) { item.outputName = built.names[index]; });
  }

  function previewNames() {
    var targets = store.items.filter(function (item) { return item.status !== STATUS.error; });
    if (targets.length === 0) {
      return Naming.buildAll(PLACEHOLDER_NAMES, namingOptions()).names.map(function (name) {
        return '例）' + name;
      });
    }
    return targets.slice(0, 3).map(function (item) { return item.outputName; })
      .concat(targets.length > 3 ? ['… ほか ' + (targets.length - 3) + ' 件'] : []);
  }

  /* ================================================================ *
   * 実行できるかの判定（件数はすべてここで数える）
   * ================================================================ */
  function willUseZip(count) {
    var mode = store.settings.saveMode;
    return mode === 'zip' || (mode === 'auto' && count > 1);
  }

  function describeSave(count) {
    return willUseZip(count)
      ? 'ZIP 1 つにまとめて保存します'
      : (count > 1 ? count + ' 件を 1 つずつ保存します' : '1 件を保存します');
  }

  function evaluateRun() {
    var counts = store.counts();
    var title = store.settings.title.trim();
    var defaultLabel = 'タイトルを設定して保存';

    if (store.processing) {
      return {
        canRun: false, tone: 'info', progress: store.progress,
        message: 'タイトルを書き換えています',
        buttonLabel: '処理中…'
      };
    }
    var reading = store.items.filter(function (item) { return item.status === STATUS.pending; }).length;
    if (reading > 0) {
      return {
        canRun: false, tone: 'info',
        message: reading + ' 件を読み取っています。少しお待ちください',
        buttonLabel: defaultLabel
      };
    }
    if (counts.total === 0) {
      return {
        canRun: false, tone: 'neutral',
        message: 'ファイルがありません。ドロップするか「ファイルを選ぶ」で追加してください',
        buttonLabel: defaultLabel
      };
    }
    if (title === '') {
      return {
        canRun: false, tone: 'warn',
        message: 'タイトルが未入力です。右の「設定するタイトル」に入れてください',
        buttonLabel: defaultLabel
      };
    }
    if (counts.convertible === 0) {
      return {
        canRun: false, tone: 'error',
        message: '全 ' + counts.error + ' 件が読み取れないファイルです。各行の目のアイコンで理由を確認できます',
        buttonLabel: defaultLabel
      };
    }
    return {
      canRun: true,
      tone: counts.error > 0 ? 'warn' : 'info',
      message: counts.convertible + ' 件に「' + title + '」を設定します。' + describeSave(counts.convertible) +
        (counts.error > 0 ? '（読み取れない ' + counts.error + ' 件は対象外）' : ''),
      buttonLabel: counts.convertible + ' 件のタイトルを設定して保存'
    };
  }

  /* ================================================================ *
   * 再描画
   * ================================================================ */
  function refresh() {
    recomputeOutputNames();
    UI.renderList(store, rowCache);
    UI.renderCounts(store.counts());
    UI.renderTitlePanel(store.settings.title);
    UI.renderNamingPanel(store.settings, previewNames());
    UI.renderSavePanel(store.settings);
    $('zipname-hint').textContent = '保存名: ' + zipFileName();
    $('dropzone').classList.toggle('is-compact', store.items.length > 0);
    UI.renderAction(evaluateRun());
  }

  /* ================================================================ *
   * ファイルの取り込み
   * ================================================================ */
  function inspectItems(items) {
    return items.reduce(function (chain, item) {
      return chain.then(function () {
        return DocxTitle.inspect(item.file).then(function (info) {
          store.patchItem(item.id, {
            status: STATUS.ready,
            currentTitle: info.currentTitle,
            hasCorePart: info.hasCorePart
          });
        }, function (error) {
          store.patchItem(item.id, { status: STATUS.error, error: messageOf(error) });
        });
      });
    }, Promise.resolve());
  }

  function intake(files, options) {
    if (files.length === 0) { return Promise.resolve([]); }
    var added = store.addFiles(files, options);
    return inspectItems(added).then(function () { return added; });
  }

  /** ドロップされた項目を再帰的にたどって File を集める。 */
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
          children = children.concat(Array.prototype.slice.call(batch));
          readBatch();
        }, function () { resolve([]); });
      };
      readBatch();
    });
  }

  function collectDropped(dataTransfer) {
    var plain = Array.prototype.slice.call(dataTransfer.files || []).map(function (file) {
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
   * 直接ドロップされたものは、理由が見えるように一覧へ入れる。
   */
  function sortOutFiles(picked) {
    var accepted = [];
    var skipped = 0;
    picked.forEach(function (entry) {
      if (DocxTitle.hasSupportedExtension(entry.file.name) || !entry.fromFolder) {
        accepted.push(entry.file);
      } else {
        skipped++;
      }
    });
    return { accepted: accepted, skipped: skipped };
  }

  /* ================================================================ *
   * 変換と保存
   * ================================================================ */
  function zipFileName() {
    var base = Naming.sanitizePart(store.settings.zipName) || 'word-titles';
    return base + '.zip';
  }

  function saveAsZip(results) {
    return Promise.all(results.map(function (result) {
      return result.blob.arrayBuffer().then(function (buffer) {
        /* docx は既に圧縮済みなので、再圧縮せず格納する */
        return Zip.createEntry(result.name, new Uint8Array(buffer), { compress: false });
      });
    })).then(function (entries) {
      var bytes = Zip.build(entries);
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), zipFileName());
      return { kind: 'zip', name: zipFileName(), count: results.length };
    });
  }

  function saveEachFile(results) {
    return results.reduce(function (chain, result, index) {
      return chain.then(function () {
        downloadBlob(result.blob, result.name);
        return index < results.length - 1 ? delay(280) : null;
      });
    }, Promise.resolve()).then(function () {
      return { kind: 'each', count: results.length };
    });
  }

  function save(results) {
    if (results.length === 0) { return Promise.resolve(null); }
    return willUseZip(results.length) ? saveAsZip(results) : saveEachFile(results);
  }

  function run(items) {
    var title = store.settings.title.trim();
    var targets = items.filter(function (item) { return item.status !== STATUS.error; });
    if (targets.length === 0 || title === '') { return Promise.resolve(); }

    recomputeOutputNames();
    var plan = targets.map(function (item) { return { item: item, name: item.outputName }; });

    store.processing = true;
    store.progress = { done: 0, total: plan.length };
    refresh();

    var results = [];
    var failed = 0;

    return plan.reduce(function (chain, step, index) {
      return chain.then(function () {
        store.patchItem(step.item.id, { status: STATUS.working }, true);
        refresh();
        return DocxTitle.applyTitle(step.item.file, title).then(function (output) {
          store.patchItem(step.item.id, {
            status: STATUS.done,
            report: output.report,
            resultBlob: output.blob,
            savedName: step.name,
            currentTitle: output.report.afterTitle
          }, true);
          results.push({ name: step.name, blob: output.blob });
        }, function (error) {
          failed++;
          store.patchItem(step.item.id, { status: STATUS.error, error: messageOf(error) }, true);
        }).then(function () {
          store.progress = { done: index + 1, total: plan.length };
          refresh();
        });
      });
    }, Promise.resolve()).then(function () {
      return save(results);
    }).then(function (saved) {
      store.processing = false;
      refresh();
      reportResult(saved, results.length, failed);
    }, function (error) {
      store.processing = false;
      refresh();
      UI.showToast({ tone: 'error', message: '保存に失敗しました: ' + messageOf(error), duration: 12000 });
    });
  }

  function reportResult(saved, successCount, failedCount) {
    if (successCount === 0) {
      UI.showToast({ tone: 'error', message: '変換できたファイルがありませんでした', duration: 10000 });
      return;
    }
    var message = saved.kind === 'zip'
      ? successCount + ' 件を「' + saved.name + '」にまとめて保存しました'
      : successCount + ' 件を保存しました';
    if (failedCount > 0) { message += '（' + failedCount + ' 件は失敗。一覧の理由を確認してください）'; }
    UI.showToast({ tone: failedCount > 0 ? 'warn' : 'ok', message: message, duration: 10000 });
  }

  /* ================================================================ *
   * 取り消しできる削除
   * ================================================================ */
  function removeWithUndo(predicate, buildMessage) {
    var removal = store.removeWhere(predicate);
    if (!removal) { return; }
    var count = removal.entries.length;
    removal.entries.forEach(function (entry) { delete rowCache[entry.item.id]; });
    UI.showToast({
      tone: 'ok',
      message: buildMessage(count),
      actionLabel: '取り消す',
      duration: 10000,
      onAction: function () { store.undoRemoval(); }
    });
  }

  /* ================================================================ *
   * 入力欄の使い勝手
   * ================================================================ */
  function focusNext(current) {
    var focusable = Array.prototype.slice.call(
      document.querySelectorAll('input:not([hidden]):not([type="file"]), button:not([disabled])')
    ).filter(function (node) { return node.offsetParent !== null; });
    var index = focusable.indexOf(current);
    if (index >= 0 && index + 1 < focusable.length) { focusable[index + 1].focus(); }
  }

  function enhanceInput(input, onEnter) {
    input.addEventListener('focus', function () { input.select(); });
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') { return; }
      event.preventDefault();
      if (onEnter) { onEnter(); } else { focusNext(input); }
    });
    if (input.dataset.advance === '1') {
      input.addEventListener('input', function () {
        if (input.value.length >= Number(input.maxLength)) { focusNext(input); }
      });
    }
  }

  function bindNumericInput(input, key, min, max) {
    enhanceInput(input);
    input.addEventListener('input', function () {
      var digits = input.value.replace(/[^0-9]/g, '');
      if (digits !== input.value) { input.value = digits; }
      var value = parseInt(digits, 10);
      if (isNaN(value)) { return; }
      store.updateSettings(makePatch(key, Math.min(max, Math.max(min, value))));
    });
    input.addEventListener('blur', function () {
      var value = parseInt(input.value, 10);
      if (isNaN(value)) { value = store.settings[key]; }
      value = Math.min(max, Math.max(min, value));
      input.value = String(value);
      store.updateSettings(makePatch(key, value));
    });
  }

  function makePatch(key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  }

  function bindRadioGroup(name, key) {
    var radios = document.querySelectorAll('input[name="' + name + '"]');
    Array.prototype.forEach.call(radios, function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) { store.updateSettings(makePatch(key, radio.value)); }
      });
    });
  }

  function setRadio(name, value) {
    var radio = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (radio) { radio.checked = true; }
  }

  /* ================================================================ *
   * サンプルデータ
   * ================================================================ */
  function renderSampleList() {
    var container = $('samplelist');
    container.textContent = '';
    Samples.CATALOG.forEach(function (sample) {
      var label = UI.el('label', 'sample');
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = sample.id;
      checkbox.checked = true;
      label.appendChild(checkbox);
      var body = UI.el('span');
      body.appendChild(UI.el('span', 'sample__title', sample.label));
      body.appendChild(document.createElement('br'));
      body.appendChild(UI.el('span', 'sample__desc', sample.note));
      label.appendChild(body);
      container.appendChild(label);
    });
  }

  function loadSamples() {
    var checked = Array.prototype.slice.call($('samplelist').querySelectorAll('input:checked'))
      .map(function (input) { return input.value; });
    if (checked.length === 0) {
      UI.showToast({ tone: 'warn', message: '読み込むサンプルが選ばれていません', duration: 6000 });
      return;
    }
    $('btn-load-samples').disabled = true;
    Samples.create(checked).then(function (files) {
      return intake(files, { isSample: true });
    }).then(function (added) {
      UI.showToast({ tone: 'ok', message: 'サンプルを ' + added.length + ' 件読み込みました', duration: 7000 });
    }).catch(function (error) {
      UI.showToast({ tone: 'error', message: 'サンプルを作れませんでした: ' + messageOf(error), duration: 10000 });
    }).then(function () {
      $('btn-load-samples').disabled = false;
    });
  }

  function bindSamples() {
    $('btn-load-samples').addEventListener('click', loadSamples);
    $('btn-clear-samples-2').addEventListener('click', clearSamples);
  }

  function clearSamples() {
    removeWithUndo(
      function (item) { return item.isSample; },
      function (count) { return 'サンプルデータ ' + count + ' 件を一覧から消しました'; }
    );
  }

  /* ================================================================ *
   * イベントの結線
   * ================================================================ */
  function bindSettings() {
    var settings = store.settings;

    var titleInput = $('input-title');
    titleInput.value = settings.title;
    titleInput.addEventListener('input', function () {
      store.updateSettings({ title: DocxTitle.sanitizeTitle(titleInput.value) });
    });
    titleInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') { return; }
      event.preventDefault();
      if (evaluateRun().canRun) { run(store.convertibleItems()); } else { $('btn-pick').focus(); }
    });

    var nameTextInput = $('input-name-text');
    nameTextInput.value = settings.nameText;
    enhanceInput(nameTextInput);
    nameTextInput.addEventListener('input', function () {
      store.updateSettings({ nameText: nameTextInput.value });
    });

    var separatorInput = $('input-serial-sep');
    separatorInput.value = settings.serialSeparator;
    enhanceInput(separatorInput);
    separatorInput.addEventListener('input', function () {
      store.updateSettings({ serialSeparator: separatorInput.value });
    });

    var startInput = $('input-serial-start');
    startInput.value = String(settings.serialStart);
    bindNumericInput(startInput, 'serialStart', 0, 999999);

    var digitsInput = $('input-serial-digits');
    digitsInput.value = String(settings.serialDigits);
    bindNumericInput(digitsInput, 'serialDigits', 1, 6);

    var zipNameInput = $('input-zip-name');
    zipNameInput.value = settings.zipName;
    enhanceInput(zipNameInput);
    zipNameInput.addEventListener('input', function () {
      store.updateSettings({ zipName: zipNameInput.value });
    });

    setRadio('name-mode', settings.nameMode);
    setRadio('name-position', settings.namePosition);
    setRadio('save-mode', settings.saveMode);
    bindRadioGroup('name-mode', 'nameMode');
    bindRadioGroup('name-position', 'namePosition');
    bindRadioGroup('save-mode', 'saveMode');

    var autoRun = $('check-autorun');
    autoRun.checked = settings.autoRunOnDrop;
    autoRun.addEventListener('change', function () {
      store.updateSettings({ autoRunOnDrop: autoRun.checked });
    });

    var helpOnStart = $('check-help-start');
    helpOnStart.checked = settings.showHelpOnStart;
    helpOnStart.addEventListener('change', function () {
      store.updateSettings({ showHelpOnStart: helpOnStart.checked });
    });

    if (settings.nameMode !== 'same') { $('panel-naming').open = true; }
  }

  function bindFileIntake() {
    var fileInput = $('file-input');
    $('btn-pick').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files);
      fileInput.value = '';
      intake(files, {}).then(function (added) {
        if (added.length > 0) {
          UI.showToast({ tone: 'ok', message: added.length + ' 件を一覧に追加しました。下のボタンで実行します', duration: 7000 });
        }
      });
    });

    var depth = 0;
    var veil = $('dropveil');
    var showVeil = function () {
      $('dropveil-sub').textContent = store.settings.autoRunOnDrop
        ? 'そのまま変換して保存します' : '一覧に追加します';
      veil.hidden = false;
    };
    var hideVeil = function () { depth = 0; veil.hidden = true; };

    global.addEventListener('dragenter', function (event) {
      event.preventDefault();
      depth++;
      showVeil();
    });
    global.addEventListener('dragover', function (event) { event.preventDefault(); });
    global.addEventListener('dragleave', function (event) {
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) { hideVeil(); }
    });
    global.addEventListener('drop', function (event) {
      event.preventDefault();
      hideVeil();
      handleDrop(event.dataTransfer);
    });

    document.addEventListener('paste', function (event) {
      var tag = (event.target && event.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
      var files = Array.prototype.slice.call((event.clipboardData && event.clipboardData.files) || []);
      if (files.length === 0) { return; }
      event.preventDefault();
      intake(files, {}).then(function (added) {
        UI.showToast({ tone: 'ok', message: '貼り付けた ' + added.length + ' 件を一覧に追加しました', duration: 7000 });
      });
    });
  }

  function handleDrop(dataTransfer) {
    collectDropped(dataTransfer).then(function (picked) {
      var sorted = sortOutFiles(picked);
      if (sorted.skipped > 0) {
        UI.showToast({
          tone: 'warn',
          message: 'フォルダー内の Word 以外 ' + sorted.skipped + ' 件は読み込みませんでした',
          duration: 8000
        });
      }
      if (sorted.accepted.length === 0) {
        UI.showToast({ tone: 'warn', message: '読み込めるファイルがありませんでした', duration: 8000 });
        return;
      }
      return intake(sorted.accepted, {}).then(function (added) {
        if (!store.settings.autoRunOnDrop) {
          UI.showToast({ tone: 'ok', message: added.length + ' 件を一覧に追加しました', duration: 7000 });
          return;
        }
        if (store.settings.title.trim() === '') {
          UI.showToast({
            tone: 'warn',
            message: 'タイトルが未入力のため、' + added.length + ' 件を一覧に追加して待機しています',
            duration: 10000
          });
          $('input-title').focus();
          return;
        }
        return run(added);
      });
    });
  }

  function bindMenu() {
    var menu = $('menu');
    var button = $('btn-menu');
    var setOpen = function (open) {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    };
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener('click', function (event) {
      if (!menu.hidden && !menu.contains(event.target)) { setOpen(false); }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !menu.hidden) { setOpen(false); }
    });

    $('btn-clear-samples').addEventListener('click', function () { setOpen(false); clearSamples(); });
    $('btn-clear-done').addEventListener('click', function () {
      setOpen(false);
      removeWithUndo(
        function (item) { return item.status === STATUS.done; },
        function (count) { return '変換済み ' + count + ' 件を一覧から消しました'; }
      );
    });
    $('btn-clear-all').addEventListener('click', function () {
      setOpen(false);
      removeWithUndo(
        function () { return true; },
        function (count) { return '一覧の ' + count + ' 件をすべて消しました'; }
      );
    });
  }

  function bindList() {
    $('rows').addEventListener('click', function (event) {
      var button = event.target.closest('[data-act]');
      if (!button) { return; }
      var row = button.closest('.row');
      if (!row) { return; }
      var id = row.dataset.id;
      if (button.dataset.act === 'detail') {
        var item = store.find(id);
        if (item) { store.patchItem(id, { detailOpen: !item.detailOpen }); }
      } else if (button.dataset.act === 'remove') {
        removeWithUndo(
          function (candidate) { return candidate.id === id; },
          function () { return '1 件を一覧から外しました'; }
        );
      }
    });
  }

  function bindModals() {
    var open = function () {
      $('check-help-start').checked = store.settings.showHelpOnStart;
      UI.openModal('modal-help');
    };
    var close = function () {
      UI.closeModal('modal-help');
      $('input-title').focus();
    };
    $('btn-help').addEventListener('click', open);
    $('modal-help').addEventListener('click', function (event) {
      if (event.target.closest('[data-close]')) { close(); }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('modal-help').hidden) { close(); }
    });
  }

  /* ================================================================ *
   * 起動
   * ================================================================ */

  /**
   * アイコンフォントの CSS が読み込めたかを調べる。
   * 読み込めていない場合は no-fa を付け、アイコンだけのボタンに
   * 文字ラベルを出す（押せるのに意味が分からないボタンを残さないため）。
   */
  function detectIconFont() {
    var probe = document.createElement('i');
    probe.className = 'fa-solid fa-question';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    var content = global.getComputedStyle(probe, '::before').content;
    document.body.removeChild(probe);
    var loaded = !!content && content !== 'none' && content !== 'normal';
    if (!loaded) { document.documentElement.classList.add('no-fa'); }
    return loaded;
  }

  function start() {
    var support = Zip.checkSupport();
    if (!support.ok) {
      $('unsupported-list').textContent = support.missing.join(' / ');
      UI.openModal('modal-unsupported');
      return;
    }

    if (!detectIconFont()) {
      UI.showToast({
        tone: 'warn',
        message: 'アイコン用のフォントを読み込めませんでした（オフラインの可能性）。ボタンは文字ラベルで表示します',
        duration: 12000
      });
    }

    renderSampleList();
    bindSamples();
    bindSettings();
    bindFileIntake();
    bindMenu();
    bindList();
    bindModals();
    $('btn-run').addEventListener('click', function () { run(store.convertibleItems()); });

    store.subscribe(refresh);
    refresh();

    if (store.settings.showHelpOnStart) {
      $('check-help-start').checked = true;
      UI.openModal('modal-help');
    } else {
      $('input-title').focus();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}(window));
