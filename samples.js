/*!
 * samples.js - 文書タイトル クリーニング
 * 動作確認用のサンプル（Word / PDF）をブラウザ内で生成する層。
 * 実際に Word や Edge で開ける最小構成の文書を作るので、
 * 処理結果をそのまま Word のプロパティ画面や、ブラウザのタブで確認できる。
 * PDF の組み立ては samples-pdf.js、旧形式 .doc は samples-doc.js が担当する。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Zip = WTC.Zip;

  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  function encode(text) {
    return new TextEncoder().encode(text);
  }

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function contentTypesXml(withCore) {
    return XML_DECLARATION +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      (withCore
        ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        : '') +
      '</Types>';
  }

  function rootRelsXml(withCore) {
    return XML_DECLARATION +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      (withCore
        ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        : '') +
      '</Relationships>';
  }

  function documentXml(paragraphs) {
    var body = paragraphs.map(function (text) {
      return '<w:p><w:r><w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r></w:p>';
    }).join('');
    return XML_DECLARATION +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1985" w:right="1701" w:bottom="1701" w:left="1701"' +
      ' w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';
  }

  function documentRelsXml() {
    return XML_DECLARATION +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  }

  /** title が null なら dc:title 要素そのものを作らない。'' なら空の要素を作る。 */
  function coreXml(options) {
    var titleElement = options.title === null
      ? ''
      : '<dc:title>' + escapeXml(options.title) + '</dc:title>';
    return XML_DECLARATION +
      '<cp:coreProperties' +
      ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
      ' xmlns:dcterms="http://purl.org/dc/terms/"' +
      ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      titleElement +
      '<dc:subject>サンプル用の件名</dc:subject>' +
      '<dc:creator>サンプル作成者</dc:creator>' +
      '<cp:keywords>サンプル</cp:keywords>' +
      '<dc:description>このファイルは動作確認用に生成されたものです。</dc:description>' +
      '<cp:lastModifiedBy>サンプル作成者</cp:lastModifiedBy>' +
      '<cp:revision>1</cp:revision>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T09:00:00Z</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T09:00:00Z</dcterms:modified>' +
      '</cp:coreProperties>';
  }

  /** 1 つの .docx を組み立てて File にする。 */
  function buildDocx(fileName, spec) {
    var parts = [
      { name: '[Content_Types].xml', text: contentTypesXml(spec.corePart) },
      { name: '_rels/.rels', text: rootRelsXml(spec.corePart) },
      { name: 'word/document.xml', text: documentXml(spec.paragraphs) },
      { name: 'word/_rels/document.xml.rels', text: documentRelsXml() }
    ];
    if (spec.corePart) {
      parts.push({ name: 'docProps/core.xml', text: coreXml({ title: spec.title }) });
    }

    return Promise.all(parts.map(function (part) {
      return Zip.createEntry(part.name, encode(part.text), {});
    })).then(function (entries) {
      var bytes = Zip.build(entries);
      return new File([bytes], fileName, { type: DOCX_MIME });
    });
  }

  /** ZIP ですらない壊れたファイル（エラー表示の確認用）。 */
  function buildBrokenFile(fileName) {
    var bytes = encode('This is not a ZIP archive. 壊れたファイルの動作確認用です。');
    return Promise.resolve(new File([bytes], fileName, { type: DOCX_MIME }));
  }

  var CATALOG = [
    {
      id: 'with-title',
      group: 'word',
      fileName: 'サンプル1_タイトルあり.docx',
      label: 'タイトルが入っている文書',
      note: 'dc:title に「社外秘_第一次案（差し替え前）」が入っています。空にする動作を確認できます。',
      build: function () {
        return buildDocx('サンプル1_タイトルあり.docx', {
          corePart: true,
          title: '社外秘_第一次案（差し替え前）',
          paragraphs: ['サンプル1: タイトルが設定されている文書です。']
        });
      }
    },
    {
      id: 'empty-title',
      group: 'word',
      fileName: 'サンプル2_タイトルが空文字.docx',
      label: 'タイトルが空文字の文書',
      note: 'dc:title はあるが中身が空。要素ごと取り除かれることを確認できます。',
      build: function () {
        return buildDocx('サンプル2_タイトルが空文字.docx', {
          corePart: true,
          title: '',
          paragraphs: ['サンプル2: タイトル要素が空文字の文書です。']
        });
      }
    },
    {
      id: 'without-title',
      group: 'word',
      fileName: 'サンプル3_タイトル要素なし.docx',
      label: 'タイトル要素が無い文書',
      note: 'core.xml はあるが dc:title が無い状態。既に空なので変更されないことを確認できます。',
      build: function () {
        return buildDocx('サンプル3_タイトル要素なし.docx', {
          corePart: true,
          title: null,
          paragraphs: ['サンプル3: タイトル要素が存在しない文書です。']
        });
      }
    },
    {
      id: 'no-core-part',
      group: 'word',
      fileName: 'サンプル4_コアプロパティなし.docx',
      label: 'コアプロパティ自体が無い文書',
      note: 'docProps/core.xml がありません。空にする場合は無変更、設定する場合はパートが新規作成されます。',
      build: function () {
        return buildDocx('サンプル4_コアプロパティなし.docx', {
          corePart: false,
          title: null,
          paragraphs: ['サンプル4: コアプロパティのパートが無い文書です。']
        });
      }
    },
    {
      id: 'japanese-long',
      group: 'word',
      fileName: 'サンプル5_日本語の長いタイトル.docx',
      label: '日本語の長いタイトルの文書',
      note: '全角文字を含む長いタイトルが正しく消える／置き換わることを確認できます。',
      build: function () {
        return buildDocx('サンプル5_日本語の長いタイトル.docx', {
          corePart: true,
          title: '令和六年度 第三四半期 業務改善提案書（社内限）＜第二版＞',
          paragraphs: ['サンプル5: 全角文字を含む長いタイトルの文書です。']
        });
      }
    },
    {
      id: 'same-base-name',
      group: 'word',
      fileName: 'サンプル6_名前が重複.docx',
      label: '出力名が重複するケース',
      note: 'サンプル1 と同じ内容です。同じ出力名になったときの (2) 付与を確認できます。',
      build: function () {
        return buildDocx('サンプル6_名前が重複.docx', {
          corePart: true,
          title: '社外秘_第一次案（差し替え前）',
          paragraphs: ['サンプル6: 出力名の重複を確認するための文書です。']
        });
      }
    },
    {
      id: 'doc-with-title',
      group: 'word',
      fileName: 'サンプル7_旧形式_タイトルあり.doc',
      label: '旧形式 .doc（タイトルあり）',
      note: 'Shift_JIS のタイトルが入った旧形式ファイル。空にする動作を確認できます（Word で開ける完全な文書ではありません）。',
      build: function () {
        return WTC.SamplesDoc.build('サンプル7_旧形式_タイトルあり.doc', true);
      }
    },
    {
      id: 'doc-without-title',
      group: 'word',
      fileName: 'サンプル8_旧形式_タイトルなし.doc',
      label: '旧形式 .doc（タイトルなし）',
      note: 'タイトルの項目が無い旧形式ファイル。無変更で出力されることを確認できます。',
      build: function () {
        return WTC.SamplesDoc.build('サンプル8_旧形式_タイトルなし.doc', false);
      }
    },
    {
      id: 'broken',
      group: 'word',
      fileName: 'サンプル9_壊れたファイル.docx',
      label: '読み取れない壊れたファイル',
      note: '拡張子は .docx ですが中身が ZIP ではありません。エラー表示を確認できます。',
      build: function () { return buildBrokenFile('サンプル9_壊れたファイル.docx'); }
    },
    {
      id: 'pdf-info-ascii',
      group: 'pdf',
      fileName: 'サンプル10_PDF_タイトルあり.pdf',
      label: 'PDF（タイトルあり・英数字）',
      note: 'Word から印刷して作った PDF によくある「Microsoft Word - Draft_v1.docx」がタイトルに入っています。Edge で開くと、タブにこの名前が出ます。',
      build: function () {
        return WTC.SamplesPdf.buildClassic('サンプル10_PDF_タイトルあり.pdf', {
          info: WTC.SamplesPdf.infoWith('Microsoft Word - Draft_v1.docx'),
          lines: ['サンプル10：タイトルが入った PDF', 'Edge で開き、タブに出る名前を処理の前後で見比べてください。']
        });
      }
    },
    {
      id: 'pdf-word-like',
      group: 'pdf',
      fileName: 'サンプル11_PDF_Word出力相当.pdf',
      label: 'PDF（Word 出力相当・日本語）',
      note: 'Word の「PDF として保存」と同じ作りで、/Title と XMP の両方に「社外秘_第一次案（差し替え前）」が入り、PDF/UA の準拠宣言もあります。空にするときの警告を確認できます。',
      build: function () {
        return WTC.SamplesPdf.buildWordLike('サンプル11_PDF_Word出力相当.pdf', {
          title: '社外秘_第一次案（差し替え前）',
          lines: ['サンプル11：Word から PDF にした文書と同じ作り', 'タイトルは /Title と XMP の 2 か所に入っています。']
        });
      }
    },
    {
      id: 'pdf-no-title',
      group: 'pdf',
      fileName: 'サンプル12_PDF_タイトルなし.pdf',
      label: 'PDF（タイトルなし）',
      note: 'タイトルが入っていない PDF。「空にする」では 1 バイトも変えずに出力されることを確認できます。',
      build: function () {
        return WTC.SamplesPdf.buildClassic('サンプル12_PDF_タイトルなし.pdf', {
          info: '<</Producer(Sample printer)/CreationDate(D:20240101090000Z)>>',
          lines: ['サンプル12：タイトルが入っていない PDF', 'タブにはファイル名が出ます。']
        });
      }
    },
    {
      id: 'pdf-compressed',
      group: 'pdf',
      fileName: 'サンプル13_PDF_圧縮メタデータ.pdf',
      label: 'PDF（タイトルが圧縮された場所にある）',
      note: 'Acrobat で最適化した PDF などと同じく、タイトルが圧縮された領域に入っています。追記保存で処理し、古い圧縮データも消すことを確認できます。',
      build: function () {
        return WTC.SamplesPdf.buildCompressed('サンプル13_PDF_圧縮メタデータ.pdf', {
          title: '令和六年度 業務改善提案書（社内限）',
          lines: ['サンプル13：タイトルが圧縮された場所にある PDF', 'オブジェクトストリームと圧縮 XMP を使っています。']
        });
      }
    },
    {
      id: 'pdf-password',
      group: 'pdf',
      fileName: 'サンプル14_PDF_パスワード付き.pdf',
      label: 'PDF（パスワード付き）',
      note: 'パスワードで保護された PDF。処理できない理由が表示されることを確認できます（パスワードが必要なため、Edge でも開けません）。',
      build: function () {
        return WTC.SamplesPdf.buildPasswordProtected('サンプル14_PDF_パスワード付き.pdf', {
          lines: ['サンプル14：パスワード付きの PDF']
        });
      }
    }
  ];

  /** 指定 ID（省略時は全部）のサンプル File を生成する。 */
  function create(ids) {
    var wanted = CATALOG.filter(function (item) {
      return !ids || ids.indexOf(item.id) >= 0;
    });
    return Promise.all(wanted.map(function (item) { return item.build(); }));
  }

  /* 一覧で見出しを付けてまとめる単位 */
  var GROUPS = [
    { id: 'word', label: 'Word', icon: 'fa-regular fa-file-word' },
    { id: 'pdf', label: 'PDF', icon: 'fa-regular fa-file-pdf' }
  ];

  WTC.Samples = {
    GROUPS: GROUPS,
    CATALOG: CATALOG,
    create: create
  };
}(window));
