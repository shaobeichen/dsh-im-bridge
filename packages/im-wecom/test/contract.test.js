// 契约测试（AGENTS.md 规则 #4 / #9）：适配器必须通过 validateAdapterContract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapterContract } from 'dsh-im/channel';

test('适配器满足核心契约（platform/send/status+lastEventAt/dispose）', () => {
  const channel = {
    platform: 'wecom',
    status: { connected: false, detail: 'test', lastEventAt: null },
    send: async () => ({}),
    sendFile: async () => ({}),
    dispose: async () => {},
  };
  const r = validateAdapterContract(channel);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('契约缺失必须抛错（FR-9.4 不兼容即报错）', () => {
  assert.throws(() => validateAdapterContract({ platform: 'wecom' }));
  assert.throws(() => validateAdapterContract({ send: async () => ({}) }));
  assert.throws(() => validateAdapterContract({ platform: 'wecom', send: 'not-a-fn' }));
});

test('缺少 lastEventAt 心跳 → warnings（可观测性提示）', () => {
  const r = validateAdapterContract({ platform: 'wecom', status: { connected: false }, send: async () => ({}) });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('lastEventAt')));
});
