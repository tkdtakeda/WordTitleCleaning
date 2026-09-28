/*!
 * pdf-filters.js - 文書タイトル クリーニング
 * PDF ストリームの圧縮を解く層。DOM には触れない。
 *
 * 対応するのは FlateDecode（と、相互参照ストリームでよく使われる
 * PNG / TIFF 予測子）だけ。タイトルが入る場所（相互参照・オブジェクト
 * ストリーム・XMP）はほぼ例外なくこの形式で圧縮されているため。
 * 展開はブラウザ標準の DecompressionStream を使い、外部ライブラリは使わない。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Syntax = WTC.PdfSyntax;

  function pipe(bytes, format) {
    var stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream(format));
    return new Response(stream).arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  /**
   * zlib 形式のデータを展開する。
   * 検査値（Adler-32）が壊れている・欠けているファイルも実在するので、
   * 失敗したら zlib の見出しを外した生の deflate として読み直す。
   */
  function inflate(bytes) {
    return pipe(bytes, 'deflate').catch(function () {
      return pipe(bytes.subarray(2, Math.max(2, bytes.length - 4)), 'deflate-raw');
    }).catch(function () {
      return pipe(bytes.subarray(2), 'deflate-raw');
    }).catch(function () {
      throw new Error('圧縮されたデータを展開できませんでした（FlateDecode）');
    });
  }

  /** 圧縮する（出力は zlib 形式＝FlateDecode）。 */
  function deflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new global.CompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  /* ------------------------------------------------------------------ *
   * 予測子
   * ------------------------------------------------------------------ */
  function parmNumber(parms, key, fallback) {
    var value = Syntax.numberOf(Syntax.dictGet(parms, key));
    return value === null ? fallback : value;
  }

  function paeth(left, up, upLeft) {
    var p = left + up - upLeft;
    var pa = Math.abs(p - left);
    var pb = Math.abs(p - up);
    var pc = Math.abs(p - upLeft);
    if (pa <= pb && pa <= pc) { return left; }
    return pb <= pc ? up : upLeft;
  }

  function undoPng(data, rowLength, bpp) {
    var rows = Math.floor(data.length / (rowLength + 1));
    var out = new Uint8Array(rows * rowLength);
    var prev = new Uint8Array(rowLength);

    for (var r = 0; r < rows; r++) {
      var type = data[r * (rowLength + 1)];
      var src = r * (rowLength + 1) + 1;
      var dst = r * rowLength;
      for (var i = 0; i < rowLength; i++) {
        var raw = data[src + i];
        var left = i >= bpp ? out[dst + i - bpp] : 0;
        var up = prev[i];
        var upLeft = i >= bpp ? prev[i - bpp] : 0;
        var value;
        switch (type) {
          case 0: value = raw; break;
          case 1: value = raw + left; break;
          case 2: value = raw + up; break;
          case 3: value = raw + ((left + up) >> 1); break;
          case 4: value = raw + paeth(left, up, upLeft); break;
          default: throw new Error('PNG 予測子の種類が不正です（' + type + '）');
        }
        out[dst + i] = value & 0xff;
      }
      prev = out.subarray(dst, dst + rowLength);
    }
    return out;
  }

  function undoTiff(data, rowLength, bpp) {
    var out = new Uint8Array(data.length);
    for (var start = 0; start < data.length; start += rowLength) {
      for (var i = 0; i < rowLength && start + i < data.length; i++) {
        var left = i >= bpp ? out[start + i - bpp] : 0;
        out[start + i] = (data[start + i] + left) & 0xff;
      }
    }
    return out;
  }

  function undoPredictor(data, parms) {
    var predictor = parmNumber(parms, 'Predictor', 1);
    if (predictor <= 1) { return data; }
    var colors = parmNumber(parms, 'Colors', 1);
    var bits = parmNumber(parms, 'BitsPerComponent', 8);
    var columns = parmNumber(parms, 'Columns', 1);
    var bpp = Math.max(1, Math.ceil(colors * bits / 8));
    var rowLength = Math.ceil(colors * bits * columns / 8);

    if (predictor >= 10) { return undoPng(data, rowLength, bpp); }
    if (predictor === 2 && bits === 8) { return undoTiff(data, rowLength, bpp); }
    throw new Error('未対応の予測子です（Predictor ' + predictor + '）');
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */
  function listOf(value) {
    if (!value || value.kind === Syntax.KIND.nil) { return []; }
    return value.kind === Syntax.KIND.array ? value.value : [value];
  }

  /** ストリームが圧縮されているか（/Filter があるか）。 */
  function isFiltered(dict) {
    return listOf(Syntax.dictGet(dict, 'Filter')).length > 0;
  }

  /**
   * ストリーム本体を展開する。
   * @param {Uint8Array} data  ファイルから切り出したストリーム本体
   * @param {object}     dict  ストリーム辞書（PdfSyntax の辞書ノード）
   */
  function decode(data, dict) {
    var filters = listOf(Syntax.dictGet(dict, 'Filter'));
    var parms = listOf(Syntax.dictGet(dict, 'DecodeParms'));
    return filters.reduce(function (chain, filter, index) {
      return chain.then(function (bytes) {
        var name = Syntax.nameOf(filter);
        if (name === 'FlateDecode' || name === 'Fl') {
          return inflate(bytes).then(function (out) { return undoPredictor(out, parms[index]); });
        }
        throw new Error('未対応の圧縮形式です（' + (name || '不明') + '）');
      });
    }, Promise.resolve(data));
  }

  WTC.PdfFilters = {
    decode: decode,
    deflate: deflate,
    isFiltered: isFiltered
  };
}(window));
