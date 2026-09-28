/*!
 * app.js - 文書タイトル クリーニング
 * 画面と各層をつなぐ制御役。状態は Store、描画は UI、実行できるかの判定は RunState、
 * 形式ごとの処理は TitleService、名前は Naming、保存は Saver に任せる。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC;
  var UI = WTC.UI;
  var Zip = WTC.Zip;
  var TitleService = WTC.TitleService;
  var Log = WTC.Log;
  var Saver = WTC.Saver;
  var Naming = WTC.Naming;
  var Samples = WTC.Samples;
  var RunState = WTC.RunState;
  var STATUS = WTC.STATUS;
  var TITLE_MODE = WTC.TITLE_MODE;

  var $ = UI.$;
  var store = new WTC.Store();
  var rowCache = Object.create(null);
  var PLACEHOLDER_NAMES = ['報告書.pdf', '議事録.docx'];
  var PREVIEW_LIMIT = 3;

  /* ================================================================ *
   * 共通ユーティリティ
   * ================================================================ */
  function messageOf(error) {
    return (error && error.message) ? error.message : String(error);
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
    var targets = store.processableItems();
    var built = Naming.buildAll(targets.map(function (item) { return item.name; }), namingOptions());
    targets.forEach(function (item, index) { item.outputName = built.names[index]; });
  }

  /** 先頭の数件だけを見本として並べる（残りは件数で示す）。 */
  function previewList(format) {
    var targets = store.processableItems();
    if (targets.length === 0) {
      return Naming.buildAll(PLACEHOLDER_NAMES, namingOptions()).names.map(function (name) {
        return '例）' + format(name);
      });
    }
    return targets.slice(0, PREVIEW_LIMIT).map(function (item) { return format(item.outputName); })
      .concat(targets.length > PREVIEW_LIMIT ? ['… ほか ' + (targets.length - PREVIEW_LIMIT) + ' 件'] : []);
  }

  function previewNames() {
    return previewList(function (name) { return name; });
  }

  /** 「ファイル名をタイトルにする」で実際に入る値の見本。 */
  function previewFilenameTitles() {
    return previewList(function (name) { return name + ' → ' + Naming.baseName(name); });
  }

  /* ================================================================ *
   * 実行できるかの判定
   * ================================================================ */

  /** 入力欄に文字を入れないと実行できない処理か（同じタイトルを設定する）。 */
  function needsTitleInput() {
    return store.settings.titleMode === TITLE_MODE.set && store.settings.title.trim() === '';
  }

  function evaluateRun() {
    return RunState.evaluate(store);
  }

  /* ================================================================ *
   * 再描画
   * ================================================================ */
  function refresh() {
    recomputeOutputNames();
    UI.renderList(store, rowCache);
    UI.renderCounts(store.counts());
    UI.renderTitlePanel(store.settings, previewFilenameTitles());
    UI.renderNamingPanel(store.settings, previewNames());
    UI.renderSavePanel(store.settings);
    $('zipname-hint').textContent = '保存名: ' + Saver.zipFileName(store.settings);
    $('dropzone').classList.toggle('is-compact', store.items.length > 0);
    UI.renderAction(evaluateRun());
  }

  /* ================================================================ *
   * ファイルの取り込み
   * ================================================================ */
  function inspectItems(items) {
    return items.reduce(function (chain, item) {
      return chain.then(function () {
        return TitleService.inspect(item.file).then(function (info) {
          Log.info('解析しました', {
            名前: item.name, 形式: info.format,
            現在のタイトル: info.currentTitle, 空にする必要: info.needsClearing
          });
          store.patchItem(item.id, {
            status: STATUS.ready,
            currentTitle: info.currentTitle,
            hasCorePart: info.hasCorePart,
            format: info.format,
            capabilities: info.capabilities,
            needsClearing: info.needsClearing,
            limitation: info.limitation,
            details: info.details,
            alreadyEmpty: TitleService.isEmptyTitle(info.currentTitle)
          });
        }, function (error) {
          Log.warn('解析できませんでした',
            { 名前: item.name, サイズ: item.size, 理由: messageOf(error) });
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

  /* ================================================================ *
   * 変換と保存
   * ================================================================ */
  /**
   * 1 件ごとに書き込むタイトルを決める。
   * 「ファイル名をタイトルにする」は、保存する名前（出力ファイル名）から拡張子を除いたもの。
   */
  function titleFor(mode, outputName) {
    if (mode === TITLE_MODE.filename) { return Naming.baseName(outputName); }
    return mode === TITLE_MODE.set ? store.settings.title.trim() : '';
  }

  function run(items) {
    var mode = store.settings.titleMode;
    var targets = items.filter(function (item) { return store.canProcess(item); });
    if (targets.length === 0 || needsTitleInput()) { return Promise.resolve(); }

    recomputeOutputNames();
    var plan = targets.map(function (item) {
      return {
        item: item,
        name: item.outputName,
        options: { mode: WTC.isWriteMode(mode) ? 'set' : 'clear', title: titleFor(mode, item.outputName) }
      };
    });

    store.processing = true;
    store.progress = { done: 0, total: plan.length };
    refresh();

    var results = [];
    var failed = 0;
    var unchanged = 0;

    return plan.reduce(function (chain, step, index) {
      return chain.then(function () {
        store.patchItem(step.item.id, { status: STATUS.working }, true);
        refresh();
        return TitleService.apply(step.item.file, step.options).then(function (output) {
          if (!output.report.changed) { unchanged++; }
          store.patchItem(step.item.id, {
            status: STATUS.done,
            report: output.report,
            resultBlob: output.blob,
            savedName: step.name,
            appliedMode: mode,
            currentTitle: output.report.afterTitle,
            needsClearing: !TitleService.isEmptyTitle(output.report.afterTitle),
            alreadyEmpty: TitleService.isEmptyTitle(output.report.afterTitle)
          }, true);
          results.push({ name: step.name, blob: output.blob });
        }, function (error) {
          failed++;
          Log.warn('処理できませんでした', { 名前: step.item.name, 理由: messageOf(error) });
          store.patchItem(step.item.id, { status: STATUS.error, error: messageOf(error) }, true);
        }).then(function () {
          store.progress = { done: index + 1, total: plan.length };
          refresh();
        });
      });
    }, Promise.resolve()).then(function () {
      Log.info('処理が終わりました', {
        成功: results.length, 失敗: failed, 無変更: unchanged, モード: mode
      });
      return Saver.save(results, store.settings);
    }).then(function (saved) {
      store.processing = false;
      refresh();
      reportResult(saved, results.length, failed, unchanged);
    }, function (error) {
      store.processing = false;
      refresh();
      Log.error('保存に失敗しました', { 理由: messageOf(error) });
      UI.showToast({ tone: 'error', message: '保存に失敗しました: ' + messageOf(error), duration: 12000 });
    });
  }

  function reportResult(saved, successCount, failedCount, unchangedCount) {
    if (successCount === 0) {
      UI.showToast({ tone: 'error', message: '処理できたファイルがありませんでした', duration: 10000 });
      return;
    }
    var message = saved.kind === 'zip'
      ? successCount + ' 件を「' + saved.name + '」にまとめて保存しました'
      : successCount + ' 件を保存しました';
    if (unchangedCount > 0) {
      message += '（うち ' + unchangedCount + ' 件はもともとタイトルが無く、無変更で出力）';
    }
    if (failedCount > 0) { message += '（' + failedCount + ' 件は失敗。一覧の理由を確認してください）'; }
    UI.showToast({ tone: failedCount > 0 ? 'warn' : 'ok', message: message, duration: 11000 });
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
  function sampleCheckbox(value, className) {
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    if (value) { checkbox.value = value; }
    if (className) { checkbox.className = className; }
    return checkbox;
  }

  /** 形式（Word / PDF）ごとにまとめて並べる。見出しのチェックでその形式をまとめて選べる。 */
  function renderSampleList() {
    var container = $('samplelist');
    container.textContent = '';
    Samples.GROUPS.forEach(function (group) {
      var box = UI.el('div', 'samplegroup');
      var head = UI.el('label', 'samplegroup__head');
      var toggle = sampleCheckbox(null, 'samplegroup__toggle');
      head.appendChild(toggle);
      head.appendChild(UI.icon(group.icon));
      head.appendChild(UI.el('span', null, group.label));
      box.appendChild(head);

      Samples.CATALOG.filter(function (sample) { return sample.group === group.id; }).forEach(function (sample) {
        var label = UI.el('label', 'sample');
        label.appendChild(sampleCheckbox(sample.id, 'sample__check'));
        var body = UI.el('span');
        body.appendChild(UI.el('span', 'sample__title', sample.label));
        body.appendChild(document.createElement('br'));
        body.appendChild(UI.el('span', 'sample__desc', sample.note));
        label.appendChild(body);
        box.appendChild(label);
      });
      container.appendChild(box);
    });
  }

  /** 見出しのチェックと、その下の各サンプルのチェックを連動させる。 */
  function bindSampleGroups() {
    $('samplelist').addEventListener('change', function (event) {
      var box = event.target.closest('.samplegroup');
      if (!box) { return; }
      var items = Array.prototype.slice.call(box.querySelectorAll('.sample__check'));
      var toggle = box.querySelector('.samplegroup__toggle');
      if (event.target === toggle) {
        items.forEach(function (item) { item.checked = toggle.checked; });
        return;
      }
      var checked = items.filter(function (item) { return item.checked; }).length;
      toggle.checked = checked === items.length;
      toggle.indeterminate = checked > 0 && checked < items.length;
    });
  }

  function loadSamples() {
    var checked = Array.prototype.slice.call($('samplelist').querySelectorAll('.sample__check:checked'))
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
    bindSampleGroups();
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
      store.updateSettings({ title: WTC.DocxTitle.sanitizeTitle(titleInput.value) });
    });
    titleInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') { return; }
      event.preventDefault();
      if (evaluateRun().canRun) { run(store.processableItems()); } else { $('btn-pick').focus(); }
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

    var titleModeRadios = document.querySelectorAll('input[name="title-mode"]');
    Array.prototype.forEach.call(titleModeRadios, function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) { return; }
        store.updateSettings({ titleMode: radio.value });
        if (radio.value === TITLE_MODE.set) { titleInput.focus(); }
      });
    });
    setRadio('title-mode', settings.titleMode);

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

  /**
   * 取り込み口はここ 1 つ。どこから入ってきたかは meta.source で分ける。
   * ドロップだけは、設定が揃っていればそのまま保存まで進める。
   */
  function handleIncoming(files, meta) {
    if (meta.skipped > 0 && files.length > 0) {
      UI.showToast({
        tone: 'warn',
        message: 'フォルダー内の Word / PDF 以外 ' + meta.skipped + ' 件は読み込みませんでした',
        duration: 8000
      });
    }
    if (files.length === 0) {
      if (meta.source === WTC.Intake.SOURCE.drop) { reportEmptyDrop(meta); }
      return Promise.resolve([]);
    }

    return intake(files, {}).then(function (added) {
      if (added.length === 0) { return added; }

      if (meta.source !== WTC.Intake.SOURCE.drop || !store.settings.autoRunOnDrop) {
        UI.showToast({
          tone: 'ok',
          message: added.length + ' 件を一覧に追加しました。下のボタンで実行します',
          duration: 7000
        });
        return added;
      }
      if (needsTitleInput()) {
        UI.showToast({
          tone: 'warn',
          message: 'タイトルが未入力のため、' + added.length + ' 件を一覧に追加して待機しています',
          duration: 10000
        });
        $('input-title').focus();
        return added;
      }
      return run(added).then(function () { return added; });
    });
  }

  /**
   * ドロップしたのに 1 件も取り込めなかったときは、必ず理由を出す。
   * 何が届いていたのかは診断ログに残してある。
   */
  function reportEmptyDrop(meta) {
    if (meta.reason === WTC.Intake.REASON.filtered) {
      UI.showToast({
        tone: 'warn',
        message: 'ドロップした ' + meta.skipped + ' 件はどれも Word / PDF ファイルではありませんでした' +
          '（対応: ' + TitleService.allExtensions().join(' / ') + '）',
        duration: 12000
      });
      return;
    }
    UI.showToast({
      tone: 'error',
      message: 'ブラウザからファイルの実体を受け取れませんでした。' +
        'メールの添付や ZIP の中から直接ドラッグした場合に起こります。' +
        'いったんデスクトップ等へ保存してからお試しください（詳細は右上 ⋮ →「診断ログ」）',
      duration: 20000,
      actionLabel: '診断ログを見る',
      actionIcon: 'fa-solid fa-clipboard-list',
      onAction: openLog
    });
  }

  function bindFileIntake() {
    WTC.Intake.bind({
      onFiles: handleIncoming,
      veilText: function () {
        if (!store.settings.autoRunOnDrop) { return '一覧に追加します'; }
        if (needsTitleInput()) { return '一覧に追加します（設定するタイトルが未入力のため）'; }
        return RunState.wordsFor(store.settings.titleMode).drop + '保存します';
      }
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

    $('btn-log').addEventListener('click', function () { setOpen(false); });
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

  /** 次にすることへフォーカスを置く。 */
  function focusFirstStep() {
    if (needsTitleInput()) {
      $('input-title').focus();
    } else {
      $('btn-pick').focus();
    }
  }

  function openLog() {
    UI.renderLog(Log.toText());
    UI.openModal('modal-log');
  }

  function bindLogModal() {
    $('btn-log').addEventListener('click', function () { openLog(); });
    $('modal-log').addEventListener('click', function (event) {
      if (event.target.closest('[data-close]')) { UI.closeModal('modal-log'); }
    });

    $('btn-log-copy').addEventListener('click', function () {
      var label = $('btn-log-copy-label');
      var done = function (ok) {
        label.textContent = ok ? 'コピーしました' : 'コピーできませんでした（下の文字を選んでコピーしてください）';
        global.setTimeout(function () { label.textContent = 'クリップボードにコピー'; }, 4000);
      };
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(Log.toText()).then(function () { done(true); },
          function () { done(false); });
      } else {
        done(false);
      }
    });

    $('btn-log-save').addEventListener('click', function () {
      Saver.download(new Blob([Log.toText()], { type: 'text/plain;charset=utf-8' }),
        '文書タイトルクリーニング_診断ログ.txt');
    });

    $('btn-log-clear').addEventListener('click', function () {
      Log.clear();
      Log.info('診断ログを消去しました', { 版: Log.VERSION });
      UI.renderLog(Log.toText());
      refresh();
    });
  }

  function bindModals() {
    var open = function () {
      $('check-help-start').checked = store.settings.showHelpOnStart;
      UI.openModal('modal-help');
    };
    var close = function () {
      UI.closeModal('modal-help');
      focusFirstStep();
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
      Log.error('この環境では動作しません', { 不足している機能: support.missing });
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

    Log.info('起動しました', {
      版: Log.VERSION,
      URL: global.location.protocol,
      ブラウザ: global.navigator.userAgent,
      圧縮機能: typeof global.CompressionStream === 'function' ? 'あり' : 'なし',
      対応拡張子: TitleService.allExtensions().join(' / ')
    });
    $('app-version').textContent = '版 ' + Log.VERSION;

    renderSampleList();
    bindSamples();
    bindSettings();
    bindFileIntake();
    bindMenu();
    bindList();
    bindModals();
    bindLogModal();
    $('btn-run').addEventListener('click', function () { run(store.processableItems()); });

    store.subscribe(refresh);
    refresh();

    if (store.settings.showHelpOnStart) {
      $('check-help-start').checked = true;
      UI.openModal('modal-help');
    } else {
      focusFirstStep();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}(window));
