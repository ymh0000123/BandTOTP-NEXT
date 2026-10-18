'use strict';

/**
 * BandTOTP-NEXT 测试
 *
 * 覆盖:
 *   - RFC 4226 / RFC 6238 官方测试向量
 *   - Steam / Yandex / mOTP 与独立参考实现交叉验证
 *   - otpauth / Aegis / Google 迁移码解析
 *   - Aegis 加密备份端到端解密
 *   - 浏览器工具中的 scrypt 与 AES-GCM 实现
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(__dirname, '.build');

fs.mkdirSync(BUILD, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (error) {
    failed++;
    failures.push(name + ': ' + error.message);
    console.error('  \u2717 ' + name);
    console.error('      ' + error.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (error) {
    failed++;
    failures.push(name + ': ' + error.message);
    console.error('  \u2717 ' + name);
    console.error('      ' + error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, label) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  const b = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
  if (a !== b) throw new Error((label ? label + ': ' : '') + '期望 ' + b + '，实际 ' + a);
}

function assertIncludes(text, needle, label) {
  if (String(text).indexOf(needle) < 0) {
    throw new Error((label ? label + ': ' : '') + '期望包含 "' + needle + '"，实际: ' + text);
  }
}

/* ------------------------------------------------------------------ */
/* 加载被测模块                                                        */
/* ------------------------------------------------------------------ */

function compileTotp() {
  let source = fs.readFileSync(path.join(ROOT, 'src/pages/index/totp.js'), 'utf8');
  source = source.replace(/export\s*\{([\s\S]*?)\}\s*$/, (match, names) => {
    return 'module.exports = {' + names + '};';
  });

  const file = path.join(BUILD, 'totp.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return require(file);
}

function compileImporters() {
  let source = fs.readFileSync(path.join(ROOT, 'src/pages/index/importers.js'), 'utf8');
  source = source.replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/totp['"];?/,
    (match, names) => 'const {' + names + '} = require("./totp.cjs");'
  );
  source = source.replace(/export\s*\{([\s\S]*?)\}\s*$/, (match, names) => {
    return 'module.exports = {' + names + '};';
  });

  const file = path.join(BUILD, 'importers.cjs');
  fs.writeFileSync(file, source, 'utf8');
  return require(file);
}

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '">');
  if (start < 0) throw new Error('HTML 中缺少脚本块: ' + id);
  const contentStart = html.indexOf('>', start) + 1;
  const end = html.indexOf('</script>', contentStart);
  if (end < 0) throw new Error('脚本块未闭合: ' + id);
  return html.slice(contentStart, end);
}

function loadBrowserLibs() {
  const html = fs.readFileSync(path.join(ROOT, 'tools/aegis-import.html'), 'utf8');
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Buffer,
    Uint8Array,
    Uint32Array,
    Number,
    String,
    Object,
    Array,
    Math,
    JSON,
    Date,
    Error,
    RegExp,
    parseInt,
    isFinite,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary')
  };

  vm.createContext(sandbox);
  vm.runInContext(extractScript(html, 'scrypt-lib'), sandbox);
  vm.runInContext(extractScript(html, 'aegis-lib'), sandbox);

  assert(sandbox.ScryptLite, 'ScryptLite 未导出');
  assert(sandbox.AegisLib, 'AegisLib 未导出');

  return sandbox;
}

const TOTP = compileTotp();
const IMP = compileImporters();
const core = require(path.join(ROOT, 'tools/aegis-core.cjs'));

function b32(text) {
  return core.base32Encode(Buffer.from(text, 'utf8'));
}

function bytes32(buffer) {
  return TOTP.base32Encode(Array.from(buffer));
}

/* ------------------------------------------------------------------ */
/* 独立参考实现（用于交叉验证）                                        */
/* ------------------------------------------------------------------ */

function refHotp(secret, algorithm, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return ((mac[offset] & 0x7f) << 24 |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3]) >>> 0;
}

function refSteam(secret, digits, time) {
  const alphabet = '23456789BCDFGHJKMNPQRTVWXY';
  let code = refHotp(secret, 'sha1', Math.floor(time / 30));
  let out = '';
  for (let i = 0; i < digits; i++) {
    out += alphabet.charAt(code % alphabet.length);
    code = Math.floor(code / alphabet.length);
  }
  return out;
}

