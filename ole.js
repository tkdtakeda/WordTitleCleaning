/*!
 * ole.js - Word Title Tool
 * 旧形式 .doc の入れ物である OLE2 複合ファイル（CFBF）を読み書きする層。
 * DOM には触れない。
 *
 * このツールが必要とするのは次の 2 つだけ。
 *   - 名前を指定してストリームの中身を読む
 *   - 同じ長さのデータでストリームをその場で上書きする
 * 長さを変えないので FAT もセクタの並びも一切書き換えず、
 * 対象のバイト以外は元のファイルのまま残る。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};

  var SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  var ENDOFCHAIN = 0xfffffffe;
  var MAX_CHAIN = 1 << 21;              /* 壊れたファイルで無限ループしないための上限 */

  var TYPE = { empty: 0, storage: 1, stream: 2, root: 5 };

  function isOleFile(bytes) {
    if (!bytes || bytes.length < SIGNATURE.length) { return false; }
    for (var i = 0; i < SIGNATURE.length; i++) {
      if (bytes[i] !== SIGNATURE[i]) { return false; }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 読み込み
   * ------------------------------------------------------------------ */
  function readChain(table, start, label) {
    var chain = [];
    var sector = start;
    while (sector !== ENDOFCHAIN && sector < table.length) {
      chain.push(sector);
      if (chain.length > MAX_CHAIN) {
        throw new Error(label + ' のセクタ連結が壊れています');
      }
      sector = table[sector];
    }
    return chain;
  }

  function buildFat(bytes, view, sectorSize, header) {
    var perSector = sectorSize / 4;
    var fatSectors = [];
    var i;

    for (i = 0; i < 109 && fatSectors.length < header.fatSectorCount; i++) {
      var entry = view.getUint32(76 + i * 4, true);
      if (entry !== 0xffffffff) { fatSectors.push(entry); }
    }

    var difat = header.firstDifatSector;
    var guard = 0;
    while (difat !== ENDOFCHAIN && difat !== 0xffffffff && fatSectors.length < header.fatSectorCount) {
      var base = (difat + 1) * sectorSize;
      if (base + sectorSize > bytes.length) { throw new Error('DIFAT セクタが範囲外です'); }
      for (i = 0; i < perSector - 1 && fatSectors.length < header.fatSectorCount; i++) {
        var value = view.getUint32(base + i * 4, true);
        if (value !== 0xffffffff) { fatSectors.push(value); }
      }
      difat = view.getUint32(base + (perSector - 1) * 4, true);
      if (++guard > MAX_CHAIN) { throw new Error('DIFAT の連結が壊れています'); }
    }

    var fat = new Uint32Array(fatSectors.length * perSector);
    for (i = 0; i < fatSectors.length; i++) {
      var offset = (fatSectors[i] + 1) * sectorSize;
      if (offset + sectorSize > bytes.length) { throw new Error('FAT セクタが範囲外です'); }
      for (var k = 0; k < perSector; k++) {
        fat[i * perSector + k] = view.getUint32(offset + k * 4, true);
      }
    }
    return fat;
  }

  function buildMiniFat(view, sectorSize, fat, header) {
    var perSector = sectorSize / 4;
    var chain = header.miniFatSectorCount === 0
      ? [] : readChain(fat, header.firstMiniFatSector, 'ミニ FAT');
    var miniFat = new Uint32Array(chain.length * perSector);
    for (var i = 0; i < chain.length; i++) {
      var offset = (chain[i] + 1) * sectorSize;
      for (var k = 0; k < perSector; k++) {
        miniFat[i * perSector + k] = view.getUint32(offset + k * 4, true);
      }
    }
    return miniFat;
  }

  function readDirectory(view, sectorSize, fat, firstDirectorySector) {
    var chain = readChain(fat, firstDirectorySector, 'ディレクトリ');
    var perSector = sectorSize / 128;
    var entries = [];

    for (var i = 0; i < chain.length; i++) {
      var base = (chain[i] + 1) * sectorSize;
      for (var k = 0; k < perSector; k++) {
        var at = base + k * 128;
        var type = view.getUint8(at + 66);
        if (type === TYPE.empty) { continue; }

        var nameBytes = view.getUint16(at + 64, true);
        var name = '';
        for (var c = 0; c + 1 < nameBytes - 1; c += 2) {
          name += String.fromCharCode(view.getUint16(at + c, true));
        }
        entries.push({
          name: name,
          type: type,
          startSector: view.getUint32(at + 116, true),
          size: view.getUint32(at + 120, true),   /* v3 は下位 32bit のみ使う */
          directoryOffset: at
        });
      }
    }
    return entries;
  }

  /** ArrayBuffer を解析して、ストリームを引ける状態にする。 */
  function read(buffer) {
    var bytes = new Uint8Array(buffer);
    if (!isOleFile(bytes)) { throw new Error('OLE2 複合ファイルではありません'); }

    var view = new DataView(buffer);
    var sectorSize = 1 << view.getUint16(30, true);
    var miniSectorSize = 1 << view.getUint16(32, true);
    if (sectorSize < 128 || sectorSize > 65536 || miniSectorSize < 16) {
      throw new Error('セクタサイズが想定外です');
    }

    var header = {
      fatSectorCount: view.getUint32(44, true),
      firstDirectorySector: view.getUint32(48, true),
      miniCutoff: view.getUint32(56, true) || 4096,
      firstMiniFatSector: view.getUint32(60, true),
      miniFatSectorCount: view.getUint32(64, true),
      firstDifatSector: view.getUint32(68, true)
    };

    var fat = buildFat(bytes, view, sectorSize, header);
    var miniFat = buildMiniFat(view, sectorSize, fat, header);
    var entries = readDirectory(view, sectorSize, fat, header.firstDirectorySector);

    var root = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].type === TYPE.root) { root = entries[i]; break; }
    }
    if (!root) { throw new Error('ルートエントリが見つかりません'); }

    return {
      bytes: bytes,
      sectorSize: sectorSize,
      miniSectorSize: miniSectorSize,
      miniCutoff: header.miniCutoff,
      fat: fat,
      miniFat: miniFat,
      entries: entries,
      root: root
    };
  }

  /* ------------------------------------------------------------------ *
   * ストリームの位置計算
   * ------------------------------------------------------------------ */
  function normalSlices(container, startSector, size) {
    var slices = [];
    var remaining = size;
    var sector = startSector;
    var guard = 0;

    while (remaining > 0) {
      if (sector === ENDOFCHAIN || sector >= container.fat.length) {
        throw new Error('ストリームのセクタ連結が途中で切れています');
      }
      var length = Math.min(container.sectorSize, remaining);
      var offset = (sector + 1) * container.sectorSize;
      if (offset + length > container.bytes.length) {
        throw new Error('ストリームがファイルの範囲を超えています');
      }
      slices.push({ offset: offset, length: length });
      remaining -= length;
      sector = container.fat[sector];
      if (++guard > MAX_CHAIN) { throw new Error('ストリームの連結が壊れています'); }
    }
    return slices;
  }

  /** ミニストリーム内のバイト範囲を、実ファイル上の位置に置き換える。 */
  function mapIntoHost(target, host, start, length) {
    var consumed = 0;
    for (var i = 0; i < host.length && length > 0; i++) {
      var slice = host[i];
      var end = consumed + slice.length;
      if (start < end) {
        var inner = Math.max(start - consumed, 0);
        var take = Math.min(slice.length - inner, length);
        target.push({ offset: slice.offset + inner, length: take });
        start += take;
        length -= take;
      }
      consumed = end;
    }
    if (length > 0) { throw new Error('ミニストリームの範囲を超えています'); }
  }

  function miniSlices(container, startSector, size) {
    var host = normalSlices(container, container.root.startSector, container.root.size);
    var slices = [];
    var remaining = size;
    var sector = startSector;
    var guard = 0;

    while (remaining > 0) {
      if (sector === ENDOFCHAIN || sector >= container.miniFat.length) {
        throw new Error('ミニストリームの連結が途中で切れています');
      }
      var length = Math.min(container.miniSectorSize, remaining);
      mapIntoHost(slices, host, sector * container.miniSectorSize, length);
      remaining -= length;
      sector = container.miniFat[sector];
      if (++guard > MAX_CHAIN) { throw new Error('ミニストリームの連結が壊れています'); }
    }
    return slices;
  }

  function slicesOf(container, entry) {
    if (entry.size === 0) { return []; }
    return (entry.size < container.miniCutoff && entry !== container.root)
      ? miniSlices(container, entry.startSector, entry.size)
      : normalSlices(container, entry.startSector, entry.size);
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */
  function findStream(container, name) {
    for (var i = 0; i < container.entries.length; i++) {
      var entry = container.entries[i];
      if (entry.type === TYPE.stream && entry.name === name) { return entry; }
    }
    return null;
  }

  /** limit を渡すと先頭のその分だけ読む（巨大なストリームの判定用）。 */
  function readStream(container, entry, limit) {
    var slices = slicesOf(container, entry);
    var wanted = limit === undefined ? entry.size : Math.min(limit, entry.size);
    var out = new Uint8Array(wanted);
    var position = 0;
    for (var i = 0; i < slices.length && position < wanted; i++) {
      var take = Math.min(slices[i].length, wanted - position);
      out.set(container.bytes.subarray(slices[i].offset, slices[i].offset + take), position);
      position += take;
    }
    return out;
  }

  /**
   * ストリームを「同じ長さの」データで上書きした、ファイル全体のコピーを返す。
   * 長さが同じなのでセクタの割り当ては変わらず、対象バイト以外は元のまま。
   */
  function replaceStream(container, entry, data) {
    if (data.length !== entry.size) {
      throw new Error('ストリームの長さが変わる書き換えには対応していません');
    }
    var out = container.bytes.slice();
    var slices = slicesOf(container, entry);
    var position = 0;
    for (var i = 0; i < slices.length; i++) {
      out.set(data.subarray(position, position + slices[i].length), slices[i].offset);
      position += slices[i].length;
    }
    return out;
  }

  WTC.Ole = {
    TYPE: TYPE,
    isOleFile: isOleFile,
    read: read,
    findStream: findStream,
    readStream: readStream,
    replaceStream: replaceStream
  };
}(window));
