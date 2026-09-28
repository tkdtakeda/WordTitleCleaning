/*!
 * run-state.js - 文書タイトル クリーニング
 * 「いま実行できるか」と、実行バー・ボタンに出す文言を決める層。DOM には触れない。
 * 件数はすべてここで数えて文言に入れる（ユーザーに数えさせない）。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  /* 処理ごとの言い回し。ボタンの位置は動かさず、ラベルだけを変える */
  var WORDS = {
    clear: {
      button: 'タイトルを空にして保存',
      working: 'タイトルを取り除いています',
      drop: 'タイトルを空にして'
    },
    filename: {
      button: 'ファイル名をタイトルにして保存',
      working: 'タイトルをファイル名に書き換えています',
      drop: 'タイトルをファイル名にして'
    },
    set: {
      button: 'タイトルを設定して保存',
      working: 'タイトルを書き換えています',
      drop: 'タイトルを設定して'
    }
  };

  function wordsFor(mode) {
    return WORDS[mode] || WORDS.clear;
  }

  /** 対象外になった件数の内訳（「読み取れない」と「この処理に対応しない」を分けて出す）。 */
  function excludedNote(counts) {
    var parts = [];
    if (counts.error > 0) { parts.push('読み取れない ' + counts.error + ' 件'); }
    if (counts.blocked > 0) { parts.push('この処理に対応しない ' + counts.blocked + ' 件'); }
    return parts.length ? '（対象外: ' + parts.join(' / ') + '。理由は各行に表示）' : '';
  }

  function nothingToRun(counts) {
    if (counts.blocked > 0 && counts.error === 0) {
      return '全 ' + counts.blocked + ' 件がこの処理に対応していません（旧形式 .doc など）。' +
        '「タイトルを空にする」なら実行できます';
    }
    return '処理できるファイルがありません' + excludedNote(counts) + '。各行の「根拠」ボタンで理由を確認できます';
  }

  function clearMessage(counts, saving, leftover) {
    if (counts.needsClearing === 0) {
      return counts.convertible + ' 件はもともとタイトルがありません。実行してもファイルは変わりません' + leftover;
    }
    var untouched = counts.convertible - counts.needsClearing;
    /* 注意は保存方法より先に出す（案内文が長いと末尾が省略されるため） */
    var risk = counts.pdfUaAtRisk > 0
      ? '注意: ' + counts.pdfUaAtRisk + ' 件は PDF/UA 準拠を宣言しており、空にすると要件を満たさなくなります。'
      : '';
    return counts.convertible + ' 件中 ' + counts.needsClearing + ' 件を空にします' +
      (untouched > 0 ? '（' + untouched + ' 件はもともとタイトルが無く無変更）' : '') + '。' +
      risk + saving + leftover;
  }

  /**
   * 実行バーの状態を決める。
   * @returns {{canRun, tone, message, buttonLabel, progress?}}
   */
  function evaluate(store) {
    var settings = store.settings;
    var mode = settings.titleMode;
    var words = wordsFor(mode);
    var counts = store.counts();
    var title = settings.title.trim();

    if (store.processing) {
      return { canRun: false, tone: 'info', progress: store.progress, message: words.working, buttonLabel: '処理中…' };
    }
    var reading = store.items.filter(function (item) { return item.status === WTC.STATUS.pending; }).length;
    if (reading > 0) {
      return { canRun: false, tone: 'info', message: reading + ' 件を読み取っています。少しお待ちください', buttonLabel: words.button };
    }
    if (counts.total === 0) {
      return {
        canRun: false, tone: 'neutral', buttonLabel: words.button,
        message: 'ファイルがありません。ドロップするか「ファイルを選ぶ」で追加してください'
      };
    }
    if (mode === WTC.TITLE_MODE.set && title === '') {
      return {
        canRun: false, tone: 'warn', buttonLabel: words.button,
        message: 'タイトルが未入力です。右の「設定するタイトル」に入れてください'
      };
    }
    if (counts.convertible === 0) {
      return { canRun: false, tone: 'error', message: nothingToRun(counts), buttonLabel: words.button };
    }

    var saving = WTC.Saver.describe(settings, counts.convertible);
    var leftover = excludedNote(counts);
    var message;
    if (mode === WTC.TITLE_MODE.set) {
      message = counts.convertible + ' 件に「' + title + '」を設定します。' + saving + leftover;
    } else if (mode === WTC.TITLE_MODE.filename) {
      message = counts.convertible + ' 件のタイトルを、それぞれの出力ファイル名（拡張子なし）にします。' + saving + leftover;
    } else {
      message = clearMessage(counts, saving, leftover);
    }
    var cautious = counts.error > 0 || (mode === WTC.TITLE_MODE.clear && counts.pdfUaAtRisk > 0);
    return {
      canRun: true,
      tone: cautious ? 'warn' : 'info',
      message: message,
      buttonLabel: counts.convertible + ' 件の' + words.button
    };
  }

  WTC.RunState = {
    wordsFor: wordsFor,
    evaluate: evaluate
  };
}(window));
