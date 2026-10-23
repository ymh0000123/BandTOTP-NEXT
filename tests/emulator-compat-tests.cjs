'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeImageInfo, installCompatibility } = require('../tools/demo-emulator-compat.cjs');

module.exports = function runEmulatorCompatTests({ test, assertEqual, assert }) {
  console.log('\n模拟器镜像路径兼容');
  const base = path.join(os.tmpdir(), 'bandtotp-emulator-path-test');
  const primary = path.join(base, 'primary');
  const custom = path.join(base, 'custom');
  const exists = (target) => target === path.join(custom, 'nuttx');

  test('sysdir.2 为空时接受有 nuttx 的 sysdir.1', () => {
    const info = { name: 'Vela_Virtual_Device5', imageDir: '', customImagePath: custom, imageType: 'vela-watch-5.0' };
    const normalized = normalizeImageInfo(info, exists);
    assertEqual(normalized.imageDir, custom);
    assertEqual(normalized.customImagePath, custom);
    assertEqual(normalized.imageType, info.imageType);
    assertEqual(info.imageDir, '');
  });

  test('sysdir.2 失效时允许有效 sysdir.1 回退', () => {
    assertEqual(normalizeImageInfo({ imageDir: primary, customImagePath: custom }, exists).imageDir, custom);
  });

  test('sysdir.2 有效时保持原路径与对象', () => {
    const info = { imageDir: primary, customImagePath: custom };
    assert(normalizeImageInfo(info, () => true) === info);
  });

  test('缺少有效内核时不绕过可用性检查', () => {
    for (const info of [null, {}, { imageDir: '', customImagePath: '' }, { imageDir: primary, customImagePath: custom }]) {
      assert(normalizeImageInfo(info, () => false) === info);
    }
  });

  test('进程内适配保留方法参数和 this 且可重复安装', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bandtotp-emulator-'));
    try {
      fs.writeFileSync(path.join(directory, 'nuttx'), 'test kernel');
      class Manager {
        constructor() { this.prefix = 'existing-'; this.calls = 0; }
        getVvdInfo(name) {
          this.calls++;
          return { name: this.prefix + name, imageDir: '', customImagePath: directory };
        }
      }
      installCompatibility(Manager);
      const patched = Manager.prototype.getVvdInfo;
      installCompatibility(Manager);
      assert(Manager.prototype.getVvdInfo === patched);
      const manager = new Manager();
      assertEqual(manager.getVvdInfo('Vela5').imageDir, directory);
      assertEqual(manager.getVvdInfo('Vela5').name, 'existing-Vela5');
      assertEqual(manager.calls, 2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('演示命令仅为启动子进程预加载兼容代码，构建不预加载', () => {
    const vm = require('vm');
    const source = fs.readFileSync(path.join(__dirname, '../tools/demo.cjs'), 'utf8');
    const toolsDir = path.resolve(__dirname, '../tools');
    for (const build of [false, true]) {
      let spawned;
      const env = { EXISTING: 'unchanged' };
      const fakeRequire = (name) => name === 'path' ? path : {
        spawn: (binary, args, options) => {
          spawned = { binary, args, options };
          return { on: () => {} };
        }
      };
      fakeRequire.resolve = () => '/fake/aiot/bin.js';
      vm.runInNewContext(source, {
        require: fakeRequire,
        __dirname: toolsDir,
        process: { execPath: '/fake/node', argv: ['node', 'demo.cjs', ...(build ? ['--build'] : [])], env },
        console: { log: () => {}, error: () => {} }
      });
      assertEqual(spawned.binary, '/fake/node');
      assertEqual(spawned.args, build ? ['/fake/aiot/bin.js', 'build'] : [
        '--require', path.join(toolsDir, 'demo-emulator-preload.cjs'), '/fake/aiot/bin.js', 'start'
      ]);
      assertEqual(spawned.options.env.BANDTOTP_DEMO, '1');
      assertEqual(env, { EXISTING: 'unchanged' });
    }
  });
};
