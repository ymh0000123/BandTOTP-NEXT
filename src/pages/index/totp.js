/**
 * BandTOTP-NEXT OTP 引擎
 *
 * 支持:
 *   - TOTP / Steam / HOTP / Yandex / mOTP
 *   - HMAC-SHA1 / SHA256 / SHA512 / MD5
 *   - 1~10 位验证码、自定义周期、自定义计数器
 *
 * 算法行为与 Aegis (beemdevelopment/Aegis) 保持一致。
 */
var CryptoJS = require("crypto-js");

var BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
var STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

var HMAC_FNS = {
  SHA1: CryptoJS.HmacSHA1,
  SHA256: CryptoJS.HmacSHA256,
  SHA512: CryptoJS.HmacSHA512,
  MD5: CryptoJS.HmacMD5
};

var TYPE_LABELS = {
  totp: 'TOTP',
  steam: 'Steam',
  hotp: 'HOTP',
  yandex: 'Yandex',
  motp: 'mOTP'
};

var DEFAULT_DIGITS = {
  totp: 6,
  steam: 5,
  hotp: 6,
  yandex: 8,
  motp: 6
};

var DEFAULT_PERIOD = {
  totp: 30,
  steam: 30,
  hotp: 30,
  yandex: 30,
  motp: 10
};

var timeOffset = 0;

function setTimeOffset(seconds) {
  var n = Number(seconds);
  timeOffset = isFinite(n) ? n : 0;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000) + timeOffset;
}

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

function normalizeType(type) {
  var t = String(type || '').toLowerCase();
  if (t === 'steam') return 'steam';
  if (t === 'hotp') return 'hotp';
  if (t === 'yandex' || t === 'yaotp') return 'yandex';
  if (t === 'motp') return 'motp';
  return 'totp';
}

function normalizeAlgorithm(algorithm, fallback) {
  var a = String(algorithm || '').toUpperCase().replace(/[\s_\-]/g, '');
  if (a.indexOf('HMAC') === 0) a = a.substring(4);
  if (a === 'SHA1' || a === 'SHA256' || a === 'SHA512' || a === 'MD5') return a;
  return fallback || 'SHA1';
}

function normalizeDigits(digits, fallback) {
  var n = parseInt(digits, 10);
  if (!isFinite(n) || n < 1 || n > 10) return fallback;
  return n;
}

function normalizePeriod(period, fallback) {
  var n = parseInt(period, 10);
  if (!isFinite(n) || n < 1 || n > 86400) return fallback;
  return n;
}

function normalizeCounter(counter) {
  var n = Number(counter);
  if (!isFinite(n) || n < 0) return 0;
  if (n > 9007199254740991) return 9007199254740991;
  return Math.floor(n);
}

function cleanSecret(secret) {
  return String(secret || '').replace(/[\s\-]/g, '').toUpperCase();
}

function looksLikeSteam(raw) {
  var name = String(raw.name || raw.issuer || '').toLowerCase();
  return name === 'steam';
}

/**
 * 把任意来源（Aegis / otpauth / 旧版 list）的条目归一化为内部结构。
 * 不会修改传入对象。
 */
function normalizeEntry(raw) {
  raw = raw || {};

  var type = raw.type ? normalizeType(raw.type) : (looksLikeSteam(raw) ? 'steam' : 'totp');

  var algorithmFallback = 'SHA1';
  if (type === 'yandex') algorithmFallback = 'SHA256';
  if (type === 'motp') algorithmFallback = 'MD5';

  var algorithm = normalizeAlgorithm(raw.algorithm, algorithmFallback);
  var digits = normalizeDigits(raw.digits, DEFAULT_DIGITS[type]);
  var period = normalizePeriod(raw.period, DEFAULT_PERIOD[type]);

  // 这三种类型的参数由协议固定，忽略外部传入值以保证结果正确
  if (type === 'motp') {
    algorithm = 'MD5';
    digits = 6;
    period = 10;
  } else if (type === 'yandex') {
    algorithm = 'SHA256';
    digits = 8;
    period = normalizePeriod(raw.period, 30);
  } else if (type === 'steam') {
    algorithm = normalizeAlgorithm(raw.algorithm, 'SHA1');
    digits = normalizeDigits(raw.digits, 5);
    period = normalizePeriod(raw.period, 30);
  }

  var name = String(raw.name || raw.issuer || '').trim();
  var usr = String(raw.usr || raw.account || raw.username || '').trim();

  // 兼容 "Issuer:account" 合并写在 name 里的情况
  if (!usr && name.indexOf(':') > 0) {
    var idx = name.indexOf(':');
    usr = name.substring(idx + 1).trim();
    name = name.substring(0, idx).trim();
  }
  if (!name && usr) {
    name = usr;
    usr = '';
  }

  return {
    name: name,
    usr: usr,
    key: cleanSecret(raw.key || raw.secret),
    type: type,
    algorithm: algorithm,
    digits: digits,
    period: period,
    counter: normalizeCounter(raw.counter),
    pin: raw.pin === null || raw.pin === undefined ? '' : String(raw.pin),
    favorite: raw.favorite === true
  };
}

