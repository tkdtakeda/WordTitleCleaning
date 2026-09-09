/*!
 * samples-doc.js - Word Title Tool
 * 旧形式 .doc の動作確認用サンプルを組み立てる層。
 *
 * OLE2 複合ファイルとして正しく、SummaryInformation に日本語タイトルが
 * 入ったファイルを作る。タイトルの読み取り・削除の確認が目的なので、
 * Word で開ける完全な文書ではない（本文の構造は持たせていない）。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var DOC_MIME = 'application/msword';
  var SECTOR = 512;
  var MINI_SECTOR = 64;
  var FREESECT = 0xffffffff;
  var ENDOFCHAIN = 0xfffffffe;
  var FATSECT = 0xfffffffd;

  /* cp932（Shift_JIS）で符号化した「社外秘_旧形式サンプル」 */
  var TITLE_SJIS = [
    0x8e, 0xd0, 0x8a, 0x4f, 0x94, 0xe9, 0x5f, 0x8b, 0x8c, 0x8c, 0x60,
    0x8e, 0xae, 0x83, 0x54, 0x83, 0x93, 0x83, 0x76, 0x83, 0x8b
  ];
  /* 同じく「サンプル作成者」 */
  var AUTHOR_SJIS = [
    0x83, 0x54, 0x83, 0x93, 0x83, 0x76, 0x83, 0x8b, 0x8d, 0xec, 0x90, 0xac, 0x8e, 0xd2
  ];

  var FMTID_SUMMARY = [
    0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10,
    0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9
  ];

  function align4(value) { return (value + 3) & ~3; }

  /* ------------------------------------------------------------------ *
   * SummaryInformation のプロパティセット
   * ------------------------------------------------------------------ */
  function buildSummaryStream(titleBytes) {
    /* コードページ(1) / タイトル(2) / 作成者(4)。titleBytes が null ならタイトルを作らない */
    var withTitle = titleBytes !== null;
    var propertyCount = withTitle ? 3 : 2;

    var codePageAt = 8 + propertyCount * 8;
    var titleAt = codePageAt + 8;
    var titleSize = withTitle ? 8 + align4(titleBytes.length + 1) : 0;
    var authorAt = titleAt + titleSize;
    var authorSize = 8 + align4(AUTHOR_SJIS.length + 1);
    var sectionSize = authorAt + authorSize;

    var bytes = new Uint8Array(48 + sectionSize);
    var view = new DataView(bytes.buffer);

    view.setUint16(0, 0xfffe, true);           /* バイト順 */
    view.setUint16(2, 0, true);                /* 版 */
    view.setUint32(4, 0x00020105, true);       /* システム識別子 */
    view.setUint32(24, 1, true);               /* セクション数 */
    bytes.set(FMTID_SUMMARY, 28);
    view.setUint32(44, 48, true);              /* セクションの位置 */

    var base = 48;
    var slot = base + 8;
    view.setUint32(base, sectionSize, true);
    view.setUint32(base + 4, propertyCount, true);

    view.setUint32(slot, 1, true); view.setUint32(slot + 4, codePageAt, true); slot += 8;
    if (withTitle) {
      view.setUint32(slot, 2, true); view.setUint32(slot + 4, titleAt, true); slot += 8;
    }
    view.setUint32(slot, 4, true); view.setUint32(slot + 4, authorAt, true);

    view.setUint32(base + codePageAt, 2, true);          /* VT_I2 */
    view.setInt16(base + codePageAt + 4, 932, true);     /* cp932 */

    if (withTitle) {
      view.setUint32(base + titleAt, 30, true);          /* VT_LPSTR */
      view.setUint32(base + titleAt + 4, titleBytes.length + 1, true);
      bytes.set(titleBytes, base + titleAt + 8);
    }

    view.setUint32(base + authorAt, 30, true);
    view.setUint32(base + authorAt + 4, AUTHOR_SJIS.length + 1, true);
    bytes.set(AUTHOR_SJIS, base + authorAt + 8);

    return bytes;
  }

  /** 形式判定を通すための最小の WordDocument ストリーム。 */
  function buildWordDocumentStream() {
    var bytes = new Uint8Array(256);
    var view = new DataView(bytes.buffer);
    view.setUint16(0, 0xa5ec, true);   /* wIdent */
    view.setUint16(2, 0x00c1, true);   /* nFib: Word 97 */
    view.setUint16(6, 0x0411, true);   /* lid: 日本語 */
    view.setUint16(10, 0x0000, true);  /* flags: 暗号化なし */
    return bytes;
  }

  /* ------------------------------------------------------------------ *
   * OLE2 の組み立て
   * ------------------------------------------------------------------ */
  function writeName(view, at, name) {
    for (var i = 0; i < name.length; i++) {
      view.setUint16(at + i * 2, name.charCodeAt(i), true);
    }
    view.setUint16(at + 64, (name.length + 1) * 2, true);
  }

  function writeDirectoryEntry(view, at, spec) {
    writeName(view, at, spec.name);
    view.setUint8(at + 66, spec.type);
    view.setUint8(at + 67, 1);                       /* 色: 黒 */
    view.setUint32(at + 68, spec.left, true);
    view.setUint32(at + 72, spec.right, true);
    view.setUint32(at + 76, spec.child, true);
    view.setUint32(at + 116, spec.startSector, true);
    view.setUint32(at + 120, spec.size, true);
  }

  function buildOleFile(streams) {
    /* ミニストリームに全ストリームを並べる */
    var miniParts = [];
    var miniSectorCount = 0;
    streams.forEach(function (stream) {
      var used = Math.max(1, Math.ceil(stream.bytes.length / MINI_SECTOR));
      miniParts.push({ start: miniSectorCount, used: used, stream: stream });
      miniSectorCount += used;
    });

    var miniStreamSize = miniSectorCount * MINI_SECTOR;
    var miniStream = new Uint8Array(miniStreamSize);
    miniParts.forEach(function (part) {
      miniStream.set(part.stream.bytes, part.start * MINI_SECTOR);
    });

    var miniStreamSectors = Math.max(1, Math.ceil(miniStreamSize / SECTOR));
    var firstMiniStreamSector = 3;
    var totalSectors = firstMiniStreamSector + miniStreamSectors;

    var file = new Uint8Array(SECTOR * (totalSectors + 1));
    var view = new DataView(file.buffer);
    var i;

    /* --- ヘッダー --- */
    file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    view.setUint16(24, 0x003e, true);            /* マイナー版 */
    view.setUint16(26, 0x0003, true);            /* メジャー版 3 */
    view.setUint16(28, 0xfffe, true);
    view.setUint16(30, 9, true);                 /* セクタ 512 バイト */
    view.setUint16(32, 6, true);                 /* ミニセクタ 64 バイト */
    view.setUint32(44, 1, true);                 /* FAT セクタ数 */
    view.setUint32(48, 1, true);                 /* 最初のディレクトリセクタ */
    view.setUint32(56, 4096, true);              /* ミニストリームの閾値 */
    view.setUint32(60, 2, true);                 /* 最初のミニ FAT セクタ */
    view.setUint32(64, 1, true);                 /* ミニ FAT セクタ数 */
    view.setUint32(68, ENDOFCHAIN, true);        /* DIFAT セクタなし */
    view.setUint32(72, 0, true);
    view.setUint32(76, 0, true);                 /* DIFAT[0] = FAT はセクタ 0 */
    for (i = 1; i < 109; i++) { view.setUint32(76 + i * 4, FREESECT, true); }

    /* --- セクタ 0: FAT --- */
    var fatAt = SECTOR;
    for (i = 0; i < SECTOR / 4; i++) { view.setUint32(fatAt + i * 4, FREESECT, true); }
    view.setUint32(fatAt + 0 * 4, FATSECT, true);
    view.setUint32(fatAt + 1 * 4, ENDOFCHAIN, true);
    view.setUint32(fatAt + 2 * 4, ENDOFCHAIN, true);
    for (i = 0; i < miniStreamSectors; i++) {
      var sector = firstMiniStreamSector + i;
      view.setUint32(fatAt + sector * 4, i === miniStreamSectors - 1 ? ENDOFCHAIN : sector + 1, true);
    }

    /* --- セクタ 1: ディレクトリ --- */
    var dirAt = SECTOR * 2;
    writeDirectoryEntry(view, dirAt, {
      name: 'Root Entry', type: 5, left: FREESECT, right: FREESECT, child: 1,
      startSector: firstMiniStreamSector, size: miniStreamSize
    });
    miniParts.forEach(function (part, index) {
      writeDirectoryEntry(view, dirAt + (index + 1) * 128, {
        name: part.stream.name, type: 2,
        left: FREESECT,
        /* 次のストリームを右の兄弟にして、単純な連結にする */
        right: index + 1 < miniParts.length ? index + 2 : FREESECT,
        child: FREESECT,
        startSector: part.start, size: part.stream.bytes.length
      });
    });

    /* --- セクタ 2: ミニ FAT --- */
    var miniFatAt = SECTOR * 3;
    for (i = 0; i < SECTOR / 4; i++) { view.setUint32(miniFatAt + i * 4, FREESECT, true); }
    miniParts.forEach(function (part) {
      for (var k = 0; k < part.used; k++) {
        var index = part.start + k;
        view.setUint32(miniFatAt + index * 4, k === part.used - 1 ? ENDOFCHAIN : index + 1, true);
      }
    });

    /* --- セクタ 3 以降: ミニストリームの中身 --- */
    file.set(miniStream, SECTOR * (firstMiniStreamSector + 1));
    return file;
  }

  /**
   * @param {boolean} withTitle タイトルを入れるかどうか
   */
  function buildDocSample(fileName, withTitle) {
    var streams = [
      { name: 'WordDocument', bytes: buildWordDocumentStream() },
      {
        name: '\u0005SummaryInformation',
        bytes: buildSummaryStream(withTitle ? TITLE_SJIS : null)
      }
    ];
    var bytes = buildOleFile(streams);
    return Promise.resolve(new File([bytes], fileName, { type: DOC_MIME }));
  }

  WTC.SamplesDoc = { build: buildDocSample };
}(window));
