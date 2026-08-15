import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovalManager } from '../lib/approvals.js';
import { SessionMap } from '../lib/session-map.js';

function makeManager({ timeoutSec = 0.1, pendingMaxSec = 0.3, autoApproveRisk = 'none', riskRules } = {}) {
  const sent = [];
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), 'im-ap-'));
  const map = new SessionMap(dir);
  map.create('mock', 'c1', { chatType: 'private' });
  map.addToAllowlist('mock', 'u1');
  const mgr = new ApprovalManager({
    ctx: { on: () => () => {} },
    map,
    send: async (chat, out) => { sent.push({ ...out, chat }); return {}; },
    logLine: (line) => logs.push(line),
  });
  mgr.configure({
    enabled: true, timeoutSec, pendingMaxSec, autoApproveRisk,
    riskRules: riskRules ?? [{ tool: 'tool-bash', args: 'rm -rf', risk: 'high' }],
  });
  return { mgr, map, sent, logs };
}

const exec = (tool, args, agentId = 'im-mock-c1') => ({
  name: tool,
  arguments: args,
  callId: 'call-1',
  agent: { id: agentId },
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
  const { mgr, sent } = makeManager({ timeoutSec: 0.05, pendingMaxSec: 0.1 });
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
  const { mgr, sent } = makeManager({ timeoutSec: 0.05, pendingMaxSec: 60 });
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
