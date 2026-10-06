import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovalManager } from '../lib/approvals.js';
import { SessionMap } from '../lib/session-map.js';

function makeManager({ timeoutSec = 0.1, pendingMaxSec = 0.3, autoApproveRisk = 'none', riskRules, sendImpl, logCollect } = {}) {
  const sent = [];
  const logs = logCollect ?? [];
  const dir = mkdtempSync(join(tmpdir(), 'im-ap-'));
  const map = new SessionMap(dir);
  map.create('mock', 'c1', { chatType: 'private' });
  map.addToAllowlist('mock', 'u1');
  const mgr = new ApprovalManager({
    ctx: { on: () => () => {} },
    map,
    send: sendImpl ?? (async (chat, out) => { sent.push({ ...out, chat }); return {}; }),
    logLine: (line) => logs.push(line),
  });
  mgr.configure({
    enabled: true, timeoutSec, pendingMaxSec, autoApproveRisk,
    riskRules: riskRules ?? [{ tool: 'tool-bash', args: 'rm -rf', risk: 'high' }],
  });
  return { mgr, map, sent, logs };
}

/**
 * 可追踪的 AbortSignal 替身：Node 的 AbortSignal 无法枚举已注册监听，
 * `signal.listeners` 不存在（旧测试因此 vacuously pass）。这里包装
 * addEventListener/removeEventListener 来精确计数活跃监听。
 */
function makeTrackingSignal() {
  const ac = new AbortController();
  const active = new Set();
  const signal = {
    get aborted() { return ac.signal.aborted; },
    addEventListener(type, fn) { ac.signal.addEventListener(type, fn); active.add(fn); },
    removeEventListener(type, fn) { ac.signal.removeEventListener(type, fn); active.delete(fn); },
  };
  return { signal, activeCount: () => active.size, abort: () => ac.abort() };
}

const exec = (tool, args, agentId = 'im-mock-c1') => ({
  name: tool,
  arguments: args,
  callId: 'call-1',
  agent: { id: agentId },
});

// ── 回归：审批监听必须 prepend（否则被 GUI 桥抢答，IM 收不到审批） ──────────

test('回归：approval/request 监听以 prepend 注册', () => {
  const handlers = [];
  const dir = mkdtempSync(join(tmpdir(), 'im-ap-'));
  const map = new SessionMap(dir);
  const mgr = new ApprovalManager({
    ctx: {
      on: (evt, fn, opts) => { handlers.push({ evt, fn, opts }); return () => {}; },
    },
    map,
    send: async () => ({}),
    logLine: () => {},
  });
  mgr.mount();
  const approval = handlers.find((h) => h.evt === 'approval/request');
  assert.ok(approval, '应注册 approval/request 监听');
  // Web 桥也注册同一 waterfall 并转发给浏览器；不 prepend 就永远轮不到 IM 审批者
  // （症状：agent 卡在等审批，钉钉什么都收不到）。
  assert.equal(approval.opts?.prepend, true, '必须以 prepend 注册，否则被 GUI 转发器抢先认领');
  // tools/pre-execute 不经 GUI 转发，无需 prepend
  const gate = handlers.find((h) => h.evt === 'tools/pre-execute');
  assert.ok(gate, '应注册 tools/pre-execute 监听');
});

test('审批卡片正文自带 /approve 用法（无按钮渠道可直接照做）', async () => {
  const { mgr, sent } = makeManager({ timeoutSec: 60 });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 20));
  const card = sent.find((m) => m.buttons?.length);
  assert.ok(card, '应推送审批卡片');
  assert.ok(/\/approve \S+ yes/.test(card.text), '正文应含可直接发送的 /approve <id> yes');
  assert.ok(/\/approve \S+ no/.test(card.text), '正文应含 /approve <id> no');
  // 按钮带 command：钉钉渲染不了按钮，降级时要用友好命令而非内部载荷
  const id = card.buttons[0].id.split(':')[1];
  assert.equal(card.buttons[0].command, `/approve ${id} yes`);
  assert.equal(card.buttons[1].command, `/approve ${id} no`);
  mgr.respond(id, 'no', { platform: 'mock', userId: 'u1' });
  await p;
});

test('pre-execute 门：高危 → ask；低危 → next()', async () => {
  const { mgr } = makeManager();
  const next = async () => ({ kind: 'allow' });
  const ask = await mgr.gate(exec('tool-bash', { command: 'rm -rf ~' }), next);
  assert.equal(ask.kind, 'ask');
  const allow = await mgr.gate(exec('tool-bash', { command: 'npm install' }), next);
  assert.equal(allow.kind, 'allow');
});