function refYandex(secret, pin, digits, time) {
  let keyHash = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(pin, 'utf8'), secret]))
    .digest();
  if (keyHash[0] === 0) keyHash = keyHash.subarray(1);

  const counter = Math.floor(time / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha256', keyHash).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const slice = Buffer.from(mac.subarray(offset, offset + 8));
  slice[0] = slice[0] & 0x7f;

  let code = 0n;
  for (const byte of slice) code = (code << 8n) | BigInt(byte);
  code %= 26n ** BigInt(digits);

  let out = '';
  for (let i = digits - 1; i >= 0; i--) {
    out = String.fromCharCode(97 + Number(code % 26n)) + out;
    code /= 26n;
  }
  return out;
}

function refMotp(secret, pin, digits, period, time) {
  const counter = Math.floor(time / period);
  const hex = Buffer.from(secret).toString('hex');
  return crypto.createHash('md5')
    .update(String(counter) + hex + pin)
    .digest('hex')
    .substring(0, digits);
}

/* ------------------------------------------------------------------ */
/* Aegis 加密备份构造                                                  */
/* ------------------------------------------------------------------ */

function buildAegisBackup(db, password, options) {
  options = options || {};
  const N = options.N || 32768;
  const r = options.r || 8;
  const p = options.p || 1;

  const masterKey = options.masterKey || crypto.randomBytes(32);
  const salt = options.salt || crypto.randomBytes(32);
  const slotNonce = options.slotNonce || crypto.randomBytes(12);

  const derived = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, 32, {
    N,
    r,
    p,
    maxmem: 128 * N * r + 16 * 1024 * 1024
  });

  const slotCipher = crypto.createCipheriv('aes-256-gcm', derived, slotNonce);
  const slotCiphertext = Buffer.concat([slotCipher.update(masterKey), slotCipher.final()]);
  const slotTag = slotCipher.getAuthTag();

  const dbNonce = options.dbNonce || crypto.randomBytes(12);
  const dbCipher = crypto.createCipheriv('aes-256-gcm', masterKey, dbNonce);
  const dbCiphertext = Buffer.concat([
    dbCipher.update(Buffer.from(JSON.stringify(db), 'utf8')),
    dbCipher.final()
  ]);
  const dbTag = dbCipher.getAuthTag();

  return {
    version: 1,
    header: {
      slots: [
        {
          type: 1,
          uuid: '11111111-1111-4111-8111-111111111111',
          key: slotCiphertext.toString('hex'),
          key_params: {
            nonce: slotNonce.toString('hex'),
            tag: slotTag.toString('hex')
          },
          n: N,
          r,
          p,
          salt: salt.toString('hex'),
          repaired: true,
          is_backup: false
        }
      ],
      params: {
        nonce: dbNonce.toString('hex'),
        tag: dbTag.toString('hex')
      }
    },
    db: dbCiphertext.toString('base64')
  };
}

