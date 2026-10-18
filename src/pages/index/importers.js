/**
 * BandTOTP-NEXT 导入解析器
 *
 * 支持以下输入（字符串或已解析对象）：
 *   1. Aegis 明文导出 / 数据库 JSON      {"version":1,"header":{...},"db":{...}}
 *   2. Aegis 数据库对象                  {"version":3,"entries":[...]}
 *   3. Aegis 加密备份                    {"header":{"slots":[...]},"db":"<base64>"}  -> 提示先解密
 *   4. 旧版 BandTOTP 载荷                {"list":[{name,usr,key,...}]}
 *   5. otpauth:// 文本（每行一条）       totp / steam / hotp / yaotp / motp
 *   6. Google Authenticator 迁移链接     otpauth-migration://offline?data=...
 *   7. 单条条目对象
 */
import {
  normalizeEntry,
  base32Encode,
  base32Decode,
  hexToBase32,
  isHexSecret,
  utf8Decode
} from './totp';

var KNOWN_TYPES = { totp: 1, steam: 1, hotp: 1, yandex: 1, motp: 1 };

function fail(message, code) {
  return { ok: false, error: message, code: code || 'PARSE' };
}

function ok(entries, source, warnings) {
  return { ok: true, entries: entries, source: source, warnings: warnings || [] };
}

/* ------------------------------------------------------------------ */
/* 公开入口                                                            */
/* ------------------------------------------------------------------ */

function parsePayload(payload) {
  var warnings = [];

  if (payload === null || payload === undefined) return fail('消息为空');

  if (typeof payload === 'object') {
    return parseObject(payload, warnings);
  }

  var text = String(payload).trim();
  if (!text) return fail('消息为空');

  if (text.charAt(0) === '{' || text.charAt(0) === '[') {
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }
    if (parsed !== null) return parseObject(parsed, warnings);
  }

  if (/otpauth/i.test(text) || /motp:\/\//i.test(text)) {
    return parseUriText(text, warnings);
  }

  return fail('无法识别的数据格式');
}

function parseObject(obj, warnings) {
  if (Array.isArray(obj)) {
    return fromEntryArray(obj, warnings, 'list');
  }

  // Aegis 数据库对象
  if (Array.isArray(obj.entries)) {
    return fromAegisDb(obj, warnings);
  }

  // Aegis VaultFile（含加密备份）
  if (obj.db !== undefined) {
    return fromVaultFile(obj, warnings);
  }

  // 旧版 / 客户端载荷
  if (Array.isArray(obj.list)) {
    return fromList(obj.list, warnings);
  }

  if (Array.isArray(obj.uris)) {
    return parseUriText(obj.uris.join('\n'), warnings);
  }
  if (typeof obj.otpauth === 'string') {
    return parseUriText(obj.otpauth, warnings);
  }

  // 单条条目
  if (obj.info || obj.key || obj.secret) {
    return fromEntryArray([obj], warnings, 'single');
  }

  return fail('JSON 中没有可导入的令牌');
}

/* ------------------------------------------------------------------ */
/* Aegis                                                               */
/* ------------------------------------------------------------------ */

function fromVaultFile(obj, warnings) {
  var header = obj.header || {};
  var slots = header.slots;

  if (slots && slots.length) {
    var hasPasswordSlot = false;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].type === 1) hasPasswordSlot = true;
    }
    return fail(
      hasPasswordSlot
        ? '这是 Aegis 加密备份，请先用配套工具（tools/aegis2band.js 或 tools/aegis-import.html）解密后再导入手环'
        : '暂不支持此类 Aegis 备份（未找到密码槽）',
      'ENCRYPTED'
    );
  }

  if (typeof obj.db === 'string') {
    return fail(
      '这是 Aegis 加密备份，请先用配套工具（tools/aegis2band.js 或 tools/aegis-import.html）解密后再导入手环',
      'ENCRYPTED'
    );
  }

  if (!obj.db || !Array.isArray(obj.db.entries)) {
    return fail('Aegis 备份中缺少 db.entries');
  }

  return fromAegisDb(obj.db, warnings);
}