test('pre-execute 门：非 IM 会话不拦截（双弹窗防护，§10）', async () => {
  const { mgr } = makeManager();
  const next = async () => ({ kind: 'allow' });
  const result = await mgr.gate(exec('tool-bash', { command: 'rm -rf ~' }, 'web-session-9'), next);
  assert.equal(result.kind, 'allow');
});

test('审批：批准 → allowed-once；agent 继续（FR-6.2）', async () => {
  const { mgr, sent } = makeManager({ timeoutSec: 60 });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash', callId: 'call-1' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.some((m) => m.buttons?.length === 2));
  const result = mgr.respond('any-id-not-known', 'yes', { platform: 'mock', userId: 'u1' });
  assert.equal(result, 'not-found');
  // 找到真实 id
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  const r2 = mgr.respond(id, 'yes', { platform: 'mock', userId: 'u1' });
  assert.equal(r2, 'accepted');
  assert.equal(await p, 'allowed-once');
});

test('审批：拒绝 → rejected', async () => {
  const { mgr, sent } = makeManager({ timeoutSec: 60 });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  assert.equal(mgr.respond(id, 'no', { platform: 'mock', userId: 'u1' }), 'rejected');
  assert.equal(await p, 'rejected');
});

test('审批：非 allowlist 用户不能审批（§10 回调身份校验）', async () => {
  const { mgr, sent } = makeManager({ timeoutSec: 60 });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  assert.equal(mgr.respond(id, 'yes', { platform: 'mock', userId: 'intruder' }), 'forbidden');
  // 请求仍在等待
  assert.ok(mgr.pendingList().length > 0);
  // 正主仍可批
  assert.equal(mgr.respond(id, 'yes', { platform: 'mock', userId: 'u1' }), 'accepted');
  assert.equal(await p, 'allowed-once');
});

test('超时可恢复拒绝（FR-6.4）：超时 → pending + 提醒；再超 → rejected', async () => {
  const { mgr, sent } = makeManager({
    timeoutSec: 0.05, pendingMaxSec: 0.1,
    sendTimeoutSec: 5, // 看门狗必须晚于两个测试超时，否则先决 unavailable
  });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 120));
  // 超时提醒已推送（pending）
  assert.ok(sent.some((m) => m.text.includes('等待中') || m.text.includes('被阻塞')));
  await new Promise((r) => setTimeout(r, 120));
  // 兜底失败关闭
  assert.equal(await p, 'rejected');
});

test('超时后仍可恢复审批（pending 窗口内 /approve yes）', async () => {
  const { mgr, sent } = makeManager({
    timeoutSec: 0.05, pendingMaxSec: 60,
    sendTimeoutSec: 5,
  });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 120));
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  assert.equal(mgr.respond(id, 'yes', { platform: 'mock', userId: 'u1' }), 'accepted');
  assert.equal(await p, 'allowed-once');
});

test('审批日志：decided 后追加记录（FR-6.7）', async () => {
  const { mgr, sent, logs } = makeManager({ timeoutSec: 60 });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash', callId: 'call-9' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  mgr.respond(id, 'yes', { platform: 'mock', userId: 'u1' });
  await p;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, 'allowed-once');
  assert.equal(logs[0].tool, 'tool-bash');
});

test('首个响应者生效（FR-6.5）：第二人响应被忽略', async () => {
  const { mgr, sent } = makeManager({ timeoutSec: 60 });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  assert.equal(mgr.respond(id, 'no', { platform: 'mock', userId: 'u1', userName: 'Alice' }), 'rejected');
  assert.equal(mgr.respond(id, 'yes', { platform: 'mock', userId: 'u2', userName: 'Bob' }), 'ignored');
  assert.equal(await p, 'rejected');
});

test('会话取消 → cancelled', async () => {
  const { mgr, sent } = makeManager({ timeoutSec: 60 });
  const ac = new AbortController();
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash', signal: ac.signal };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  assert.equal(await p, 'cancelled');
});

// ── 回归：推送挂死不得卡死审批（round-2 P1-2） ──────────────────────────────
//
// 症状：渠道 send 永不 settle（webhook 挂死）时，prompt() 永久卡在 await send，
// 审批超时计时器也还没启动 ⇒ 审批瀑布流挂死、agent 卡住。
// 修复：① 发送看门狗（sendTimeoutSec，默认 60s，测试里调小）先决者胜；
//       ② 决议时移除 abort 监听（{once:true} 只在触发时移除，未触发会泄漏）。

