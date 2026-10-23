'use strict';

const fs = require('fs');
const path = require('path');
const patched = Symbol.for('bandtotp.demo.emulator-path-compat');

function hasKernel(directory, exists = fs.existsSync) {
  return typeof directory === 'string' && directory.length > 0 &&
    exists(path.resolve(directory, 'nuttx'));
}

// 老工具链读取 sysdir.2，新版 IDE 可能只设置 sysdir.1（customImagePath）。
// 只接受有 nuttx 的显式路径，不猜测其它镜像，也不写回用户 config.ini。
function normalizeImageInfo(info, exists = fs.existsSync) {
  if (!info || hasKernel(info.imageDir, exists) || !hasKernel(info.customImagePath, exists)) {
    return info;
  }
  return { ...info, imageDir: info.customImagePath };
}

function installCompatibility(VvdManager) {
  const prototype = VvdManager.prototype;
  if (prototype[patched]) return;
  const original = prototype.getVvdInfo;
  prototype.getVvdInfo = function (...args) {
    return normalizeImageInfo(original.apply(this, args));
  };
  Object.defineProperty(prototype, patched, { value: true });
}

module.exports = { hasKernel, normalizeImageInfo, installCompatibility };