function entryFingerprint(entry) {
  var e = normalizeEntry(entry);
  return [e.type, e.algorithm, e.digits, e.period, e.key].join('|');
}

/* ------------------------------------------------------------------ */
/* Base32 / Hex / UTF-8                                                */
/* ------------------------------------------------------------------ */

function base32Decode(input) {
  var str = cleanSecret(input).replace(/=+$/, '');
  if (!str) throw new Error('密钥为空');

  var bytes = [];
  var buffer = 0;
  var bits = 0;

  for (var i = 0; i < str.length; i++) {
    var value = BASE32_CHARS.indexOf(str.charAt(i));
    if (value < 0) throw new Error('密钥包含无效的 Base32 字符: ' + str.charAt(i));
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    if (bits > 0) buffer &= (1 << bits) - 1;
  }

  if (bytes.length === 0) throw new Error('密钥为空');
  return bytes;
}

function base32Encode(bytes) {
  var out = '';
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | (bytes[i] & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_CHARS.charAt((buffer >>> bits) & 0x1f);
    }
    if (bits > 0) buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_CHARS.charAt((buffer << (5 - bits)) & 0x1f);
  return out;
}

function hexToBytes(hex) {
  var str = String(hex || '').replace(/[\s\-]/g, '');
  if (str.length % 2 !== 0 || /[^0-9a-fA-F]/.test(str)) throw new Error('无效的十六进制密钥');
  var bytes = [];
  for (var i = 0; i < str.length; i += 2) bytes.push(parseInt(str.substr(i, 2), 16));
  return bytes;
}

function bytesToHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

function hexToBase32(hex) {
  return base32Encode(hexToBytes(hex));
}

function isHexSecret(secret) {
  var str = String(secret || '').replace(/[\s\-]/g, '');
  return str.length > 0 && str.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(str);
}