test('回归：发送永不 settle → 看门狗按 unavailable 兜底，且调用方被解除（P1-2 + round-1 P1）', async () => {
  const sent = [];
  const logs = [];
  const { mgr } = makeManager({
    timeoutSec: 60,
    pendingMaxSec: 120,
    sendImpl: (chat, out) => {
      sent.push({ ...out, chat });
      return new Promise(() => {}); // 永不 settle
    },
    logCollect: logs,
  });
  mgr.configure({
    enabled: true, timeoutSec: 60, pendingMaxSec: 120, autoApproveRisk: 'none',
    riskRules: [{ tool: 'tool-bash', args: 'rm -rf', risk: 'high' }],
    sendTimeoutSec: 0.2,
  });
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash' };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  // 🔴 round-1 P1 核心断言：**await p 必须在有限时间内 resolve**。
  // 旧版 prompt() 直接 await send，发送挂死时 p 永不 settle（审批链/agent turn 卡死）；
  // 现在 send 是 fire-and-forget，看门狗结算后调用方立即拿到 unavailable。
  assert.equal(await p, 'unavailable', '发送挂死不得阻塞调用方：看门狗结算后 p 必须 resolve unavailable');
  assert.ok(sent.some((m) => m.text?.includes('推送超时')), '应补发推送超时提醒');
  // 记录已决，不留 waiting 残留
  assert.equal(mgr.records.size, 0, '看门狗结算后记录必须删除');
  // 审批日志落 unavailable（fail-closed）
  assert.ok(logs.some((l) => l.outcome === 'unavailable'), '日志应记录 unavailable');
  // 后续 respond 应报 ignored（已决窗口内）
  const card = sent.find((m) => m.buttons?.length);
  const id = card.buttons[0].id.split(':')[1];
  assert.equal(mgr.respond(id, 'yes', { platform: 'mock', userId: 'u1' }), 'ignored');
});

test('回归：发送期间 abort → 记录立即 cancelled（P1-2 时序）', async () => {
  const { mgr } = makeManager({
    timeoutSec: 60,
    pendingMaxSec: 120,
    sendImpl: (chat, out) => {
      return new Promise((resolve) => setTimeout(() => resolve({}), 50));
    },
  });
  mgr.configure({
    enabled: true, timeoutSec: 60, pendingMaxSec: 120, autoApproveRisk: 'none',
    riskRules: [{ tool: 'tool-bash', args: 'rm -rf', risk: 'high' }],
    sendTimeoutSec: 60,
  });
  const ac = new AbortController();
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash', signal: ac.signal };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10)); // 发送 in-flight
  ac.abort();
  // 记录在 abort 后**立即**（下一个微任务）即决——不等待发送返回。
  // 用短延迟断言"快"，而不是同一 tick 的同步断言（resolve 是微任务结算）。
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mgr.records.size, 0, 'abort 后记录必须立即删除（不等待发送返回）');
  assert.equal(await p, 'cancelled');
});

test('回归：abort 监听在决议时移除（不泄漏，P1-2 连带）', async () => {
  const { mgr } = makeManager({ timeoutSec: 60 });
  const { signal, activeCount } = makeTrackingSignal();
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash', signal };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeCount(), 1, '等待期间 abort 监听应已注册');
  const id = mgr.pendingList()[0].id;
  mgr.respond(id, 'no', { platform: 'mock', userId: 'u1' });
  assert.equal(await p, 'rejected');
  // 决议（非 abort 触发）后监听必须已移除：计数归零
  assert.equal(activeCount(), 0, '决议后 abort 监听必须移除（{once:true} 只在触发时移除，会泄漏）');
});

test('回归：dispose 也移除 abort 监听（不泄漏，round-1 P2）', async () => {
  const { mgr } = makeManager({ timeoutSec: 60 });
  const { signal, activeCount } = makeTrackingSignal();
  const req = { agent: { id: 'im-mock-c1' }, toolName: 'tool-bash', signal };
  const p = mgr.prompt(req, { platform: 'mock', chatId: 'c1', sessionId: 'im-mock-c1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeCount(), 1, '等待期间监听应已注册');
  // 有 pending 审批时卸载 manager：旧版先置空 onAbort 再 resolve，
  // resolve 内的 removeEventListener 被跳过 ⇒ 监听泄漏在 AbortSignal 上。
  mgr.dispose();
  assert.equal(activeCount(), 0, 'dispose 必须显式移除 abort 监听（会话级 signal 比单个审批长寿）');
  assert.equal(await p, 'cancelled', 'dispose 后 outcome 必须按 cancelled 结算');
});
