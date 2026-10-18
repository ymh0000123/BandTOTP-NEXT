'use strict';

/**
 * Aegis 备份读取 / 解密 / 转换核心。
 *
 * 只依赖 Node 内置模块，供 CLI 与测试复用。
 * 备份格式参考 beemdevelopment/Aegis:
 *   - header.slots[].key / key_params / salt 使用十六进制
 *   - db 使用 Base64
 *   - 密码槽: AES-256-GCM(scrypt(password, salt, n, r, p, 32))
 *   - 数据库: AES-256-GCM(masterKey, header.params)
 */

const crypto = require('crypto');

const MAX_SCRYPT_MEMORY = 1024 * 1024 * 1024; // 1 GiB，防止恶意参数耗尽内存
const MAX_INPUT_BYTES = 64 * 1024 * 1024; // 64 MiB

const KNOWN_TYPES = ['totp', 'steam', 'hotp', 'yandex', 'motp'];

function hexToBuffer(value, label) {
  const hex = String(value || '').trim();
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error((label || '字段') + ' 不是合法的十六进制数据');
  }
  return Buffer.from(hex, 'hex');
}

function bufferToHex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const str = String(input || '').toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/, '');
  if (!str) throw new Error('密钥为空');

  const bytes = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < str.length; i++) {
    const value = alphabet.indexOf(str[i]);
    if (value < 0) throw new Error('密钥包含无效的 Base32 字符: ' + str[i]);
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    if (bits > 0) buffer &= (1 << bits) - 1;
  }

  return Buffer.from(bytes);
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = Buffer.from(buffer);
  let out = '';
  let bufferAcc = 0;
  let bits = 0;

  for (let i = 0; i < bytes.length; i++) {
    bufferAcc = (bufferAcc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(bufferAcc >>> bits) & 0x1f];
    }
    if (bits > 0) bufferAcc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(bufferAcc << (5 - bits)) & 0x1f];

  return out;
}

function normalizeAlgorithm(value, fallback) {
  const algo = String(value || '').toUpperCase().replace(/[\s_-]/g, '').replace(/^HMAC/, '');
  if (algo === 'SHA1' || algo === 'SHA256' || algo === 'SHA512' || algo === 'MD5') return algo;
  return fallback || 'SHA1';
}

function normalizeDigits(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 10) return fallback;
  return n;
}

function normalizePeriod(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 86400) return fallback;
  return n;
}

function normalizeCounter(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(Math.min(n, Number.MAX_SAFE_INTEGER));
}

/**
 * 把 Aegis 条目转换为手环可导入的结构。
 * 与 pages/index/importers.js 的行为保持一致。
 */
function convertAegisEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const type = String(entry.type || '').toLowerCase();
  if (!KNOWN_TYPES.includes(type)) return null;

  const info = entry.info || {};
  const secret = String(info.secret || entry.key || '').replace(/[\s\-]/g, '').toUpperCase();
  if (!secret) return null;

  const issuer = String(entry.issuer || '').trim();
  const account = String(entry.name || '').trim();

  let algorithm = normalizeAlgorithm(info.algo, type === 'yandex' ? 'SHA256' : type === 'motp' ? 'MD5' : 'SHA1');
  let digits = normalizeDigits(info.digits, type === 'steam' ? 5 : type === 'yandex' ? 8 : 6);
  let period = normalizePeriod(info.period, type === 'motp' ? 10 : 30);

  if (type === 'motp') {
    algorithm = 'MD5';
    digits = 6;
    period = 10;
  } else if (type === 'yandex') {
    algorithm = 'SHA256';
    digits = 8;
  } else if (type === 'steam') {
    digits = normalizeDigits(info.digits, 5);
  }

  return {
    name: issuer || account,
    usr: issuer ? account : '',
    key: secret,
    type,
    algorithm,
    digits,
    period,
    counter: type === 'hotp' ? normalizeCounter(info.counter) : 0,
    pin: info.pin === null || info.pin === undefined ? '' : String(info.pin),
    favorite: entry.favorite === true
  };
}

function convertAegisDb(db) {
  if (!db || !Array.isArray(db.entries)) {
    throw new Error('Aegis 数据中缺少 entries 数组');
  }

  const entries = [];
  let skipped = 0;

  for (const raw of db.entries) {
    const entry = convertAegisEntry(raw);
    if (entry) entries.push(entry);
    else skipped++;
  }

  return { entries, skipped };
}

/**
 * 解密单个密码槽，返回 master key Buffer。
 */
function decryptSlot(slot, passwordBuffer) {
  const n = Number(slot.n);
  const r = Number(slot.r);
  const p = Number(slot.p);

  if (!Number.isInteger(n) || n < 2 || n > (1 << 20)) throw new Error('scrypt N 参数异常');
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new Error('scrypt r 参数异常');
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new Error('scrypt p 参数异常');

  const requiredMemory = 128 * n * r + 128 * r * p;
  if (requiredMemory > MAX_SCRYPT_MEMORY) throw new Error('scrypt 参数所需内存过大');

  const salt = hexToBuffer(slot.salt, 'salt');
  const key = crypto.scryptSync(passwordBuffer, salt, 32, {
    N: n,
    r,
    p,
    maxmem: requiredMemory + 8 * 1024 * 1024
  });

  const encryptedKey = hexToBuffer(slot.key, 'slot.key');
  const keyParams = slot.key_params || {};
  const nonce = hexToBuffer(keyParams.nonce, 'slot.key_params.nonce');
  const tag = hexToBuffer(keyParams.tag, 'slot.key_params.tag');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  const masterKey = Buffer.concat([decipher.update(encryptedKey), decipher.final()]);
  if (masterKey.length !== 32) throw new Error('master key 长度异常');

  return masterKey;
}

