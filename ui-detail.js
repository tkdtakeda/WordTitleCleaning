/*!
 * ui-detail.js - 文書タイトル クリーニング
 * 一覧の各行にある「根拠」パネルの中身を作る層。状態は持たない。
 * 形式ごと（.docx 系 / 旧形式 .doc / PDF）に「何を・どこを・どう変えたか」と
 * その確かめ方を並べ、画面上で理由を追えるようにする。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var STATUS = WTC.STATUS;

  var XREF_LABELS = {
    table: '従来の相互参照表',
    stream: '相互参照ストリーム（PDF 1.5 以降の圧縮形式）',
    hybrid: '相互参照表とストリームの併用（Word の出力と同じ形）',
    repaired: '相互参照が壊れているため、ファイル全体を走査して読み取り'
  };

  function ui() { return WTC.UI; }

  function addFact(container, key, value, modifier) {
    container.appendChild(ui().el('span', 'facts__key', key));
    container.appendChild(ui().el('span', 'facts__val' + (modifier ? ' facts__val--' + modifier : ''), value));
  }

  function outputNameOf(item) {
    return item.savedName || item.outputName;
  }

  /* ------------------------------------------------------------------ *
   * PDF のタブ表示の見込み（各ブラウザの実装どおりに組み立てる）
   * ------------------------------------------------------------------ */

  /** Edge / Chrome: 文書情報辞書の /Title（前後の空白を除き、空ならファイル名）。 */
  function chromiumTab(infoTitle, fileName) {
    var title = (infoTitle || '').trim();
    return title ? '「' + title + '」' : 'ファイル名「' + fileName + '」';
  }

  /** Firefox: XMP の dc:title を優先し、無ければ /Title。「タイトル - ファイル名」の形。 */
  function firefoxTab(infoTitle, xmpTitle, fileName) {
    var title = (xmpTitle && xmpTitle !== 'Untitled') ? xmpTitle : infoTitle;
    return title ? '「' + title + ' - ' + fileName + '」' : 'ファイル名「' + fileName + '」';
  }

  function xmpText(hasXmp, title) {
    return hasXmp ? ui().formatTitle(title) : '（XMP メタデータなし）';
  }

  /* ------------------------------------------------------------------ *
   * 形式ごとの根拠
   * ------------------------------------------------------------------ */
  function errorFacts(list, item) {
    var method = /\.pdf$/i.test(item.name)
      ? 'PDF の見出し（%PDF-）・相互参照・暗号化と電子署名の有無を確認'
      : (/\.(doc|dot)$/i.test(item.name)
        ? 'OLE2 複合ファイルの構造と WordDocument ストリームの有無を確認'
        : 'ZIP の中央ディレクトリと word/document.xml の有無を確認');
    addFact(list, '理由', item.error || '不明なエラー');
    addFact(list, '判定方法', method);
    addFact(list, 'ファイルサイズ', ui().formatBytes(item.size));
  }

  function pdfBeforeFacts(list, item) {
    var d = item.details || {};
    var name = outputNameOf(item);
    addFact(list, 'ファイル形式', 'PDF ' + (d.version || '') + '（' + (XREF_LABELS[d.xrefKind] || '不明') + '）');
    addFact(list, '文書情報辞書の /Title', d.hasInfo ? ui().formatTitle(d.infoTitle) : '（文書情報辞書なし）');
    addFact(list, 'XMP の dc:title', xmpText(d.hasXmp, d.xmpTitle));
    addFact(list, 'タブの表示（Edge / Chrome）', chromiumTab(d.infoTitle, name));
    addFact(list, 'タブの表示（Firefox）', firefoxTab(d.infoTitle, d.xmpTitle, name));
    addFact(list, 'Acrobat での表示', d.displayDocTitle
      ? 'タイトルを表示する設定（DisplayDocTitle）。タイトルが無ければファイル名を表示'
      : 'ファイル名を表示する設定');
    if (d.oldRevisionTraces > 0) {
      addFact(list, '過去の版に残るタイトル', d.oldRevisionTraces + ' か所（追記保存で残った古い版。処理するとまとめて消します）');
    }
    if (d.pdfUa) {
      addFact(list, 'PDF/UA', '準拠を宣言しています。タイトルが必須のため、空にすると要件を満たさなくなります。' +
        '「ファイル名をタイトルにする」がおすすめです', 'warn');
    }
    if (item.limitation) { addFact(list, 'この PDF の制限', item.limitation, 'warn'); }
    addFact(list, '予定の出力ファイル名', item.outputName, 'mono');
    addFact(list, '根拠の詳細', '実行すると、書き換えた場所と検証の結果がここに出ます');
  }

  function pdfMethodText(report) {
    if (report.method === 'none') { return 'もともとタイトルが無いため、何も書き換えていません（元のファイルとバイト単位で同一）'; }
    if (report.mode === 'set') {
      return '古いタイトルを同じ長さの空白で塗りつぶしたうえで、新しいタイトルを末尾に追記しました（PDF 標準の追記保存）';
    }
    return report.method === 'in-place'
      ? 'タイトルを同じ長さの空白で塗りつぶして取り除きました。ファイルの大きさも構造も変わりません'
      : '塗りつぶせない圧縮された場所があったため、タイトルを除いた新しい版を末尾に追記し、古い圧縮データは無効にして中身を消しました（PDF 標準の追記保存）';
  }

  function pdfReportFacts(list, item) {
    var report = item.report;
    var d = report.details || {};
    var name = outputNameOf(item);
    addFact(list, 'ファイルサイズ', ui().formatBytes(report.byteSizeBefore) + ' → ' + ui().formatBytes(report.byteSizeAfter));
    addFact(list, '処理前の /Title', ui().formatTitle(report.before.info));
    addFact(list, '処理前の dc:title', xmpText(d.hasXmp, report.before.xmp));
    addFact(list, '行った処理', pdfMethodText(report));
    addFact(list, '処理後の /Title', report.after.info === null ? '（なし）' : ui().formatTitle(report.after.info));
    addFact(list, '処理後の dc:title', d.hasXmp ? (report.after.xmp === null ? '（なし）' : ui().formatTitle(report.after.xmp)) : '（XMP メタデータなし）');
    addFact(list, 'タブの表示（Edge / Chrome）', chromiumTab(report.after.info, name));
    addFact(list, 'タブの表示（Firefox）', firefoxTab(report.after.info, report.after.xmp, name));
    if (report.changes.length > 0) {
      addFact(list, '消した場所', report.changes.map(function (change) {
        return change.label + '：' + ui().formatNumber(change.length) + ' バイトを' +
          (change.kind === 'nullify' ? '丸ごと消去（使われなくなった古いデータ）' : '空白で塗りつぶし');
      }).join('\n'), 'lines');
    }
    if (report.appended.length > 0) {
      addFact(list, '末尾に追記したもの', report.appended.map(function (object) { return object.label; })
        .concat(['相互参照（' + (d.xrefKind === 'stream' ? 'ストリーム' : '表') + '）']).join('\n'), 'lines');
    }
    if (d.linearized) {
      addFact(list, 'Web 表示の最適化（線形化）', report.method === 'incremental'
        ? '追記保存のため外れました。表示や内容には影響しません（Web 上で大きなファイルを開くとき、最初のページが出るまでが少し遅くなることがあります）'
        : '保たれています（位置を 1 バイトも動かしていないため）');
    }
    addFact(list, '確認', report.method === 'none'
      ? '元のファイルをそのまま出力'
      : '出力を読み直し、タイトルが期待どおりで、過去の版にも残っていないことを確認済み');
    addFact(list, '保存したファイル名', name, 'mono');
  }

  function docReportFacts(list, report, item) {
    addFact(list, 'ファイル形式', '旧形式 .doc（OLE2 複合ファイル）');
    addFact(list, '行った処理',
      'SummaryInformation のタイトル（PIDSI_TITLE）を空文字にし、元の文字が入っていたバイトを 0 で塗りつぶしました');
    addFact(list, '処理後のタイトル', '（空）');
    addFact(list, '書き換えたストリーム', '\u0005' + report.changedStream, 'mono');
    addFact(list, '消したバイト数', ui().formatNumber(report.clearedByteCount) + ' バイト');
    addFact(list, '値の型 / コードページ', report.valueType + ' / ' + report.codePage + '（表示に使用）', 'mono');
    addFact(list, 'ファイル長',
      'ストリーム長を変えないため、ファイル全体の大きさは ' + ui().formatNumber(report.byteSizeAfter) + ' バイトのまま変わりません');
    addFact(list, '保存したファイル名', outputNameOf(item), 'mono');
  }

  function docxReportFacts(list, report, item) {
    addFact(list, 'ファイル形式', 'OOXML（.docx 系）');
    addFact(list, '行った処理', report.mode === 'clear'
      ? 'docProps/core.xml から <dc:title> を要素ごと取り除きました'
      : 'docProps/core.xml の <dc:title> に指定した文字列を設定しました');
    addFact(list, '処理後のタイトル', report.mode === 'clear'
      ? '（空／要素そのものが存在しません）'
      : ui().formatTitle(report.afterTitle));
    addFact(list, '書き換えたパート',
      (report.changedParts.length ? report.changedParts.join(' / ') : 'なし') +
      (report.addedParts.length ? '　＋新規作成: ' + report.addedParts.join(' / ') : ''));
    addFact(list, '無変更で複製したパート',
      ui().formatNumber(report.copiedPartCount) + ' / ' + ui().formatNumber(report.totalPartCount) +
      ' パート（圧縮データのままコピー）');
    addFact(list, 'core.xml の CRC-32',
      (report.coreCrcBefore === null ? '（元は存在しない）' : WTC.Zip.toHex8(report.coreCrcBefore)) +
      ' → ' + WTC.Zip.toHex8(report.coreCrcAfter), 'mono');
    addFact(list, '文字コード', report.encoding + '（XML 宣言も UTF-8 で出力）');
    addFact(list, '保存したファイル名', outputNameOf(item), 'mono');
  }

  function unchangedFacts(list, report, item) {
    addFact(list, '行った処理', report.format === 'doc'
      ? 'もともとタイトルが入っていないため、何も書き換えていません'
      : 'もともと <dc:title> が無いため、何も書き換えていません');
    addFact(list, '出力したファイル', report.format === 'doc'
      ? '元のファイルをそのまま出力（バイト単位で同一）'
      : '元のファイルをそのまま出力（全 ' + ui().formatNumber(report.totalPartCount) + ' パートがバイト単位で同一）');
    addFact(list, '保存したファイル名', outputNameOf(item), 'mono');
  }

  function wordBeforeFacts(list, item) {
    addFact(list, 'ファイル形式', item.format === 'doc' ? '旧形式 .doc（OLE2 複合ファイル）' : 'OOXML（.docx 系）');
    if (item.limitation) { addFact(list, 'この形式の制限', item.limitation); }
    if (item.format !== 'doc') {
      addFact(list, 'コアプロパティ',
        item.hasCorePart === false ? 'docProps/core.xml がありません' : 'docProps/core.xml あり');
    }
    addFact(list, '予定の出力ファイル名', item.outputName, 'mono');
    addFact(list, '根拠の詳細', '実行すると、書き換えた場所と検証値がここに出ます');
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */

  /** 根拠パネルの中身（DocumentFragment）を作る。 */
  function build(item) {
    var box = document.createDocumentFragment();
    var list = ui().el('div', 'facts');
    var report = item.report;

    if (item.status === STATUS.error) {
      box.appendChild(ui().el('p', 'facts__title', '処理できない理由'));
      errorFacts(list, item);
      box.appendChild(list);
      return box;
    }

    box.appendChild(ui().el('p', 'facts__title', report ? '実際に行った処理' : 'このファイルについて分かっていること'));
    if (report && report.format === 'pdf') {
      pdfReportFacts(list, item);
    } else if (report) {
      addFact(list, 'ファイルサイズ', ui().formatBytes(report.byteSizeBefore) + ' → ' + ui().formatBytes(report.byteSizeAfter));
      addFact(list, '処理前のタイトル', ui().formatTitle(report.beforeTitle));
      if (!report.changed) { unchangedFacts(list, report, item); }
      else if (report.format === 'doc') { docReportFacts(list, report, item); }
      else { docxReportFacts(list, report, item); }
      if (item.savedName && item.savedName !== item.outputName) {
        addFact(list, '次に実行したときの名前', item.outputName, 'mono');
      }
    } else if (item.format === 'pdf') {
      addFact(list, 'ファイルサイズ', ui().formatBytes(item.size));
      pdfBeforeFacts(list, item);
    } else {
      addFact(list, 'ファイルサイズ', ui().formatBytes(item.size));
      addFact(list, '処理前のタイトル', ui().formatTitle(item.currentTitle));
      wordBeforeFacts(list, item);
    }
    box.appendChild(list);
    return box;
  }

  WTC.DetailView = {
    build: build,
    chromiumTab: chromiumTab,
    firefoxTab: firefoxTab
  };
}(window));
