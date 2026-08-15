import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NotifyBus } from '../lib/notify.js';
import { SessionMap } from '../lib/session-map.js';

function makeBus({ quietHours = [], onlineWindowMin = 10, streamWhileOnline = true } = {}) {
  const sent = [];
  const map = new SessionMap('/tmp/im-notify-test');
  map.create('mock', 'c1', { chatType: 'private' });
  map.touch('mock', 'c1', 'u1', 'Alice');
  const bus = new NotifyBus({
    ctx: { on: () => () => {} },
    map,
    send: async (chat, out) => { sent.push({ ...out, chat }); return {}; },
    log: () => {},
    lastUserTextFor: () => '跑一下 pytest',
  });
  bus.configure({
    onTurnEnd: true, onError: true, includeReasoning: false, includeCost: true,
    pricing: { inputPerM: 1, outputPerM: 16 }, quietHours, streamWhileOnline,
    onlineWindowMin, flushIntervalMs: 400,
  });
  return { bus, map, sent };
}

test('turn/end 推送结果卡片（在线时）', async () => {
  const { bus, map, sent } = makeBus();
  const binding = map.get('mock', 'c1');
  bus.onSessionEvent({ id: binding.sessionId }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '测试全部通过 ✅' }] }, usage: { inputTokens: 100, outputTokens: 20 } },
  });
  bus.handleTurnEnd(binding, { turn: 1, reason: { kind: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  const cards = sent.filter((m) => m.text.includes('任务完成'));
  assert.equal(cards.length, 1);
  assert.ok(cards[0].text.includes('测试全部通过'));
  assert.ok(cards[0].text.includes('100 in / 20 out'));
});

test('离线分流：无人活跃时也推结果卡片（FR-5.5）', async () => {
  const { bus, map, sent } = makeBus({ onlineWindowMin: 0 });
  const binding = map.get('mock', 'c1');
  bus.onSessionEvent({ id: binding.sessionId }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '结果' }] } },
  });
  bus.handleTurnEnd(binding, { turn: 1, reason: { kind: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.filter((m) => m.text.includes('任务完成')).length, 1);
});

test('失败 turn：结果卡片 + 重试按钮（FR-5.6）', async () => {
  const { bus, map, sent } = makeBus();
  const binding = map.get('mock', 'c1');
  bus.onSessionEvent({ id: binding.sessionId }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '' }] } },
  });
  bus.handleTurnEnd(binding, { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } });
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.text.includes('任务失败'));
  assert.ok(card);
  assert.ok(card.buttons?.some((b) => b.id.startsWith('retry:')));
});

test('agent/error 推送失败通知（1 分钟聚合）', async () => {
  const { bus, map, sent } = makeBus();
  const binding = map.get('mock', 'c1');
  const fakeAgent = { id: binding.sessionId };
  bus.onAgentError(fakeAgent, new Error('connection refused'));
  bus.onAgentError(fakeAgent, new Error('connection refused again'));
  await new Promise((r) => setTimeout(r, 10));
  const errs = sent.filter((m) => m.text.includes('Agent 出错'));
  assert.equal(errs.length, 1);
});

test('静默时段不推送（FR-5.4）', async () => {
  // 构造当前时间在静默区间内的字符串
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const nextH = String((d.getHours() + 1) % 24).padStart(2, '0');
  const { bus, map, sent } = makeBus({ quietHours: [`${h}:${m}-${nextH}:${m}`] });
  const binding = map.get('mock', 'c1');
  bus.onSessionEvent({ id: binding.sessionId }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'x' }] } },
  });
  bus.handleTurnEnd(binding, { turn: 1, reason: { kind: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.filter((m) => m.text.includes('任务完成')).length, 0);
});

test('流式增量：离线时不推送（FR-5.5），蓄水等结果卡片', async () => {
  const { bus, map, sent } = makeBus({ onlineWindowMin: 0 });
  const binding = map.get('mock', 'c1');
  bus.onSessionEvent({ id: binding.sessionId }, {
    type: 'assistant/chunk',
    data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hello ' } },
  });
  bus.onSessionEvent({ id: binding.sessionId }, {
    type: 'assistant/chunk',
    data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'world' } },
  });
  await new Promise((r) => setTimeout(r, 700));
  // 离线：蓄水池不 flush
  assert.equal(sent.filter((m) => m.text.includes('hello world')).length, 0);
});

test('流式增量：在线时按 flush 间隔推送（FR-3.3），turn/end 记录耗时', async () => {
  const { bus, map, sent } = makeBus();
  const binding = map.get('mock', 'c1');
  const sid = binding.sessionId;
  bus.onSessionEvent({ id: sid }, { type: 'turn/start', data: { turn: 1 } });
  bus.onSessionEvent({ id: sid }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: 'A'.repeat(30) } } });
  await new Promise((r) => setTimeout(r, 100));
  bus.onSessionEvent({ id: sid }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: 'B'.repeat(30) } } });
  // 轮询等 flush 触发（不依赖固定 sleep，防 CI 时序抖动）
  const deadline = Date.now() + 3000;
  while (!sent.some((m) => m.text.includes('AAAAA')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const inc = sent.filter((m) => m.text.includes('AAAAA'));
  assert.equal(inc.length, 1, 'flush 间隔内应推送一条增量');
  assert.equal(inc[0].text.length, 60);
  bus.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '结果' }] } } });
  bus.handleTurnEnd(binding, { turn: 1, reason: { kind: 'completed' } });
  await new Promise((r) => setTimeout(r, 20));
  const card = sent.find((m) => m.text.includes('任务完成'));
  assert.ok(card.text.includes('⏱'), '结果卡片带耗时');
});
