'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function runStartupTests({ test, assert, assertEqual, TOTP, IMP }) {
  const ux = fs.readFileSync(path.join(__dirname, '../src/pages/index/index.ux'), 'utf8');
  const script = ux.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/totp['"];?/, 'const {$1} = TOTP;')
    .replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/importers['"];?/, 'const {$1} = IMP;')
    .replace(/import\s+(prompt|interconnect|storage)\s+from\s*['"]@system\.[^'"]+['"];?/g, '')
    .replace('export default', 'module.exports =');
  const entry = { name: '测试令牌', key: 'JBSWY3DPEHPK3PXP' };

  function loadPage(options = {}) {
    const warnings = [];
    const saved = [];
    const timers = new Set();
    let timerId = 0;
    const sandbox = {
      module: { exports: {} }, TOTP, IMP,
      require: (name) => {
        assertEqual(name, './demo-entries');
        return require('../src/pages/index/demo-entries.js');
      },
      interconnect: options.interconnect === undefined ? { instance: () => ({}) } : options.interconnect,
      storage: options.storage === undefined ? {
        get: ({ success }) => success(''),
        set: (data) => saved.push(data)
      } : options.storage,
      prompt: { showToast: () => {} },
      console: { warn: (message) => warnings.push(message) },
      setInterval: () => { const id = ++timerId; timers.add(id); return id; },
      clearInterval: (id) => timers.delete(id),
      setTimeout: () => ++timerId,
      clearTimeout: () => {}
    };
    vm.runInNewContext(script, sandbox, { filename: 'index.ux' });
    const page = sandbox.module.exports;
    Object.assign(page, page.public, page.private, options.params);
    return { page, warnings, saved, timers };
  }

  console.log('\n页面启动 / 模拟器接口兼容');

  test('页面模块加载不创建互联实例', () => {
    let calls = 0;
    const { page } = loadPage({ interconnect: { instance: () => { calls++; return {}; } } });
    assertEqual(calls, 0);
    page.onInit();
    assertEqual(calls, 1);
  });

  for (const [name, interconnect] of [
    ['接口缺失', null],
    ['instance 方法缺失', {}],
    ['instance 返回空值', { instance: () => null }],
    ['instance 抛出异常', { instance: () => { throw new Error('模拟器未实现'); } }],
    ['onmessage 绑定抛出异常', { instance: () => Object.defineProperty({}, 'onmessage', {
      set() { throw new Error('模拟器不支持消息监听'); }
    }) }]
  ]) {
    test('互联' + name + '时仍能启动并加载令牌', () => {
      const { page, warnings, timers } = loadPage({
        interconnect,
        storage: { get: ({ success }) => success(JSON.stringify([entry])) }
      });
      page.onInit();
      page.onShow();
      assertEqual(page.list.length, 1);
      assertEqual(page.list[0].otp.length, 6);
      assert(warnings.some((message) => message.includes('interconnect')));
      assertEqual(timers.size, 2);
      page.onDestroy();
      assertEqual(timers.size, 0);
    });
  }

  for (const [name, storage] of [
    ['接口缺失', null],
    ['get 同步抛出异常', { get: () => { throw new Error('存储不可用'); } }],
    ['get 异步失败', { get: ({ fail }) => fail() }],
    ['存储 JSON 损坏', { get: ({ success }) => success('{invalid') }]
  ]) {
    test('存储' + name + '不阻断启动和后续导入', () => {
      const conn = {};
      const { page } = loadPage({ interconnect: { instance: () => conn }, storage });
      // 此处只验证启动/导入，隔离不可用存储的写入。
      page.save = () => {};
      page.onInit();
      assertEqual(page.list.length, 0);
      assertEqual(page.ab, false);
      assertEqual(page.more_show, false);
      conn.onmessage({ data: JSON.stringify({ list: [entry] }) });
      assertEqual(page.list.length, 1);
      assertEqual(page.list[0].otp.length, 6);
    });
  }

  test('等待存储期间的消息排队，读取完成后正常导入和保存', () => {
    let finishRead;
    const conn = {};
    const writes = [];
    const { page } = loadPage({
      interconnect: { instance: () => conn },
      storage: {
        get: ({ success }) => { finishRead = success; },
        set: (data) => writes.push(data)
      }
    });
    page.onInit();
    conn.onmessage({ data: JSON.stringify({ list: [entry] }) });
    assertEqual(page.list.length, 0);
    finishRead('');
    assertEqual(page.list.length, 1);
    assertEqual(writes.length, 1);
    assertEqual(JSON.parse(writes[0].value).list[0].key, entry.key);
    finishRead('');
    assertEqual(page.list.length, 1);
    assertEqual(writes.length, 1);
  });

  console.log('\n模拟器演示令牌');

  function loadDemo() {
    const io = { reads: 0, writes: 0, connections: 0 };
    const result = loadPage({
      params: { demo: '1' },
      interconnect: { instance: () => { io.connections++; return {}; } },
      storage: {
        get: () => { io.reads++; },
        set: () => { io.writes++; }
      }
    });
    result.page.onInit();
    return { ...result, io };
  }

  test('普通启动及非 demo=1 参数不加载虚假验证器', () => {
    for (const demo of ['', undefined, '0', 'true', true, 1]) {
      const { page } = loadPage({ params: { demo } });
      page.onInit();
      assertEqual(page.demoMode, false);
      assertEqual(page.list.length, 0);
    }
  });

  test('互联失败不自动开启演示模式', () => {
    const { page } = loadPage({ interconnect: null });
    page.onInit();
    assertEqual(page.demoMode, false);
    assertEqual(page.list.length, 0);
  });

  test('演示启动加载 5 条标记清晰的令牌且不访问真实接口', () => {
    const { page, io, timers } = loadDemo();
    assertEqual(page.demoMode, true);
    assertEqual(page.list.length, 5);
    assert(page.list.every((item) => item.name.startsWith('演示 · ')));
    assertEqual(page.list.map((item) => item.otp.length), [6, 8, 10, 5, 6]);
    assertEqual(page.list[2].period, 60);
    assertEqual(page.list[4].otp, '755224');
    assertEqual(new Set(page.list.map((item) => item.uid)).size, 5);
    assertEqual(io, { reads: 0, writes: 0, connections: 0 });
    page.onShow();
    assertEqual(timers.size, 2);
    page.onHide();
    assertEqual(timers.size, 0);
    page.onDestroy();
  });

  test('演示 TOTP 能刷新验证码、剩余秒数和详情进度', () => {
    const { page } = loadDemo();
    const item = page.list[0];
    item.otp = '';
    item.nextAt = 0;
    page.tick();
    assertEqual(item.otp, TOTP.generateCode(item));
    assert(item.nextAt > Date.now());
    assert(/^\d+s$/.test(item.remainText));
    page.info(0);
    assertEqual(page.more.otp, item.otp);
    assert(page.timelast >= 1 && page.timelast <= 30);
    assert(page.timeProgress > 0 && page.timeProgress <= 100);
    page.exit('e');
    assertEqual(page.more_show, false);
  });

  test('演示 HOTP 下一码与双击删除不写入存储', () => {
    const { page, io } = loadDemo();
    page.info(4);
    assertEqual(page.more.type, 'hotp');
    page.nextHotp();
    assertEqual(page.list[4].counter, 1);
    assertEqual(page.more.otp, '287082');
    page.del();
    assertEqual(page.list.length, 5);
    page.del();
    assertEqual(page.list.length, 4);
    assertEqual(page.more_show, false);
    assertEqual(io, { reads: 0, writes: 0, connections: 0 });
  });

  test('演示模式显式调用存储、互联与导入仍保持隔离', () => {
    const { page, io } = loadDemo();
    page.save();
    page.loadFromStorage();
    page.readStorage();
    page.initInterconnect();
    page.onMessage({ data: JSON.stringify({ list: [entry] }) });
    assertEqual(page.list.length, 5);
    assertEqual(io, { reads: 0, writes: 0, connections: 0 });
  });

  test('演示重启恢复令牌和 HOTP 计数器，不修改固定测试数据', () => {
    const first = loadDemo();
    first.page.info(4);
    first.page.nextHotp();
    first.page.del();
    first.page.del();
    first.page.onDestroy();
    const { page } = loadDemo();
    assertEqual(page.list.length, 5);
    assertEqual(page.list[4].counter, 0);
    assertEqual(page.list[4].otp, '755224');
    assertEqual(require('../src/pages/index/demo-entries.js')[4].counter, 0);
  });

  test('演示之后正常启动仍读取真实存储，不混入演示条目', () => {
    const demo = loadDemo();
    demo.page.onDestroy();
    const { page } = loadPage({
      storage: { get: ({ success }) => success(JSON.stringify([entry])) }
    });
    page.onInit();
    assertEqual(page.demoMode, false);
    assertEqual(page.list.length, 1);
    assertEqual(page.list[0].name, entry.name);
  });

  test('演示构建路由和输出目录只在独立命令环境启用', () => {
    const source = fs.readFileSync(path.join(__dirname, '../quickapp.config.js'), 'utf8');
    function config(env) {
      const sandbox = { module: { exports: {} }, process: { env } };
      vm.runInNewContext(source, sandbox);
      return sandbox.module.exports;
    }
    assertEqual(config({}), {});
    assertEqual(config({ BANDTOTP_DEMO: '0' }), {});
    assertEqual(config({ BANDTOTP_DEMO: '1' }).cli, {
      startPage: 'pages/index?demo=1',
      outputPath: './build-demo',
      releasePath: './dist-demo'
    });
  });
};