function makeAegisDb() {
  return {
    version: 3,
    entries: [
      {
        type: 'totp',
        uuid: '00000000-0000-4000-8000-000000000001',
        name: 'alice@example.com',
        issuer: 'GitHub',
        favorite: true,
        info: { secret: b32('12345678901234567890'), algo: 'SHA256', digits: 8, period: 60 }
      },
      {
        type: 'totp',
        uuid: '00000000-0000-4000-8000-000000000002',
        name: 'bob',
        issuer: 'Example',
        favorite: false,
        info: { secret: b32('abcdefghijklmnop'), algo: 'SHA512', digits: 6, period: 30 }
      },
      {
        type: 'steam',
        uuid: '00000000-0000-4000-8000-000000000003',
        name: 'player',
        issuer: 'Steam',
        favorite: false,
        info: { secret: b32('steamsecret12345'), algo: 'SHA1', digits: 5, period: 30 }
      },
      {
        type: 'hotp',
        uuid: '00000000-0000-4000-8000-000000000004',
        name: 'carol',
        issuer: 'Legacy',
        favorite: false,
        info: { secret: b32('hotpsecret123456'), algo: 'SHA1', digits: 6, counter: 42 }
      },
      {
        type: 'yandex',
        uuid: '00000000-0000-4000-8000-000000000005',
        name: 'yandex-user',
        issuer: 'Yandex',
        favorite: false,
        info: {
          secret: bytes32(Buffer.concat([crypto.randomBytes(16), crypto.randomBytes(10)])),
          algo: 'SHA256',
          digits: 8,
          period: 30,
          pin: '1234'
        }
      },
      {
        type: 'motp',
        uuid: '00000000-0000-4000-8000-000000000006',
        name: 'motp-user',
        issuer: 'mOTP',
        favorite: false,
        info: { secret: b32('motpsecret123456'), algo: 'MD5', digits: 6, period: 10, pin: '9876' }
      }
    ]
  };
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

async function run() {
  console.log('\nBandTOTP-NEXT 测试\n==================\n');

  console.log('Base32 / 归一化');
  test('Base32 编解码往返', () => {
    const buf = crypto.randomBytes(64);
    const encoded = TOTP.base32Encode(Array.from(buf));
    const decoded = TOTP.base32Decode(encoded);
    assertEqual(Buffer.from(decoded).toString('hex'), buf.toString('hex'));
  });
  test('Base32 兼容小写、空格、连字符和填充', () => {
    const decoded = TOTP.base32Decode('jbsw y3dp-ehpk3pxp====');
    assertEqual(Buffer.from(decoded).toString('hex'), Buffer.from('Hello!\xde\xad\xbe\xef', 'latin1').toString('hex'));
  });
  test('算法别名归一化', () => {
    assertEqual(TOTP.normalizeEntry({ key: 'AAAA', algorithm: 'SHA-256' }).algorithm, 'SHA256');
    assertEqual(TOTP.normalizeEntry({ key: 'AAAA', algorithm: 'HmacSHA512' }).algorithm, 'SHA512');
  });
  test('默认参数：TOTP / SHA1 / 6 位 / 30 秒', () => {
    const e = TOTP.normalizeEntry({ name: 'x', key: 'JBSWY3DPEHPK3PXP' });
    assertEqual(e.type, 'totp');
    assertEqual(e.algorithm, 'SHA1');
    assertEqual(e.digits, 6);
    assertEqual(e.period, 30);
  });
  test('旧版 name=steam 自动识别为 Steam', () => {
    const e = TOTP.normalizeEntry({ name: 'Steam', usr: 'player', key: 'JBSWY3DPEHPK3PXP' });
    assertEqual(e.type, 'steam');
    assertEqual(e.digits, 5);
  });
  test('条目指纹忽略名称、区分算法参数', () => {
    const a = TOTP.entryFingerprint({ name: 'A', key: 'JBSWY3DPEHPK3PXP', digits: 6 });
    const b = TOTP.entryFingerprint({ name: 'B', key: 'JBSWY3DPEHPK3PXP', digits: 6 });
    const c = TOTP.entryFingerprint({ name: 'A', key: 'JBSWY3DPEHPK3PXP', digits: 8 });
    assertEqual(a, b);
    assert(a !== c, '不同位数应产生不同指纹');
  });

  console.log('\nRFC 4226 / RFC 6238 官方向量');
  const hotpSecret = Buffer.from('12345678901234567890', 'ascii');
  const hotpExpected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489'
  ];
  test('RFC 4226 HOTP SHA1 counter 0-9', () => {
    for (let counter = 0; counter < hotpExpected.length; counter++) {
      const code = TOTP.generateCode({
        key: b32('12345678901234567890'),
        type: 'hotp',
        algorithm: 'SHA1',
        digits: 6,
        counter
      });
      assertEqual(code, hotpExpected[counter], 'counter=' + counter);
    }
  });

  const rfc6238 = [
    {
      algorithm: 'SHA1',
      secret: '12345678901234567890',
      expected: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130']
    },
    {
      algorithm: 'SHA256',
      secret: '12345678901234567890123456789012',
      expected: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706']
    },
    {
      algorithm: 'SHA512',
      secret: '1234567890123456789012345678901234567890123456789012345678901234',
      expected: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826']
    }
  ];
  const rfcTimes = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];

  for (const vector of rfc6238) {
    test('RFC 6238 ' + vector.algorithm + ' 8 位', () => {
      for (let i = 0; i < rfcTimes.length; i++) {
        const code = TOTP.generateCode({
          key: b32(vector.secret),
          type: 'totp',
          algorithm: vector.algorithm,
          digits: 8,
          period: 30
        }, rfcTimes[i]);
        assertEqual(code, vector.expected[i], 'T=' + rfcTimes[i]);
      }
    });
  }

  test('自定义周期 60 秒', () => {
    const key = b32('12345678901234567890');
    const t = 1234567890;
    const expected = String(refHotp(hotpSecret, 'sha1', Math.floor(t / 60)));
    // 参考实现同样做 10^6 取模与补零
    const ref = expected.substring(expected.length - 6).padStart(6, '0');
    const code = TOTP.generateCode({ key, type: 'totp', algorithm: 'SHA1', digits: 6, period: 60 }, t);
    assertEqual(code, ref);
  });

  console.log('\nSteam / Yandex / mOTP');
  test('Steam 与参考实现一致', () => {
    const secret = Buffer.from('steam-secret-bytes');
    for (const t of [1000000000, 1234567890, 1700000000]) {
      const code = TOTP.generateCode({
        key: bytes32(secret),
        type: 'steam',
        algorithm: 'SHA1',
        digits: 5,
        period: 30
      }, t);
      assertEqual(code, refSteam(secret, 5, t), 'T=' + t);
    }
  });

  test('Yandex 与参考实现一致（16 字节密钥）', () => {
    const secret = crypto.randomBytes(16);
    const pin = '1234';
    for (const t of [1000000000, 1234567890, 1700000000]) {
      const code = TOTP.generateCode({
        key: bytes32(secret),
        type: 'yandex',
        algorithm: 'SHA256',
        digits: 8,
        period: 30,
        pin
      }, t);
      assertEqual(code, refYandex(secret, pin, 8, t), 'T=' + t);
    }
  });

  test('Yandex 26 字节密钥只使用前 16 字节', () => {
    const secret = crypto.randomBytes(26);
    const pin = 'abcd';
    const t = 1650000000;
    const code = TOTP.generateCode({
      key: bytes32(secret),
      type: 'yandex',
      algorithm: 'SHA256',
      digits: 8,
      period: 30,
      pin
    }, t);
    assertEqual(code, refYandex(secret.subarray(0, 16), pin, 8, t));
  });

  test('mOTP 与参考实现一致', () => {
    const secret = crypto.randomBytes(16);
    const pin = '9876';
    for (const t of [1000000000, 1234567890, 1700000000]) {
      const code = TOTP.generateCode({
        key: bytes32(secret),
        type: 'motp',
        algorithm: 'MD5',
        digits: 6,
        period: 10,
        pin
      }, t);
      assertEqual(code, refMotp(secret, pin, 6, 10, t), 'T=' + t);
    }
  });

  console.log('\n周期与倒计时');
  test('剩余秒数与下一个边界', () => {
    const e = { type: 'totp', key: 'JBSWY3DPEHPK3PXP', period: 60 };
    assertEqual(TOTP.getRemaining(e, 0), 60);
    assertEqual(TOTP.getRemaining(e, 59000), 1);
    assertEqual(TOTP.getRemaining(e, 60000), 60);
    assertEqual(TOTP.getNextBoundary(e, 0), 60000);
    assertEqual(TOTP.getNextBoundary(e, 60000), 120000);
  });
  test('HOTP 没有周期倒计时', () => {
    const e = { type: 'hotp', key: 'JBSWY3DPEHPK3PXP', counter: 3 };
    assertEqual(TOTP.getRemaining(e, 0), 0);
    assertEqual(TOTP.getNextBoundary(e, 0), Infinity);
  });

  console.log('\notpauth 解析');
  test('TOTP + SHA256 + 8 位 + 60 秒 + issuer', () => {
    const result = IMP.parsePayload(
      'otpauth://totp/GitHub:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60'
    );
    assert(result.ok, '解析失败: ' + result.error);
    const e = result.entries[0];
    assertEqual(e.name, 'GitHub');
    assertEqual(e.usr, 'alice@example.com');
    assertEqual(e.algorithm, 'SHA256');
    assertEqual(e.digits, 8);
    assertEqual(e.period, 60);
  });
  test('Steam URI', () => {
    const result = IMP.parsePayload(
      'otpauth://steam/Steam:player?secret=JBSWY3DPEHPK3PXP&issuer=Steam'
    );
    assert(result.ok, '解析失败: ' + result.error);
    const e = result.entries[0];
    assertEqual(e.type, 'steam');
    assertEqual(e.digits, 5);
    assertEqual(e.period, 30);
  });
  test('HOTP URI 带 counter', () => {
    const result = IMP.parsePayload(
      'otpauth://hotp/Legacy:carol?secret=JBSWY3DPEHPK3PXP&counter=42'
    );
    assert(result.ok, '解析失败: ' + result.error);
    const e = result.entries[0];
    assertEqual(e.type, 'hotp');
    assertEqual(e.counter, 42);
  });
  test('Yandex URI 的 Base32 PIN 解码', () => {
    const pin = core.base32Encode(Buffer.from('1234', 'utf8'));
    const result = IMP.parsePayload(
      'otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP&pin=' + encodeURIComponent(pin)
    );
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries[0].type, 'yandex');
    assertEqual(result.entries[0].pin, '1234');
    assertEqual(result.entries[0].algorithm, 'SHA256');
    assertEqual(result.entries[0].digits, 8);
  });
  test('mOTP URI 的十六进制密钥转 Base32', () => {
    const secretHex = Buffer.from('12345678901234567890', 'ascii').toString('hex');
    const result = IMP.parsePayload('motp://motp/user?secret=' + secretHex);
    assert(result.ok, '解析失败: ' + result.error);
    const e = result.entries[0];
    assertEqual(e.type, 'motp');
    assertEqual(e.key, b32('12345678901234567890'));
    assertEqual(e.algorithm, 'MD5');
    assertEqual(e.digits, 6);
    assertEqual(e.period, 10);
  });
  test('多行文本混合 URI 与重复去除', () => {
    const text = [
      'some export',
      'otpauth://totp/A:one?secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/B:two?secret=KRSXG5CTMVRXEZLU',
      'otpauth://totp/A:one?secret=JBSWY3DPEHPK3PXP'
    ].join('\n');
    const result = IMP.parsePayload(text);
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries.length, 2);
  });

  console.log('\nAegis / 旧格式解析');
  test('Aegis 明文 VaultFile', () => {
    const db = makeAegisDb();
    const vault = { version: 1, header: { slots: null, params: null }, db };
    const result = IMP.parsePayload(JSON.stringify(vault));
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries.length, 6);
    assertEqual(result.entries[0].name, 'GitHub');
    assertEqual(result.entries[0].usr, 'alice@example.com');
    assertEqual(result.entries[0].algorithm, 'SHA256');
    assertEqual(result.entries[0].digits, 8);
    assertEqual(result.entries[0].period, 60);
    assertEqual(result.entries[0].favorite, true);
    assertEqual(result.entries[2].type, 'steam');
    assertEqual(result.entries[3].counter, 42);
    assertEqual(result.entries[4].pin, '1234');
    assertEqual(result.entries[5].type, 'motp');
  });
  test('Aegis 数据库对象（无 VaultFile 包装）', () => {
    const result = IMP.parsePayload(JSON.stringify(makeAegisDb()));
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries.length, 6);
  });
  test('Aegis 加密备份给出明确提示', () => {
    const backup = buildAegisBackup(makeAegisDb(), 'password', { N: 1024 });
    const result = IMP.parsePayload(JSON.stringify(backup));
    assert(!result.ok, '加密备份不应被当作明文解析');
    assertEqual(result.code, 'ENCRYPTED');
    assertIncludes(result.error, '加密备份');
  });
  test('旧版 list 载荷含 algorithm/digits/period', () => {
    const payload = {
      list: [
        {
          name: 'Example',
          usr: 'user',
          key: 'JBSWY3DPEHPK3PXP',
          algorithm: 'SHA256',
          digits: 8,
          period: 60
        }
      ]
    };
    const result = IMP.parsePayload(JSON.stringify(payload));
    assert(result.ok, '解析失败: ' + result.error);
    const e = result.entries[0];
    assertEqual(e.algorithm, 'SHA256');
    assertEqual(e.digits, 8);
    assertEqual(e.period, 60);
  });
  test('未知类型被跳过并产生警告', () => {
    const db = makeAegisDb();
    db.entries.push({
      type: 'future-type',
      name: 'x',
      issuer: 'x',
      info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 }
    });
    const result = IMP.parsePayload(JSON.stringify({ version: 3, entries: db.entries }));
    assert(result.ok);
    assertEqual(result.entries.length, 6);
    assertEqual(result.warnings.length, 1);
  });

  console.log('\nGoogle Authenticator 迁移码');
  function pbVarint(value) {
    const bytes = [];
    let n = value;
    do {
      let byte = n & 0x7f;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      bytes.push(byte);
    } while (n > 0);
    return Buffer.from(bytes);
  }
  function pbBytes(field, data) {
    return Buffer.concat([pbVarint((field << 3) | 2), pbVarint(data.length), Buffer.from(data)]);
  }
  function pbNumber(field, value) {
    return Buffer.concat([pbVarint((field << 3) | 0), pbVarint(value)]);
  }
  test('otpauth-migration TOTP SHA256 8 位', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const params = Buffer.concat([
      pbBytes(1, secret),
      pbBytes(2, Buffer.from('alice@example.com')),
      pbBytes(3, Buffer.from('Example')),
      pbNumber(4, 2),
      pbNumber(5, 2),
      pbNumber(6, 2)
    ]);
    const payload = pbBytes(1, params);
    const uri = 'otpauth-migration://offline?data=' + encodeURIComponent(payload.toString('base64'));
    const result = IMP.parsePayload(uri);
    assert(result.ok, '解析失败: ' + result.error);
    const e = result.entries[0];
    assertEqual(e.key, bytes32(secret));
    assertEqual(e.algorithm, 'SHA256');
    assertEqual(e.digits, 8);
    assertEqual(e.name, 'Example');
    assertEqual(e.usr, 'alice@example.com');
  });
  test('otpauth-migration HOTP counter', () => {
    const secret = Buffer.from('hotpsecret', 'ascii');
    const params = Buffer.concat([
      pbBytes(1, secret),
      pbBytes(2, Buffer.from('bob')),
      pbBytes(3, Buffer.from('Legacy')),
      pbNumber(4, 1),
      pbNumber(5, 1),
      pbNumber(6, 1),
      pbNumber(7, 7)
    ]);
    const uri = 'otpauth-migration://offline?data=' +
      encodeURIComponent(pbBytes(1, params).toString('base64'));
    const result = IMP.parsePayload(uri);
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries[0].type, 'hotp');
    assertEqual(result.entries[0].counter, 7);
    assertEqual(result.entries[0].digits, 6);
  });

  console.log('\nAegis 加密备份端到端');
  const testDb = makeAegisDb();
  const testPassword = 'correct horse battery staple';
  const backup = buildAegisBackup(testDb, testPassword);

  test('Node 核心解密（默认 32768 参数）', () => {
    const result = core.readAegisBackup(backup, testPassword);
    assertEqual(result.encrypted, true);
    assertEqual(result.db.entries.length, testDb.entries.length);
    const converted = core.convertAegisDb(result.db);
    assertEqual(converted.entries.length, 6);
    assertEqual(converted.entries[0].algorithm, 'SHA256');
    assertEqual(converted.entries[3].counter, 42);
  });
  test('错误密码被拒绝', () => {
    let error = null;
    try {
      core.readAegisBackup(backup, 'wrong password');
    } catch (e) {
      error = e;
    }
    assert(error, '错误密码应抛出异常');
    assertIncludes(error.message, '解密失败');
  });
  test('明文备份直接读取', () => {
    const result = core.readAegisBackup({
      version: 1,
      header: { slots: null, params: null },
      db: testDb
    }, '');
    assertEqual(result.encrypted, false);
    assertEqual(result.db.entries.length, 6);
  });
  test('Aegis 转换结果可被手环解析器导入', () => {
    const converted = core.convertAegisDb(testDb);
    const result = IMP.parsePayload(JSON.stringify(core.toBandPayload(converted.entries)));
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries.length, 6);
    assertEqual(result.entries[3].counter, 42);
    assertEqual(result.entries[4].pin, '1234');
  });

  console.log('\nURI 往返一致性');
  test('Band JSON / otpauth 文本往返', () => {
    const converted = core.convertAegisDb(testDb);
    const text = core.toOtpauthText(converted.entries);
    const result = IMP.parsePayload(text);
    assert(result.ok, '解析失败: ' + result.error);
    assertEqual(result.entries.length, converted.entries.length);

    for (let i = 0; i < converted.entries.length; i++) {
      const original = converted.entries[i];
      const parsed = result.entries.find((entry) => entry.key === original.key && entry.type === original.type);
      assert(parsed, '第 ' + i + ' 条未找到: ' + original.name);
      assertEqual(parsed.algorithm, original.algorithm, 'algorithm ' + original.name);
      assertEqual(parsed.digits, original.digits, 'digits ' + original.name);
      if (original.type === 'hotp') {
        assertEqual(parsed.counter, original.counter, 'counter ' + original.name);
      } else {
        assertEqual(parsed.period, original.period, 'period ' + original.name);
      }
      if (original.pin) assertEqual(parsed.pin, original.pin, 'pin ' + original.name);
    }
  });
  test('浏览器工具的 URI 生成与 Node 一致', () => {
    const sandbox = loadBrowserLibs();
    const converted = core.convertAegisDb(testDb);
    for (const entry of converted.entries) {
      assertEqual(
        sandbox.AegisLib.entryToUri(entry),
        core.entryToOtpauthUri(entry),
        entry.name
      );
    }
  });

  console.log('\n浏览器工具：scrypt');
  const nodePbkdf2 = (passwordBytes, saltBytes, iterations, length) =>
    new Promise((resolve, reject) => {
      crypto.pbkdf2(
        Buffer.from(passwordBytes),
        Buffer.from(saltBytes),
        iterations,
        length,
        'sha256',
        (error, derived) => error ? reject(error) : resolve(new Uint8Array(derived))
      );
    });

  await testAsync('RFC 7914 测试向量 (N=16, r=1, p=1)', async () => {
    const sandbox = loadBrowserLibs();
    const derived = await sandbox.ScryptLite.derive(
      new Uint8Array(0),
      new Uint8Array(0),
      16,
      1,
      1,
      64,
      nodePbkdf2
    );
    assertEqual(
      Buffer.from(derived).toString('hex'),
      '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442' +
      'fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906'
    );
  });

  await testAsync('与 Node scryptSync 一致 (N=1024,r=8,p=1)', async () => {
    const sandbox = loadBrowserLibs();
    const password = Buffer.from('password', 'utf8');
    const salt = Buffer.from('salty-salt', 'utf8');
    const derived = await sandbox.ScryptLite.derive(
      new Uint8Array(password),
      new Uint8Array(salt),
      1024,
      8,
      1,
      32,
      nodePbkdf2
    );
    const expected = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
    assertEqual(Buffer.from(derived).toString('hex'), expected.toString('hex'));
  });

  await testAsync('与 Node scryptSync 一致 (Aegis 默认 N=32768,r=8,p=1)', async () => {
    const sandbox = loadBrowserLibs();
    const password = Buffer.from('aegis-password', 'utf8');
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const derived = await sandbox.ScryptLite.derive(
      new Uint8Array(password),
      new Uint8Array(salt),
      32768,
      8,
      1,
      32,
      nodePbkdf2
    );
    const expected = crypto.scryptSync(password, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    });
    assertEqual(Buffer.from(derived).toString('hex'), expected.toString('hex'));
  });

  console.log('\n浏览器工具：Aegis 解密');
  await testAsync('解密结果与 Node 核心一致', async () => {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error('当前 Node 环境没有 WebCrypto');
    }
    const sandbox = loadBrowserLibs();
    const smallBackup = buildAegisBackup(testDb, testPassword, { N: 1024 });
    const db = await sandbox.AegisLib.decryptVaultFile(smallBackup, testPassword);
    assertEqual(db.entries.length, testDb.entries.length);
    assertEqual(db.entries[0].info.algo, 'SHA256');
  });
  await testAsync('真实参数备份解密 (32768)', async () => {
    const sandbox = loadBrowserLibs();
    const db = await sandbox.AegisLib.decryptVaultFile(backup, testPassword);
    assertEqual(db.entries.length, testDb.entries.length);
    assertEqual(db.entries[5].type, 'motp');
  });
  await testAsync('错误密码被拒绝', async () => {
    const sandbox = loadBrowserLibs();
    let error = null;
    try {
      await sandbox.AegisLib.decryptVaultFile(backup, 'nope');
    } catch (e) {
      error = e;
    }
    assert(error, '错误密码应抛出异常');
    assertIncludes(error.message, '解密失败');
  });

  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + ': ' + passed + ' 通过, ' + failed + ' 失败\n');

  if (failed > 0) {
    console.error('失败列表:');
    for (const failure of failures) console.error('  - ' + failure);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('测试运行失败: ' + error.stack);
  process.exitCode = 1;
});