function fromAegisDb(db, warnings) {
  var entries = [];
  var skipped = 0;

  for (var i = 0; i < db.entries.length; i++) {
    var converted = convertAegisEntry(db.entries[i], warnings);
    if (converted) entries.push(converted);
    else skipped++;
  }

  if (entries.length === 0) {
    return fail('Aegis 数据集里没有可导入的令牌' + (skipped ? '（已跳过 ' + skipped + ' 条）' : ''));
  }

  return ok(entries, 'aegis', warnings);
}

function convertAegisEntry(entry, warnings) {
  if (!entry || typeof entry !== 'object') return null;

  var type = String(entry.type || '').toLowerCase();
  if (!KNOWN_TYPES[type]) {
    warnings.push('跳过未知令牌类型: ' + (entry.type || '空'));
    return null;
  }

  var info = entry.info || {};
  var secret = String(info.secret || entry.key || '').replace(/[\s\-]/g, '').toUpperCase();
  if (!secret) {
    warnings.push('跳过没有密钥的条目: ' + (entry.issuer || entry.name || ''));
    return null;
  }

  var name = entry.issuer || entry.name || '';
  var usr = entry.issuer ? (entry.name || '') : '';

  return normalizeEntry({
    name: name,
    usr: usr,
    key: secret,
    type: type,
    algorithm: info.algo || undefined,
    digits: info.digits,
    period: info.period,
    counter: info.counter,
    pin: info.pin,
    favorite: entry.favorite === true
  });
}

/* ------------------------------------------------------------------ */
/* 旧版载荷 / 单条                                                     */
/* ------------------------------------------------------------------ */

function fromList(list, warnings) {
  return fromEntryArray(list, warnings, 'list');
}

function fromEntryArray(array, warnings, source) {
  var entries = [];
  var skipped = 0;

  for (var i = 0; i < array.length; i++) {
    var raw = array[i];
    if (!raw || typeof raw !== 'object') {
      skipped++;
      continue;
    }

    // Aegis 条目格式（info 对象）
    if (raw.info) {
      var converted = convertAegisEntry(raw, warnings);
      if (converted) entries.push(converted);
      else skipped++;
      continue;
    }

    var key = String(raw.key || raw.secret || '').replace(/[\s\-]/g, '').toUpperCase();
    if (!key) {
      skipped++;
      continue;
    }

    entries.push(normalizeEntry({
      name: raw.name || raw.issuer,
      usr: raw.usr || raw.account,
      key: key,
      type: raw.type,
      algorithm: raw.algorithm,
      digits: raw.digits,
      period: raw.period,
      counter: raw.counter,
      pin: raw.pin,
      favorite: raw.favorite === true
    }));
  }

  if (entries.length === 0) {
    return fail('没有可导入的令牌' + (skipped ? '（已跳过 ' + skipped + ' 条）' : ''));
  }

  return ok(entries, source, warnings);
}

/* ------------------------------------------------------------------ */
/* otpauth URI                                                         */
/* ------------------------------------------------------------------ */

function parseUriText(text, warnings) {
  var uris = extractUris(text);
  if (uris.length === 0) return fail('没有找到 otpauth:// 链接');

  var entries = [];
  var seen = {};
  var migrationCount = 0;

  for (var i = 0; i < uris.length; i++) {
    var uri = uris[i];

    if (/^otpauth-migration:/i.test(uri)) {
      var migrated = parseMigrationUri(uri);
      if (migrated) {
        for (var m = 0; m < migrated.length; m++) {
          var fp = JSON.stringify(migrated[m]);
          if (!seen[fp]) {
            seen[fp] = true;
            entries.push(migrated[m]);
            migrationCount++;
          }
        }
      }
      continue;
    }

    var entry = parseOtpauthUri(uri);
    if (entry) {
      var fingerprint = JSON.stringify(entry);
      if (!seen[fingerprint]) {
        seen[fingerprint] = true;
        entries.push(entry);
      }
    } else {
      warnings.push('跳过无法解析的链接: ' + uri.substring(0, 48));
    }
  }

  if (entries.length === 0) return fail('链接中没有可导入的令牌');

  return ok(entries, migrationCount ? 'migration' : 'otpauth', warnings);
}

