/*!
 * ui.js - Word Title Tool
 * 画面への描画だけを担当する層。状態は持たず、渡されたものを表示する。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var STATUS = WTC.STATUS;

  /* ---------------------------------------------------------------- *
   * 小さなヘルパー
   * ---------------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function icon(classes) {
    var node = document.createElement('i');
    node.className = classes;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function formatNumber(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatBytes(bytes) {
    var kb = bytes / 1024;
    var readable = kb >= 1024
      ? (kb / 1024).toFixed(2) + ' MB'
      : kb.toFixed(1) + ' KB';
    return readable + '（' + formatNumber(bytes) + ' バイト）';
  }

  /**
    * タイトルの表示。空文字と「要素そのものが無い」を分けて出す。
    * 前者は取り除く対象、後者はもともと何もないという違いがあるため。
    */
  function formatTitle(title) {
    if (title === null || title === undefined) { return '（タイトルなし）'; }
    if (title === '') { return '（空の項目が残っています）'; }
    return '「' + title + '」';
  }

  var BADGES = {
    pending:   { label: '読み取り中', icon: 'fa-solid fa-spinner fa-spin', modifier: 'pending' },
    ready:     { label: '処理できます', icon: 'fa-regular fa-circle-check', modifier: 'ready' },
    working:   { label: '処理中', icon: 'fa-solid fa-spinner fa-spin', modifier: 'working' },
    done:      { label: '処理済み', icon: 'fa-solid fa-circle-check', modifier: 'done' },
    cleared:   { label: '空にしました', icon: 'fa-solid fa-circle-check', modifier: 'done' },
    assigned:  { label: '設定しました', icon: 'fa-solid fa-circle-check', modifier: 'done' },
    unchanged: { label: 'もともと空', icon: 'fa-solid fa-circle-minus', modifier: 'unchanged' },
    blocked:   { label: 'この形式は対象外', icon: 'fa-solid fa-ban', modifier: 'blocked' },
    error:     { label: '処理できません', icon: 'fa-solid fa-triangle-exclamation', modifier: 'error' }
  };

  /** 行のバッジを決める。処理後は「何をしたか」を文字で示す。 */
  function badgeFor(item, blocked) {
    if (blocked && item.status !== STATUS.error) { return BADGES.blocked; }
    if (item.status !== STATUS.done || !item.report) {
      return BADGES[item.status] || BADGES.pending;
    }
    if (!item.report.changed) { return BADGES.unchanged; }
    return item.report.mode === 'clear' ? BADGES.cleared : BADGES.assigned;
  }

  /* ---------------------------------------------------------------- *
   * ファイル一覧
   * ---------------------------------------------------------------- */
  function createRow(item) {
    var row = el('li', 'row');
    row.dataset.id = item.id;

    row.appendChild(el('span', 'row__icon')).appendChild(icon('fa-regular fa-file-word'));

    var main = el('div', 'row__main');
    main.appendChild(el('p', 'row__name'));
    main.appendChild(el('p', 'row__meta'));
    row.appendChild(main);

    var out = el('div', 'row__out');
    out.appendChild(el('span', 'row__outlabel', '出力ファイル名'));
    out.appendChild(el('span', 'row__outname'));
    row.appendChild(out);

    row.appendChild(el('span', 'badge row__badge'));

    var tools = el('div', 'row__tools');
    var detailButton = el('button', 'iconbtn');
    detailButton.type = 'button';
    detailButton.dataset.act = 'detail';
    detailButton.title = '処理の根拠を表示';
    detailButton.setAttribute('aria-label', '処理の根拠を表示');
    detailButton.appendChild(icon('fa-regular fa-eye'));
    tools.appendChild(detailButton);

    var removeButton = el('button', 'iconbtn');
    removeButton.type = 'button';
    removeButton.dataset.act = 'remove';
    removeButton.title = 'この 1 件を一覧から外す';
    removeButton.setAttribute('aria-label', 'この 1 件を一覧から外す');
    removeButton.appendChild(icon('fa-regular fa-trash-can'));
    tools.appendChild(removeButton);
    row.appendChild(tools);

    var detail = el('div', 'row__detail');
    detail.hidden = true;
    row.appendChild(detail);
    return row;
  }

  /** 根拠パネルの中身を作る。 */
  function buildDetail(item) {
    var box = document.createDocumentFragment();
    var report = item.report;

    if (item.status === STATUS.error) {
      box.appendChild(el('p', 'facts__title', '処理できない理由'));
      var facts = el('div', 'facts');
      addFact(facts, '理由', item.error || '不明なエラー');
      addFact(facts, '判定方法', 'ZIP の中央ディレクトリと word/document.xml の有無を確認');
      addFact(facts, 'ファイルサイズ', formatBytes(item.size));
      box.appendChild(facts);
      return box;
    }

    box.appendChild(el('p', 'facts__title', report ? '実際に行った処理' : 'このファイルについて分かっていること'));
    var list = el('div', 'facts');

    addFact(list, 'ファイルサイズ', report
      ? formatBytes(report.byteSizeBefore) + ' → ' + formatBytes(report.byteSizeAfter)
      : formatBytes(item.size));
    addFact(list, '処理前のタイトル', formatTitle(report ? report.beforeTitle : item.currentTitle));

    if (report && report.changed && report.format === 'doc') {
      addFact(list, 'ファイル形式', '旧形式 .doc（OLE2 複合ファイル）');
      addFact(list, '行った処理',
        'SummaryInformation のタイトル（PIDSI_TITLE）を空文字にし、元の文字が入っていたバイトを 0 で塗りつぶしました');
      addFact(list, '処理後のタイトル', '（空）');
      addFact(list, '書き換えたストリーム', '\u0005' + report.changedStream, true);
      addFact(list, '消したバイト数', formatNumber(report.clearedByteCount) + ' バイト');
      addFact(list, '値の型 / コードページ',
        report.valueType + ' / ' + report.codePage + '（表示に使用）', true);
      addFact(list, 'ファイル長',
        'ストリーム長を変えないため、ファイル全体の大きさは ' +
        formatNumber(report.byteSizeAfter) + ' バイトのまま変わりません');
      addFact(list, '保存したファイル名', item.savedName || item.outputName, true);
    } else if (report && report.changed) {
      addFact(list, 'ファイル形式', 'OOXML（.docx 系）');
      addFact(list, '行った処理', report.mode === 'clear'
        ? 'docProps/core.xml から <dc:title> を要素ごと取り除きました'
        : 'docProps/core.xml の <dc:title> に指定した文字列を設定しました');
      addFact(list, '処理後のタイトル', report.mode === 'clear'
        ? '（空／要素そのものが存在しません）'
        : formatTitle(report.afterTitle));
      addFact(list, '書き換えたパート',
        (report.changedParts.length ? report.changedParts.join(' / ') : 'なし') +
        (report.addedParts.length ? '　＋新規作成: ' + report.addedParts.join(' / ') : ''));
      addFact(list, '無変更で複製したパート',
        formatNumber(report.copiedPartCount) + ' / ' + formatNumber(report.totalPartCount) +
        ' パート（圧縮データのままコピー）');
      addFact(list, 'core.xml の CRC-32',
        (report.coreCrcBefore === null ? '（元は存在しない）' : WTC.Zip.toHex8(report.coreCrcBefore)) +
        ' → ' + WTC.Zip.toHex8(report.coreCrcAfter), true);
      addFact(list, '文字コード', report.encoding + '（XML 宣言も UTF-8 で出力）');
      addFact(list, '保存したファイル名', item.savedName || item.outputName, true);
      if (item.savedName && item.savedName !== item.outputName) {
        addFact(list, '次に実行したときの名前', item.outputName, true);
      }
    } else if (report) {
      addFact(list, '行った処理', report.format === 'doc'
        ? 'もともとタイトルが入っていないため、何も書き換えていません'
        : 'もともと <dc:title> が無いため、何も書き換えていません');
      addFact(list, '出力したファイル', report.format === 'doc'
        ? '元のファイルをそのまま出力（バイト単位で同一）'
        : '元のファイルをそのまま出力（全 ' + formatNumber(report.totalPartCount) +
          ' パートがバイト単位で同一）');
      addFact(list, '保存したファイル名', item.savedName || item.outputName, true);
      if (item.savedName && item.savedName !== item.outputName) {
        addFact(list, '次に実行したときの名前', item.outputName, true);
      }
    } else {
      addFact(list, 'ファイル形式',
        item.format === 'doc' ? '旧形式 .doc（OLE2 複合ファイル）' : 'OOXML（.docx 系）');
      if (item.limitation) { addFact(list, 'この形式の制限', item.limitation); }
      if (item.format !== 'doc') {
        addFact(list, 'コアプロパティ',
          item.hasCorePart === false ? 'docProps/core.xml がありません' : 'docProps/core.xml あり');
      }
      addFact(list, '予定の出力ファイル名', item.outputName, true);
      addFact(list, '根拠の詳細', '実行すると、書き換えた場所と検証値がここに出ます');
    }
    box.appendChild(list);
    return box;
  }

  function addFact(container, key, value, mono) {
    container.appendChild(el('span', 'facts__key', key));
    container.appendChild(el('span', 'facts__val' + (mono ? ' facts__val--mono' : ''), value));
  }

  function updateRow(row, item, blocked) {
    var badgeInfo = badgeFor(item, blocked);

    row.classList.toggle('row--error', item.status === STATUS.error);
    row.querySelector('.row__icon i').className =
      item.status === STATUS.error ? 'fa-solid fa-file-circle-exclamation' : 'fa-regular fa-file-word';

    var nameNode = row.querySelector('.row__name');
    nameNode.textContent = item.name;
    nameNode.title = item.name;
    if (item.isSample && !nameNode.querySelector('.tag')) {
      nameNode.appendChild(el('span', 'tag', 'サンプル'));
    }

    var meta = row.querySelector('.row__meta');
    if (item.status === STATUS.error) {
      meta.textContent = item.error;
    } else if (blocked) {
      meta.textContent = item.limitation || 'この形式ではいまの処理を行えません';
    } else {
      /* 「空の項目」は取り除く対象があるときだけ言う。処理後は単に「空」 */
      var titleText = (item.currentTitle === '' && !item.needsClearing)
        ? '（空）' : formatTitle(item.currentTitle);
      meta.textContent = formatBytes(item.size) + '　現在のタイトル: ' + titleText;
    }
    meta.title = meta.textContent;

    var showSaved = item.status === STATUS.done && item.savedName && !blocked;
    var outName = row.querySelector('.row__outname');
    outName.textContent = (item.status === STATUS.error || blocked)
      ? '—' : (showSaved ? item.savedName : item.outputName);
    outName.title = outName.textContent;
    row.querySelector('.row__outlabel').textContent = showSaved ? '保存した名前' : '出力ファイル名';

    var badge = row.querySelector('.row__badge');
    badge.className = 'badge row__badge badge--' + badgeInfo.modifier;
    badge.textContent = '';
    badge.appendChild(icon(badgeInfo.icon));
    badge.appendChild(el('span', null, badgeInfo.label));

    var detail = row.querySelector('.row__detail');
    detail.hidden = !item.detailOpen;
    if (item.detailOpen) {
      detail.textContent = '';
      detail.appendChild(buildDetail(item));
    }
    var detailButton = row.querySelector('[data-act="detail"]');
    detailButton.querySelector('i').className = item.detailOpen
      ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  }

  function renderList(store, cache) {
    var listNode = $('rows');
    var seen = Object.create(null);
    var previous = null;

    store.items.forEach(function (item) {
      var row = cache[item.id];
      if (!row) {
        row = createRow(item);
        cache[item.id] = row;
      }
      updateRow(row, item, !store.canProcess(item));
      seen[item.id] = true;
      var expected = previous ? previous.nextSibling : listNode.firstChild;
      if (row !== expected) { listNode.insertBefore(row, expected); }
      previous = row;
    });

    Object.keys(cache).forEach(function (id) {
      if (!seen[id]) {
        if (cache[id].parentNode) { cache[id].parentNode.removeChild(cache[id]); }
        delete cache[id];
      }
    });

    $('emptystate').hidden = store.items.length > 0;
  }

  /* ---------------------------------------------------------------- *
   * 件数・状態・実行ボタン
   * ---------------------------------------------------------------- */
  function renderCounts(counts) {
    var text;
    if (counts.total === 0) {
      text = 'まだファイルがありません';
    } else {
      text = '全 ' + formatNumber(counts.total) + ' 件　' +
        '（処理できる ' + formatNumber(counts.convertible) + ' 件' +
        (counts.blocked > 0 ? ' / この形式は対象外 ' + formatNumber(counts.blocked) + ' 件' : '') +
        (counts.error > 0 ? ' / 処理できない ' + formatNumber(counts.error) + ' 件' : '') +
        (counts.done > 0 ? ' / 処理済み ' + formatNumber(counts.done) + ' 件' : '') + '）';
    }
    $('filelist-counts').textContent = text;

    var log = WTC.Log;
    $('menu-log-count').textContent = formatNumber(log.count()) + ' 件' +
      (log.problemCount() > 0 ? '（問題 ' + formatNumber(log.problemCount()) + '）' : '');
    $('menu-sample-count').textContent = formatNumber(counts.sample) + ' 件';
    $('menu-done-count').textContent = formatNumber(counts.done) + ' 件';
    $('menu-all-count').textContent = formatNumber(counts.total) + ' 件';
    $('btn-clear-samples').disabled = counts.sample === 0;
    $('btn-clear-samples-2').disabled = counts.sample === 0;
    $('btn-clear-done').disabled = counts.done === 0;
    $('btn-clear-all').disabled = counts.total === 0;
    $('sample-state').textContent = counts.sample === 0
      ? '未読込' : '読込済 ' + formatNumber(counts.sample) + ' 件';
  }

  var STATUS_ICONS = {
    neutral: 'fa-regular fa-circle-question',
    info: 'fa-solid fa-circle-info',
    warn: 'fa-solid fa-triangle-exclamation',
    ok: 'fa-solid fa-circle-check',
    error: 'fa-solid fa-circle-xmark'
  };

  /** 実行バーを更新する。件数はすべて呼び出し側で数えて渡す。 */
  function renderAction(state) {
    var statusNode = $('status');
    statusNode.dataset.tone = state.tone;
    statusNode.querySelector('.actionbar__icon').innerHTML = '';
    statusNode.querySelector('.actionbar__icon').appendChild(icon(STATUS_ICONS[state.tone]));
    $('status-text').textContent = state.message;
    $('status-text').title = state.message;

    var button = $('btn-run');
    button.disabled = !state.canRun;
    $('btn-run-label').textContent = state.buttonLabel;

    $('progress').hidden = !state.progress;
    if (state.progress) {
      var ratio = state.progress.total === 0 ? 0 : state.progress.done / state.progress.total;
      $('bar-fill').style.width = Math.round(ratio * 100) + '%';
      $('progress-text').textContent =
        formatNumber(state.progress.done) + ' / ' + formatNumber(state.progress.total) + ' 件';
    }
  }

  /* ---------------------------------------------------------------- *
   * 設定パネルの表示
   * ---------------------------------------------------------------- */
  function renderNamingPanel(settings, sampleNames) {
    var mode = settings.nameMode;
    $('naming-text-fields').hidden = mode !== 'text';
    $('naming-serial-fields').hidden = mode !== 'serial';
    $('naming-position').hidden = mode === 'same';

    var stateLabel = mode === 'same' ? 'そのまま' : (mode === 'text' ? '自由記述' : '連番');
    $('naming-state').textContent = stateLabel;

    var preview = $('naming-preview');
    var value = sampleNames.length === 0
      ? 'ファイルを入れると、ここに実際の名前が出ます'
      : sampleNames.join('\n');
    var valueNode = $('naming-preview-value');
    if (valueNode.textContent !== value) {
      valueNode.textContent = value;
      preview.classList.remove('is-updated');
      void preview.offsetWidth;
      preview.classList.add('is-updated');
    }

    $('name-text-warn').hidden = !WTC.Naming.hasForbiddenChars($('input-name-text').value);
  }

  function renderSavePanel(settings) {
    var labels = { auto: '自動', each: '個別', zip: 'ZIP' };
    var action = settings.titleMode === 'set' ? 'タイトルを設定して' : 'タイトルを空にして';
    $('save-state').textContent = labels[settings.saveMode] || '自動';
    $('zipname-field').hidden = settings.saveMode === 'each';
    $('dropzone-sub').textContent = settings.autoRunOnDrop
      ? 'ドロップすると、そのまま' + action + '保存します'
      : 'ドロップしたファイルは一覧に追加します（実行は下のボタン）';
  }

  function renderTitlePanel(settings) {
    var isSetMode = settings.titleMode === 'set';
    $('title-set-fields').hidden = !isSetMode;
    $('title-clear-note').hidden = isSetMode;
    if (!isSetMode) { return; }

    var title = settings.title;
    var trimmed = title.trim();
    $('title-counter').textContent = title.length + ' 文字';
    $('input-title').classList.toggle('is-missing', trimmed === '');
    $('title-applied').hidden = trimmed === '';
    $('title-preview').textContent = trimmed;
    $('title-preview').title = trimmed;
  }

  /* ---------------------------------------------------------------- *
   * トースト（取り消しつき）
   * ---------------------------------------------------------------- */
  function showToast(options) {
    var toast = el('div', 'toast toast--' + (options.tone || 'ok'));
    toast.appendChild(el('span', 'toast__icon')).appendChild(icon(STATUS_ICONS[options.tone || 'ok']));
    toast.appendChild(el('span', 'toast__text', options.message));

    var timer;
    var close = function () {
      global.clearTimeout(timer);
      if (toast.parentNode) { toast.parentNode.removeChild(toast); }
    };

    if (options.actionLabel && options.onAction) {
      var action = el('button', 'toast__action');
      action.type = 'button';
      action.appendChild(icon(options.actionIcon || 'fa-solid fa-rotate-left'));
      action.appendChild(el('span', null, options.actionLabel));
      action.addEventListener('click', function () { options.onAction(); close(); });
      toast.appendChild(action);
    }

    var stack = $('toasts');
    stack.appendChild(toast);
    while (stack.children.length > 3) { stack.removeChild(stack.firstChild); }
    timer = global.setTimeout(close, options.duration || 7000);
    return close;
  }

  /* ---------------------------------------------------------------- *
   * モーダル
   * ---------------------------------------------------------------- */
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  /** 診断ログの中身を書き出す。 */
  function renderLog(text) {
    $('log-text').textContent = text;
    $('log-text').scrollTop = $('log-text').scrollHeight;
  }

  WTC.UI = {
    $: $,
    el: el,
    icon: icon,
    formatNumber: formatNumber,
    formatBytes: formatBytes,
    formatTitle: formatTitle,
    renderList: renderList,
    renderCounts: renderCounts,
    renderAction: renderAction,
    renderNamingPanel: renderNamingPanel,
    renderSavePanel: renderSavePanel,
    renderTitlePanel: renderTitlePanel,
    renderLog: renderLog,
    showToast: showToast,
    openModal: openModal,
    closeModal: closeModal
  };
}(window));
