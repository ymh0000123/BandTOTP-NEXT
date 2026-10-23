'use strict';

// 仅由演示命令在独立子进程中预加载；兼容代码不落盘到 SDK 或 node_modules。
const { VvdManager } = require('@aiot-toolkit/emulator');
const { installCompatibility } = require('./demo-emulator-compat.cjs');
installCompatibility(VvdManager);
