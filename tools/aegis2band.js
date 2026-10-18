#!/usr/bin/env node
'use strict';

/**
 * Aegis 备份 -> BandTOTP-NEXT 导入文件
 *
 * 用法示例:
 *   AEGIS_PASSWORD='your-password' node tools/aegis2band.js aegis-backup.json
 *   node tools/aegis2band.js aegis-export.json --input-dir ~/Downloads
 *
 * 输出（当前工作目录）:
 *   bandtotp.band.json     完整载荷（推荐给支持扩展格式的发送端）
 *   bandtotp.otpauth.txt   otpauth 链接（现有 BandTOTP 手机客户端可直接读取 TOTP 条目）
 */

const fs = require('fs');
const path = require('path');
const core = require('./aegis-core.cjs');

function printHelp() {
  const lines = [
    '用法: node tools/aegis2band.js <Aegis备份.json> [选项]',
    '',
    '选项:',
    '  --input-dir <目录>            备份文件所在目录（默认当前目录）',
    '  --format <both|json|otpauth>  输出内容（默认 both）',
    '  --password <密码>             备份密码（不推荐；优先用 AEGIS_PASSWORD 环境变量）',
    '  --stdout                      将完整载荷打印到标准输出，不写文件',
    '  -h, --help                    显示本帮助',
    '',
    '支持的备份:',
    '  - Aegis "导出" 生成的明文 JSON',
    '  - Aegis 加密备份（需要密码）',
    '  - 直接包含 entries 的 Aegis 数据库 JSON',
    '',
    '路径限制:',
    '  <Aegis备份.json> 只能写文件名，不能带目录；文件需位于 --input-dir 内。',
    '  输出文件固定写入当前工作目录。',
    '',
    '提示:',
    '  加密备份的密码只在本机内存中使用，不会写入输出文件。'
  ];
  console.log(lines.join('\n'));
}

function parseArguments(argv) {
  const options = {
    input: '',
    inputDir: process.cwd(),
    format: 'both',
    password: '',
    stdout: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--stdout') {
      options.stdout = true;
    } else if (arg === '--input-dir') {
      options.inputDir = argv[++i] || '';
    } else if (arg === '--format') {
      options.format = argv[++i] || '';
    } else if (arg === '--password') {
      options.password = argv[++i] || '';
    } else if (arg.charAt(0) === '-') {
      throw new Error('未知参数: ' + arg);
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new Error('只能指定一个输入文件');
    }
  }

  if (options.format && ['both', 'json', 'otpauth'].indexOf(options.format) < 0) {
    throw new Error('--format 只能是 both、json 或 otpauth');
  }

  return options;
}

function promptPassword() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('当前环境无法交互输入密码，请设置 AEGIS_PASSWORD 环境变量'));
      return;
    }

    const stdin = process.stdin;
    let password = '';

    process.stderr.write('Aegis 备份密码（输入不会显示）: ');

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(password);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          password = password.slice(0, -1);
        } else {
          password += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}

function isEncrypted(vaultFile) {
  return Boolean(
    vaultFile &&
    vaultFile.header &&
    Array.isArray(vaultFile.header.slots) &&
    vaultFile.header.slots.length > 0
  );
}

function summarize(entries) {
  const counts = {};
  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  }

  const order = ['totp', 'steam', 'hotp', 'yandex', 'motp'];
  const parts = [];
  for (const type of order) {
    if (counts[type]) parts.push(type.toUpperCase() + ' ' + counts[type]);
  }
  return parts.join('、') || '无';
}

async function main() {
  let options;

  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error('参数错误: ' + error.message + '\n');
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.input) {
    printHelp();
    process.exitCode = 2;
    return;
  }

  let inputPath;
  try {
    const inputName = String(options.input || '');
    if (
      !inputName ||
      inputName === '.' ||
      inputName === '..' ||
      path.basename(inputName) !== inputName
    ) {
      throw new Error('输入必须是 --input-dir 中的文件名，不能包含目录');
    }

    const inputRoot = fs.realpathSync(path.resolve(options.inputDir));
    inputPath = path.join(inputRoot, inputName);

    const rel = path.relative(inputRoot, inputPath);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error('输入文件不在 --input-dir 内');
    }
  } catch (error) {
    console.error('输入路径无效: ' + error.message);
    process.exitCode = 1;
    return;
  }

  let raw;
  try {
    const stat = fs.statSync(inputPath);
    if (!stat.isFile()) throw new Error('不是普通文件');
    if (stat.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MiB');
    raw = fs.readFileSync(inputPath);
  } catch (error) {
    console.error('无法读取备份文件: ' + error.message);
    process.exitCode = 1;
    return;
  }

  let vaultFile;
  try {
    vaultFile = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    console.error('备份文件不是有效的 JSON: ' + error.message);
    process.exitCode = 1;
    return;
  }

  let password = process.env.AEGIS_PASSWORD || options.password;
  if (isEncrypted(vaultFile) && !password) {
    try {
      password = await promptPassword();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
  }

  let db;
  try {
    const result = core.readAegisBackup(vaultFile, password);
    db = result.db;
    console.error('备份类型: ' + (result.encrypted ? '加密' : '明文'));
  } catch (error) {
    console.error('读取备份失败: ' + error.message);
    process.exitCode = 1;
    return;
  }

  let converted;
  try {
    converted = core.convertAegisDb(db);
  } catch (error) {
    console.error('转换失败: ' + error.message);
    process.exitCode = 1;
    return;
  }

  const entries = converted.entries;
  if (entries.length === 0) {
    console.error('备份中没有可导入的令牌');
    process.exitCode = 1;
    return;
  }

  console.error(
    '共 ' + entries.length + ' 条令牌: ' + summarize(entries) +
    (converted.skipped ? '；跳过 ' + converted.skipped + ' 条不支持的条目' : '')
  );

  const bandJson = JSON.stringify(core.toBandPayload(entries), null, 2);
  const otpauthText = core.toOtpauthText(entries);

  if (options.stdout) {
    process.stdout.write(bandJson + '\n');
    return;
  }

  try {
    if (options.format === 'both' || options.format === 'json') {
      fs.writeFileSync('bandtotp.band.json', bandJson, { encoding: 'utf8', mode: 0o600 });
      console.log('已写入: bandtotp.band.json');
    }

    if (options.format === 'both' || options.format === 'otpauth') {
      fs.writeFileSync('bandtotp.otpauth.txt', otpauthText, { encoding: 'utf8', mode: 0o600 });
      console.log('已写入: bandtotp.otpauth.txt');
    }
  } catch (error) {
    console.error('写入输出文件失败: ' + error.message);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('导入手环:');
  console.log('  1. 现有 BandTOTP 手机客户端 / AstroBox 插件: 选择 .otpauth.txt');
  console.log('     （客户端目前只识别 TOTP，Steam/HOTP/Yandex/mOTP 会被忽略）');
  console.log('  2. 支持完整格式的发送端: 发送 .band.json 的内容');
  console.log('  3. 手环收到消息后会自动合并，同一密钥的条目会更新而不是重复添加');
}

main().catch((error) => {
  console.error('未处理的错误: ' + error.message);
  process.exitCode = 1;
});
