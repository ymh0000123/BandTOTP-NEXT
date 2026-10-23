/**
 * 模拟器演示令牌：仅使用公开的 RFC 测试密钥，不对应任何真实账号。
 * 每次进入演示模式都会重新创建运行时条目，不读取或写入 storage。
 */
module.exports = [
  {
    name: '演示 · GitHub',
    usr: 'demo@example.com',
    key: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    type: 'totp', algorithm: 'SHA1', digits: 6, period: 30
  },
  {
    name: '演示 · 邮箱',
    usr: '8 位 / SHA256',
    key: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
    type: 'totp', algorithm: 'SHA256', digits: 8, period: 30
  },
  {
    name: '演示 · 长验证码',
    usr: '10 位 / 60 秒',
    key: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    type: 'totp', algorithm: 'SHA512', digits: 10, period: 60
  },
  {
    name: '演示 · Steam',
    usr: 'demo_player',
    key: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    type: 'steam', algorithm: 'SHA1', digits: 5, period: 30
  },
  {
    name: '演示 · HOTP',
    usr: '点击详情中的下一码',
    key: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    type: 'hotp', algorithm: 'SHA1', digits: 6, counter: 0
  }
];
