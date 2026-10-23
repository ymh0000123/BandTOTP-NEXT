'use strict';

// 由 Node 注入子进程环境，兼容 Windows / macOS / Linux，且不改变当前终端环境。
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const buildOnly = args.includes('--build');
const extras = args.filter((arg) => arg !== '--build');
const cli = require.resolve('aiot-toolkit/lib/bin.js');
const preloadArgs = buildOnly ? [] : ['--require', path.join(__dirname, 'demo-emulator-preload.cjs')];

console.log('模拟器演示：公开测试密钥，不对应真实账号；数据仅保留在内存。');
console.log('演示产物输出到 build-demo/ 与 dist-demo/，请勿安装到实机。');
const child = spawn(process.execPath, [...preloadArgs, cli, buildOnly ? 'build' : 'start', ...extras], {
  cwd: root,
  env: { ...process.env, BANDTOTP_DEMO: '1' },
  stdio: 'inherit'
});
child.on('error', (error) => {
  console.error('演示命令启动失败：' + error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code === null ? 1 : code;
  if (signal) console.error('演示命令被信号终止：' + signal);
});