/**
 * 解密 VaultFile 对象，返回数据库对象。
 * 明文备份直接返回 db。
 */
function decryptVaultFile(vaultFile, password) {
  if (!vaultFile || typeof vaultFile !== 'object') {
    throw new Error('备份文件不是有效的 JSON 对象');
  }

  const header = vaultFile.header || {};
  const slots = Array.isArray(header.slots) ? header.slots : [];

  if (slots.length === 0) {
    if (typeof vaultFile.db === 'string') {
      throw new Error('备份含有密文但缺少密码槽，无法解密');
    }
    return vaultFile.db;
  }

  if (typeof vaultFile.db !== 'string') {
    throw new Error('加密备份的 db 字段应为 Base64 字符串');
  }

  if (!password) {
    throw new Error('该备份已加密，需要提供密码（AEGIS_PASSWORD 环境变量或交互输入）');
  }

  const passwordSlots = slots.filter((slot) => slot && Number(slot.type) === 1);
  if (passwordSlots.length === 0) {
    throw new Error('备份中没有可用的密码槽（可能只包含生物识别槽）');
  }

  const passwordBuffer = Buffer.from(String(password), 'utf8');
  const params = header.params || {};
  const nonce = hexToBuffer(params.nonce, 'header.params.nonce');
  const tag = hexToBuffer(params.tag, 'header.params.tag');
  const ciphertext = Buffer.from(vaultFile.db, 'base64');

  let lastError = null;

  for (const slot of passwordSlots) {
    try {
      const masterKey = decryptSlot(slot, passwordBuffer);
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
      decipher.setAuthTag(tag);

      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error('解密失败：密码错误或备份已损坏' + (lastError ? '（' + lastError.message + '）' : ''));
}

/**
 * 读取备份内容。支持 Buffer / 字符串 / 已解析对象。
 */
function readAegisBackup(input, password) {
  let vaultFile;

  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_INPUT_BYTES) throw new Error('备份文件过大');
    vaultFile = JSON.parse(input.toString('utf8'));
  } else if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new Error('备份文件过大');
    vaultFile = JSON.parse(input);
  } else {
    vaultFile = input;
  }

  // 已经是数据库对象
  if (vaultFile && Array.isArray(vaultFile.entries)) {
    return { db: vaultFile, encrypted: false };
  }

  if (!vaultFile || typeof vaultFile !== 'object' || vaultFile.db === undefined) {
    throw new Error('不是 Aegis 备份文件（缺少 db 字段）');
  }

  const encrypted = Array.isArray(vaultFile.header && vaultFile.header.slots) &&
    vaultFile.header.slots.length > 0;

  const db = decryptVaultFile(vaultFile, password);
  if (!db || !Array.isArray(db.entries)) {
    throw new Error('解密后的数据不是 Aegis 数据库（缺少 entries）');
  }

  return { db, encrypted };
}

/* ------------------------------------------------------------------ */
/* 输出格式                                                            */
/* ------------------------------------------------------------------ */

function toBandPayload(entries) {
  return { list: entries };
}

function encodeLabel(value) {
  return encodeURIComponent(String(value));
}

function entryToOtpauthUri(entry) {
  const type = entry.type;
  const label = entry.name
    ? (entry.usr ? entry.name + ':' + entry.usr : entry.name)
    : (entry.usr || '');

  if (type === 'motp') {
    const secretHex = base32Decode(entry.key).toString('hex');
    let uri = 'motp://motp/' + encodeLabel(label) + '?secret=' + secretHex;
    // Aegis 标准 motp URI 不携带 PIN；这里作为扩展参数写入，
    // 使 BandTOTP-NEXT 的完整导入链路可以保留 PIN。
    if (entry.pin) uri += '&pin=' + encodeURIComponent(entry.pin);
    return uri;
  }

  let host = 'totp';
  if (type === 'steam') host = 'steam';
  else if (type === 'hotp') host = 'hotp';
  else if (type === 'yandex') host = 'yaotp';

  const params = ['secret=' + encodeURIComponent(entry.key)];

  if (entry.name) params.push('issuer=' + encodeURIComponent(entry.name));
  params.push('algorithm=' + entry.algorithm);
  params.push('digits=' + entry.digits);

  if (type === 'hotp') {
    params.push('counter=' + entry.counter);
  } else {
    params.push('period=' + entry.period);
  }

  if (type === 'yandex' && entry.pin) {
    params.push('pin=' + encodeURIComponent(base32Encode(Buffer.from(String(entry.pin), 'utf8'))));
  }

  return 'otpauth://' + host + '/' + encodeLabel(label) + '?' + params.join('&');
}

function toOtpauthText(entries) {
  return entries.map(entryToOtpauthUri).join('\n') + '\n';
}

module.exports = {
  readAegisBackup,
  decryptVaultFile,
  convertAegisDb,
  convertAegisEntry,
  toBandPayload,
  toOtpauthText,
  entryToOtpauthUri,
  base32Decode,
  base32Encode,
  hexToBuffer,
  bufferToHex,
  KNOWN_TYPES
};
