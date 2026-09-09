/*!
 * docx-title.js - Word Title Tool
 * OOXML(.docx/.docm/.dotx/.dotm) の docProps/core.xml にある
 * <dc:title> "だけ" を読み書きする層。UI には依存しない。
 */
(function (global) {
  'use strict';

  var WTC = global.WTC = global.WTC || {};
  var Zip = WTC.Zip;

  var PART = {
    contentTypes: '[Content_Types].xml',
    rootRels: '_rels/.rels',
    core: 'docProps/core.xml',
    document: 'word/document.xml'
  };

  var NS = {
    cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
    dc: 'http://purl.org/dc/elements/1.1/',
    dcterms: 'http://purl.org/dc/terms/',
    dcmitype: 'http://purl.org/dc/dcmitype/',
    xsi: 'http://www.w3.org/2001/XMLSchema-instance',
    contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
    relationships: 'http://schemas.openxmlformats.org/package/2006/relationships'
  };

  var CORE_CONTENT_TYPE = 'application/vnd.openxmlformats-package.core-properties+xml';
  var CORE_REL_TYPE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
  var XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  var EMPTY_CORE_XML = XML_DECLARATION +
    '<cp:coreProperties' +
    ' xmlns:cp="' + NS.cp + '"' +
    ' xmlns:dc="' + NS.dc + '"' +
    ' xmlns:dcterms="' + NS.dcterms + '"' +
    ' xmlns:dcmitype="' + NS.dcmitype + '"' +
    ' xmlns:xsi="' + NS.xsi + '"></cp:coreProperties>';

  var SUPPORTED_EXTENSIONS = ['.docx', '.docm', '.dotx', '.dotm'];

  /* XML 1.0 で使えない制御文字 */
  var INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

  /* ------------------------------------------------------------------ *
   * 小さなヘルパー
   * ------------------------------------------------------------------ */
  function decodeUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function encodeUtf8(text) {
    return new TextEncoder().encode(text);
  }

  function parseXml(text, label) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error(label + ' の XML 解析に失敗しました');
    }
    return doc;
  }

  function serializeXml(doc) {
    return XML_DECLARATION + new XMLSerializer().serializeToString(doc.documentElement);
  }

  function findEntry(entries, name) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === name) { return i; }
    }
    return -1;
  }

  /** XML で使えない制御文字を取り除く。 */
  function sanitizeTitle(text) {
    return String(text == null ? '' : text).replace(INVALID_XML_CHARS, '');
  }

  function hasSupportedExtension(fileName) {
    var lower = String(fileName).toLowerCase();
    for (var i = 0; i < SUPPORTED_EXTENSIONS.length; i++) {
      var ext = SUPPORTED_EXTENSIONS[i];
      if (lower.slice(-ext.length) === ext) { return true; }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * core.xml の操作
   * ------------------------------------------------------------------ */
  function readTitleFromCoreXml(text) {
    var doc = parseXml(text, PART.core);
    var found = doc.documentElement.getElementsByTagNameNS(NS.dc, 'title');
    return found.length > 0 ? found[0].textContent : null;
  }

  /**
   * dc:title を設定した core.xml 文字列を返す。
   * 既存要素があれば中身だけ差し替え（並び順は保持）、
   * 無ければ Word 自身の出力と同じく先頭に挿入する。
   */
  function writeTitleToCoreXml(text, title) {
    var doc = parseXml(text, PART.core);
    var root = doc.documentElement;
    var found = root.getElementsByTagNameNS(NS.dc, 'title');
    var element;

    if (found.length > 0) {
      element = found[0];
      while (element.firstChild) { element.removeChild(element.firstChild); }
    } else {
      element = doc.createElementNS(NS.dc, 'dc:title');
      root.insertBefore(element, root.firstChild);
    }
    element.appendChild(doc.createTextNode(title));
    return serializeXml(doc);
  }

  /** [Content_Types].xml に core.xml の Override を足す（無い場合のみ）。 */
  function ensureCoreContentType(text) {
    var doc = parseXml(text, PART.contentTypes);
    var overrides = doc.documentElement.getElementsByTagNameNS(NS.contentTypes, 'Override');
    for (var i = 0; i < overrides.length; i++) {
      if (overrides[i].getAttribute('PartName') === '/' + PART.core) { return null; }
    }
    var override = doc.createElementNS(NS.contentTypes, 'Override');
    override.setAttribute('PartName', '/' + PART.core);
    override.setAttribute('ContentType', CORE_CONTENT_TYPE);
    doc.documentElement.appendChild(override);
    return serializeXml(doc);
  }

  /** _rels/.rels に core.xml へのリレーションを足す（無い場合のみ）。 */
  function ensureCoreRelationship(text) {
    var doc = parseXml(text, PART.rootRels);
    var list = doc.documentElement.getElementsByTagNameNS(NS.relationships, 'Relationship');
    var used = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('Type') === CORE_REL_TYPE) { return null; }
      used[list[i].getAttribute('Id')] = true;
    }
    var index = list.length + 1;
    var id = 'rId' + index;
    while (used[id]) { index++; id = 'rId' + index; }

    var relationship = doc.createElementNS(NS.relationships, 'Relationship');
    relationship.setAttribute('Id', id);
    relationship.setAttribute('Type', CORE_REL_TYPE);
    relationship.setAttribute('Target', PART.core);
    doc.documentElement.appendChild(relationship);
    return serializeXml(doc);
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */

  /** 既存パートを書き換える（patcher が null を返したら変更なし）。 */
  function patchPart(entries, partName, patcher, changedParts) {
    var index = findEntry(entries, partName);
    if (index < 0) {
      return Promise.reject(new Error(partName + ' が見つからないため、コアプロパティを追加できません'));
    }
    var before = entries[index];
    return Zip.readEntryBytes(before).then(function (bytes) {
      var updated = patcher(decodeUtf8(bytes));
      if (updated === null) { return null; }
      return Zip.createEntry(partName, encodeUtf8(updated), {}).then(function (entry) {
        entry.date = before.date;
        entry.time = before.time;
        entries[index] = entry;
        changedParts.push(partName);
        return null;
      });
    });
  }

  /**
   * ファイルを解析して現在のタイトルなどを返す（書き換えはしない）。
   */
  function inspect(file) {
    if (!hasSupportedExtension(file.name)) {
      return Promise.reject(new Error('対応していない拡張子です（対応: ' + SUPPORTED_EXTENSIONS.join(' / ') + '）'));
    }
    return file.arrayBuffer().then(function (buffer) {
      var entries = Zip.read(buffer);
      if (findEntry(entries, PART.document) < 0) {
        throw new Error('Word 文書ではありません（word/document.xml が見つかりません）');
      }
      var coreIndex = findEntry(entries, PART.core);
      if (coreIndex < 0) {
        return {
          entries: entries, coreIndex: -1, currentTitle: null,
          hasCorePart: false, byteSize: buffer.byteLength
        };
      }
      return Zip.readEntryBytes(entries[coreIndex]).then(function (bytes) {
        return {
          entries: entries,
          coreIndex: coreIndex,
          currentTitle: readTitleFromCoreXml(decodeUtf8(bytes)),
          hasCorePart: true,
          byteSize: buffer.byteLength
        };
      });
    });
  }

  /**
   * タイトルを設定した新しいファイルの Blob と、根拠レポートを返す。
   * docProps/core.xml 以外のパートは圧縮済みバイト列のまま複製する。
   */
  function applyTitle(file, rawTitle) {
    var title = sanitizeTitle(rawTitle);
    return inspect(file).then(function (info) {
      var entries = info.entries.slice();
      var changedParts = [];
      var addedParts = [];
      var work;

      if (info.coreIndex >= 0) {
        work = Zip.readEntryBytes(entries[info.coreIndex]).then(function (bytes) {
          var before = entries[info.coreIndex];
          var updated = writeTitleToCoreXml(decodeUtf8(bytes), title);
          return Zip.createEntry(PART.core, encodeUtf8(updated), {}).then(function (entry) {
            entry.date = before.date;
            entry.time = before.time;
            entries[info.coreIndex] = entry;
            changedParts.push(PART.core);
            return { crcBefore: before.crc, crcAfter: entry.crc };
          });
        });
      } else {
        work = Zip.createEntry(PART.core, encodeUtf8(writeTitleToCoreXml(EMPTY_CORE_XML, title)), {})
          .then(function (entry) {
            entries.push(entry);
            addedParts.push(PART.core);
            return patchPart(entries, PART.contentTypes, ensureCoreContentType, changedParts)
              .then(function () {
                return patchPart(entries, PART.rootRels, ensureCoreRelationship, changedParts);
              })
              .then(function () { return { crcBefore: null, crcAfter: entry.crc }; });
          });
      }

      return work.then(function (crc) {
        var bytes = Zip.build(entries);
        var blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
        return {
          blob: blob,
          report: {
            beforeTitle: info.currentTitle,
            afterTitle: title,
            createdCorePart: info.coreIndex < 0,
            changedParts: changedParts,
            addedParts: addedParts,
            copiedPartCount: entries.length - changedParts.length - addedParts.length,
            totalPartCount: entries.length,
            coreCrcBefore: crc.crcBefore,
            coreCrcAfter: crc.crcAfter,
            byteSizeBefore: info.byteSize,
            byteSizeAfter: bytes.length,
            encoding: 'UTF-8'
          }
        };
      });
    });
  }

  WTC.DocxTitle = {
    SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS,
    hasSupportedExtension: hasSupportedExtension,
    sanitizeTitle: sanitizeTitle,
    inspect: inspect,
    applyTitle: applyTitle
  };
}(window));