function utf8Encode(str) {
  str = String(str || '');
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

function utf8Decode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      var cp = ((b & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CryptoJS 辅助                                                       */
/* ------------------------------------------------------------------ */

function bytesToWordArray(bytes) {
  var words = [];
  for (var i = 0; i < bytes.length; i++) {
    var idx = i >>> 2;
    var shift = 24 - (i % 4) * 8;
    words[idx] = (words[idx] || 0) | ((bytes[i] & 0xff) << shift);
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

function wordArrayToBytes(wordArray) {
  var words = wordArray.words;
  var sigBytes = wordArray.sigBytes;
  var bytes = [];
  for (var i = 0; i < sigBytes; i++) {
    bytes.push((words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff);
  }
  return bytes;
}

function counterToWordArray(counter) {
  var c = normalizeCounter(counter);
  var hi = Math.floor(c / 4294967296);
  var lo = c % 4294967296;
  return CryptoJS.lib.WordArray.create([hi | 0, lo | 0], 8);
}

function hmacBytes(algorithm, keyBytes, counter) {
  var fn = HMAC_FNS[normalizeAlgorithm(algorithm)] || HMAC_FNS.SHA1;
  var mac = fn(counterToWordArray(counter), bytesToWordArray(keyBytes));
  return wordArrayToBytes(mac);
}

function hmacFromSecret(algorithm, keyBase32, counter) {
  return hmacBytes(algorithm, base32Decode(keyBase32), counter);
}

function sha256Bytes(bytes) {
  return wordArrayToBytes(CryptoJS.SHA256(bytesToWordArray(bytes)));
}

/* ------------------------------------------------------------------ */
/* 验证码格式化                                                        */
/* ------------------------------------------------------------------ */

function truncateToCode(macBytes) {
  var offset = macBytes[macBytes.length - 1] & 0x0f;
  if (offset + 4 > macBytes.length) offset = macBytes.length - 4;
  return (((macBytes[offset] & 0x7f) << 24) |
    ((macBytes[offset + 1] & 0xff) << 16) |
    ((macBytes[offset + 2] & 0xff) << 8) |
    (macBytes[offset + 3] & 0xff)) >>> 0;
}

function padLeft(str, width) {
  while (str.length < width) str = '0' + str;
  return str;
}

function formatDigits(code, digits) {
  var mod = 1;
  for (var i = 0; i < digits; i++) mod *= 10;
  return padLeft(String(code % mod), digits);
}

function formatSteam(code, digits) {
  var out = '';
  for (var i = 0; i < digits; i++) {
    out += STEAM_CHARS.charAt(code % STEAM_CHARS.length);
    code = Math.floor(code / STEAM_CHARS.length);
  }
  return out;
}

/**
 * 把 8 字节大端整数按 26 进制取模。
 * 逐位做模运算，避免 JS 双精度在超过 2^53 时丢失精度。
 */
function bytesMod26(bytes, digits) {
  var mod = 1;
  for (var i = 0; i < digits; i++) mod *= 26;

  var rem = 0;
  for (var j = 0; j < bytes.length; j++) {
    for (var bit = 0; bit < 8; bit++) {
      rem = rem * 2;
      if (rem >= mod) rem -= mod;
    }
    rem += (bytes[j] & 0xff);
    if (rem >= mod) rem -= mod;
  }
  return rem;
}

/* ------------------------------------------------------------------ */
/* 生成验证码                                                          */
/* ------------------------------------------------------------------ */

function generateCode(entry, timeSeconds) {
  var e = normalizeEntry(entry);
  var seconds = timeSeconds === undefined ? nowSeconds() : timeSeconds;
  var period = e.period;

  if (e.type === 'hotp') {
    var hotpMac = hmacBytes(e.algorithm, base32Decode(e.key), e.counter);
    return formatDigits(truncateToCode(hotpMac), e.digits);
  }

  if (e.type === 'motp') {
    var counter = Math.floor(seconds / period);
    var secretHex = bytesToHex(base32Decode(e.key));
    var digest = CryptoJS.MD5(String(counter) + secretHex + e.pin).toString();
    return digest.substring(0, e.digits);
  }

  if (e.type === 'yandex') {
    var secretBytes = base32Decode(e.key);
    // Aegis: 26 字节的密钥带校验位，实际参与计算的是前 16 字节
    if (secretBytes.length > 16) secretBytes = secretBytes.slice(0, 16);

    var keyHash = sha256Bytes(utf8Encode(e.pin).concat(secretBytes));
    // 与 Aegis YAOTP 保持一致：首字节为 0 时移除
    if (keyHash.length > 1 && keyHash[0] === 0) keyHash = keyHash.slice(1);

    var yaCounter = Math.floor(seconds / period);
    var yaMac = hmacBytes(e.algorithm, keyHash, yaCounter);
    var offset = yaMac[yaMac.length - 1] & 0x0f;
    if (offset + 8 > yaMac.length) offset = yaMac.length - 8;

    var slice = yaMac.slice(offset, offset + 8);
    slice[0] = slice[0] & 0x7f;

    var yaCode = bytesMod26(slice, e.digits);
    var yaOut = '';
    for (var i = e.digits - 1; i >= 0; i--) {
      yaOut = String.fromCharCode(97 + (yaCode % 26)) + yaOut;
      yaCode = Math.floor(yaCode / 26);
    }
    return yaOut;
  }

  var counter2 = Math.floor(seconds / period);
  var mac = hmacFromSecret(e.algorithm, e.key, counter2);
  var code = truncateToCode(mac);

  if (e.type === 'steam') return formatSteam(code, e.digits);
  return formatDigits(code, e.digits);
}

function getPeriod(entry) {
  return normalizeEntry(entry).period;
}

function getRemaining(entry, nowMs) {
  var e = normalizeEntry(entry);
  if (e.type === 'hotp') return 0;
  var ms = nowMs === undefined ? Date.now() : nowMs;
  var period = e.period;
  var seconds = Math.floor(ms / 1000);
  return period - (seconds % period);
}

function getNextBoundary(entry, nowMs) {
  var e = normalizeEntry(entry);
  if (e.type === 'hotp') return Infinity;
  var ms = nowMs === undefined ? Date.now() : nowMs;
  var periodMs = e.period * 1000;
  return Math.floor(ms / periodMs) * periodMs + periodMs;
}

function getTypeLabel(entry) {
  return TYPE_LABELS[normalizeEntry(entry).type] || 'TOTP';
}

/**
 * 列表 / 详情页使用的简短标签，例如 "Steam"、"SHA256 · 8位"、"60秒"。
 * 默认参数（TOTP / SHA1 / 6 位 / 30 秒）不显示，保持界面干净。
 */
function getMeta(entry) {
  var e = normalizeEntry(entry);
  var parts = [];

  if (e.type !== 'totp') parts.push(TYPE_LABELS[e.type]);
  if (e.algorithm !== 'SHA1') parts.push(e.algorithm);
  if (e.digits !== DEFAULT_DIGITS[e.type]) parts.push(e.digits + '位');
  if (e.type !== 'hotp' && e.type !== 'motp' && e.period !== DEFAULT_PERIOD[e.type]) {
    parts.push(e.period + '秒');
  }
  return parts.join(' · ');
}

function getDetailMeta(entry) {
  var e = normalizeEntry(entry);
  var parts = [
    TYPE_LABELS[e.type],
    e.algorithm,
    e.digits + '位'
  ];
  if (e.type === 'hotp') {
    parts.push('计数器 ' + e.counter);
  } else {
    parts.push(e.period + '秒');
  }
  if (e.pin) parts.push('PIN');
  return parts.join(' · ');
}

export {
  generateCode,
  normalizeEntry,
  entryFingerprint,
  getPeriod,
  getRemaining,
  getNextBoundary,
  getTypeLabel,
  getMeta,
  getDetailMeta,
  base32Decode,
  base32Encode,
  hexToBase32,
  isHexSecret,
  utf8Encode,
  utf8Decode,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  setTimeOffset,
  timeOffset
}