function extractUris(text) {
  var normalized = String(text)
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  var found = [];
  var re = /(otpauth(?:-migration)?|motp):\/\/[^\s"'<>`,)\]}\uff0c\u3002\uff1b\u3001]+/gi;
  var matches = normalized.match(re) || [];

  for (var i = 0; i < matches.length; i++) {
    // 去掉行尾常见的标点
    var uri = String(matches[i]).replace(/[.,;:!?]+$/, '');
    if (found.indexOf(uri) < 0) found.push(uri);
  }

  return found;
}

function parseQuery(query) {
  var out = {};
  if (!query) return out;

  var pairs = query.split('&');
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var eq = pairs[i].indexOf('=');
    var rawKey = eq < 0 ? pairs[i] : pairs[i].substring(0, eq);
    var rawValue = eq < 0 ? '' : pairs[i].substring(eq + 1);

    try {
      var key = decodeURIComponent(rawKey).toLowerCase();
      var value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      out[key] = value;
    } catch (e) {
      out[rawKey.toLowerCase()] = rawValue;
    }
  }
  return out;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function parseOtpauthUri(uri) {
  var match = uri.match(/^(otpauth|motp):\/\/([^\/?#]*)(\/[^?#]*)?(?:\?([^#]*))?/i);
  if (!match) return null;

  var scheme = match[1].toLowerCase();
  var host = safeDecode(match[2] || '').toLowerCase();
  var path = match[3] ? safeDecode(match[3].replace(/^\//, '')) : '';
  var query = parseQuery(match[4] || '');

  var type;
  if (scheme === 'motp') type = 'motp';
  else if (host === 'totp') type = 'totp';
  else if (host === 'steam') type = 'steam';
  else if (host === 'hotp') type = 'hotp';
  else if (host === 'yaotp' || host === 'yandex') type = 'yandex';
  else if (host === 'motp') type = 'motp';
  else return null;

  var secret = query.secret;
  if (!secret) return null;

  if (type === 'motp') {
    if (!isHexSecret(secret)) return null;
    secret = hexToBase32(secret);
  } else {
    secret = String(secret).replace(/[\s\-]/g, '').toUpperCase();
  }

  var issuerFromPath = '';
  var account = path;
  var colon = path.indexOf(':');
  if (colon > 0) {
    issuerFromPath = path.substring(0, colon).trim();
    account = path.substring(colon + 1).trim();
  }

  var issuer = query.issuer || issuerFromPath;
  var name = issuer || account;
  var usr = issuer ? account : '';

  var pin = '';
  if (type === 'yandex') {
    pin = decodeYandexPin(query.pin);
  } else if (query.pin) {
    pin = query.pin;
  }

  return normalizeEntry({
    name: name,
    usr: usr,
    key: secret,
    type: type,
    algorithm: query.algorithm,
    digits: query.digits,
    period: query.period,
    counter: query.counter,
    pin: pin
  });
}

/**
 * Aegis 的 Yandex 链接中 pin 是 Base32 编码的 UTF-8 文本；
 * 其他客户端可能直接放明文，做一次容错。
 */
function decodeYandexPin(value) {
  if (!value) return '';
  try {
    var bytes = base32Decode(value);
    var text = utf8Decode(bytes);
    if (text && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return text;
  } catch (e) {
    // 当作明文处理
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Google Authenticator 迁移链接（protobuf）                           */
/* ------------------------------------------------------------------ */

function parseMigrationUri(uri) {
  var queryIndex = uri.indexOf('?');
  if (queryIndex < 0) return null;

  var query = parseQuery(uri.substring(queryIndex + 1));
  var encoded = query.data;
  if (!encoded) return null;

  var rawBytes = decodeBase64(encoded);
  if (!rawBytes.length) return null;

  var payload = parseProtoFields(rawBytes);
  var params = payload[1] || [];
  var entries = [];

  for (var i = 0; i < params.length; i++) {
    var fields = parseProtoFields(params[i]);

    var secretBytes = fields[1] && fields[1][0];
    if (!secretBytes || !secretBytes.length) continue;

    var algoValue = fields[4] && fields[4][0];
    var digitsValue = fields[5] && fields[5][0];
    var typeValue = fields[6] && fields[6][0];
    var counterValue = fields[7] && fields[7][0];

    var algorithm = 'SHA1';
    if (algoValue === 2) algorithm = 'SHA256';
    else if (algoValue === 3) algorithm = 'SHA512';
    else if (algoValue === 4) algorithm = 'MD5';

    var digits = digitsValue === 2 ? 8 : 6;
    var type = typeValue === 1 ? 'hotp' : 'totp';

    var name = bytesToString(fields[2] && fields[2][0]);
    var issuer = bytesToString(fields[3] && fields[3][0]);

    entries.push(normalizeEntry({
      name: issuer || name,
      usr: issuer ? name : '',
      key: base32Encode(secretBytes),
      type: type,
      algorithm: algorithm,
      digits: digits,
      period: 30,
      counter: counterValue || 0
    }));
  }

  return entries;
}

function parseProtoFields(bytes) {
  var fields = {};
  var pos = 0;

  while (pos < bytes.length) {
    var tag = readVarint(bytes, pos);
    if (!tag) break;
    pos = tag.pos;

    var fieldNumber = Math.floor(tag.value / 8);
    var wireType = tag.value % 8;
    var value;

    if (wireType === 0) {
      var v = readVarint(bytes, pos);
      if (!v) break;
      pos = v.pos;
      value = v.value;
    } else if (wireType === 2) {
      var len = readVarint(bytes, pos);
      if (!len) break;
      pos = len.pos;
      if (pos + len.value > bytes.length) break;
      value = bytes.slice(pos, pos + len.value);
      pos += len.value;
    } else if (wireType === 5) {
      if (pos + 4 > bytes.length) break;
      value = bytes.slice(pos, pos + 4);
      pos += 4;
    } else if (wireType === 1) {
      if (pos + 8 > bytes.length) break;
      value = bytes.slice(pos, pos + 8);
      pos += 8;
    } else {
      break;
    }

    if (!fields[fieldNumber]) fields[fieldNumber] = [];
    fields[fieldNumber].push(value);
  }

  return fields;
}

function readVarint(bytes, pos) {
  var result = 0;
  var shift = 0;

  while (pos < bytes.length) {
    var b = bytes[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if ((b & 0x80) === 0) return { value: result, pos: pos };
    if (shift > 56) return null;
  }
  return null;
}

function bytesToString(bytes) {
  if (!bytes || !bytes.length) return '';
  try {
    return utf8Decode(bytes);
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Base64                                                              */
/* ------------------------------------------------------------------ */

function decodeBase64(input) {
  var str = String(input || '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');

  var dataIndex = str.indexOf('base64,');
  if (dataIndex >= 0) str = str.substring(dataIndex + 7);

  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var bytes = [];
  var buffer = 0;
  var bits = 0;

  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c === '=') break;
    var value = chars.indexOf(c);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    if (bits > 0) buffer &= (1 << bits) - 1;
  }

  return bytes;
}

export {
  parsePayload,
  parseOtpauthUri,
  parseUriText,
  decodeBase64
}
