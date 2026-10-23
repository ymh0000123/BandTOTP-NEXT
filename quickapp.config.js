'use strict';

// 仅独立演示命令设置此变量；普通 IDE 调试/发布不注入演示路由。
module.exports = process.env.BANDTOTP_DEMO === '1' ? {
  cli: {
    startPage: 'pages/index?demo=1',
    outputPath: './build-demo',
    releasePath: './dist-demo'
  }
} : {};
