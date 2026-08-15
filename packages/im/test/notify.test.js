import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotifyBus } from '../lib/notify.js';
import { SessionMap } from '../lib/session-map.js';

// 每个测试用独立临时目录，避免共享路径下多个 map 的防抖保存并发写同一
// .tmp 文件（rename ENOENT 竞态）；afterEach 清掉防抖定时器。
const liveMaps = [];
afterEach(() => {
  for (const m of liveMaps.splice(0)) m.dispose();
});

function makeBus({ quietHours = [], onlineWindowMin = 10, streamWhileOnline = true, withEdit = false, failEdit = false } = {}) {
  const sent = [];
  const edits = [];
  const map = new SessionMap(mkdtempSync(join(tmpdir(), 'im-notify-')));
  liveMaps.push(map);
  map.create('mock', 'c1', { chatType: 'private' });
  map.touch('mock', 'c1', 'u1', 'Alice');
  const send = async (chat, out) => {
    const messageId = withEdit ? `mock-msg-${sent.length + 1}` : undefined;
    sent.push({ ...out, chat, ...(messageId ? { messageId } : {}) });
    return messageId ? { messageId } : {};
  };
  const edit = withEdit
    ? async (chat, messageId, out) => {
        edits.push({ chat, messageId, out });
        if (failEdit) throw new Error('mock patch failed');
        return {};
      }
    : null;
  const bus = new NotifyBus({
    ctx: { on: () => () => {} },
    map,
    send,
    edit,
    log: () => {},
    lastUserTextFor: () => '跑一下 pytest',
  });
  bus.configure({
    onTurnEnd: true, onError: true, includeReasoning: false, includeCost: true,
    pricing: { inputPerM: 1, outputPerM: 16 }, quietHours, streamWhileOnline,
    onlineWindowMin, flushIntervalMs: 400,
  });
  return { bus, map, sent, edits };
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

test('流式增量：渠道支持 edit → 首帧发送、后续帧原地编辑（消息数不增长）', async () => {
  const { bus, map, sent, edits } = makeBus({ withEdit: true });
  const binding = map.get('mock', 'c1');
  const sid = binding.sessionId;
  bus.onSessionEvent({ id: sid }, {
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: 'A'.repeat(50) } },
  });
  // 等首帧 flush（400ms 定时器）
  const deadline = Date.now() + 3000;
  while (!sent.some((m) => m.stream) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(sent.filter((m) => m.stream).length, 1, '首帧发送一条流式消息');
  assert.ok(sent.find((m) => m.stream).messageId, '首帧记录 messageId');
  // 第二帧直接 flush：应走 edit，不发新消息
  bus.appendStream(binding, 'B'.repeat(50));
  await bus.flush(bus.state(sid), false);
  assert.equal(sent.filter((m) => m.stream).length, 1, '后续增量不产生新消息');
  assert.equal(edits.length, 1, '后续增量走 edit');
  // 蓄水池按帧清空：edit 帧只携带本批次增量（卡片为原地替换语义）
  assert.ok(edits[0].out.text.includes('BBBB'), 'edit 内容含新帧');
  assert.equal(edits[0].messageId, 'mock-msg-1', 'edit 目标为首帧消息');
});

test('流式增量：edit 失败 → 回退发新消息（内容不丢）', async () => {
  const { bus, map, sent, edits } = makeBus({ withEdit: true, failEdit: true });
  const binding = map.get('mock', 'c1');
  const sid = binding.sessionId;
  bus.onSessionEvent({ id: sid }, {
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: 'A'.repeat(50) } },
  });
  const deadline = Date.now() + 3000;
  while (!sent.some((m) => m.stream) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  bus.appendStream(binding, 'B'.repeat(50));
  await bus.flush(bus.state(sid), false);
  assert.equal(edits.length, 1, 'edit 被尝试');
  assert.equal(sent.filter((m) => m.stream).length, 2, 'edit 失败后回退发送新消息');
  assert.ok(sent.at(-1).text.includes('BBBB'), '新消息包含未交付的增量');
});

test('蓄水池上限：超长离线输出只保留尾部（完整输出走 /log）', async () => {
  const { bus, map } = makeBus({ onlineWindowMin: 0 });
  const binding = map.get('mock', 'c1');
  // 确定性离线：把活跃时间拨回过去——touch 与 appendStream 可能落在同一毫秒，
  // isOnline 的 <= 判定会误判为在线（历史 flake 根因）。
  binding.lastActivityAt = Date.now() - 60_000;
  bus.appendStream(binding, 'x'.repeat(5000));
  const s = bus.state(binding.sessionId);
  assert.ok(s.reservoir.length <= 3500, '蓄水池有上限');
  assert.equal(s.reservoir, 'x'.repeat(3500), '超出部分从头部丢弃（保留最新尾部）');
});
