// 适配器契约检查器测试（FR-9.4：不兼容即报错）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAdapterContract } from '../lib/channel.js';

const good = {
  platform: 'mock',
  status: { connected: true, detail: 'ok', lastEventAt: Date.now() },
  send: async () => ({}),
  sendFile: async () => ({}),
  dispose: async () => {},
};

test('完整契约通过，无 warnings', () => {
  const r = validateAdapterContract(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('缺 platform / send → 抛错（FR-9.4）', () => {
  assert.throws(() => validateAdapterContract({ send: good.send }), /platform/);
  assert.throws(() => validateAdapterContract({ platform: 'mock' }), /send/);
  assert.throws(() => validateAdapterContract({ platform: 'mock', send: 'not-a-fn' }), /send/);
});

test('status.connected 非 boolean → 抛错', () => {
  assert.throws(() => validateAdapterContract({ ...good, status: { connected: 'yes' } }), /connected/);
});

test('缺 lastEventAt 心跳 → warnings（可观测性提示）', () => {
  const r = validateAdapterContract({ ...good, status: { connected: true, detail: 'ok' } });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('lastEventAt')));
});

test('sendFile / dispose 类型错误 → 抛错', () => {
  assert.throws(() => validateAdapterContract({ ...good, sendFile: 1 }), /sendFile/);
  assert.throws(() => validateAdapterContract({ ...good, dispose: 'x' }), /dispose/);
});
