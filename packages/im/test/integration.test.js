// 全链路集成测试（PRD Phase 2：MockChannel 契约测试先行）
//
// 组合真实的 DSH agent loop（dsh-agent-loop-testkit）+ 脚本化 mock LLM
// + dsh-user-approval + 本插件 dsh-im + MockChannel，验证三条核心链路：
//   1. 派活：IM 消息 → agent.followup → 结果经通知总线回 IM
//   2. 审批：高危工具调用 → IM 审批卡片 → 点按钮 → 放行 → agent 继续
//   3. 命令：/status /log 等
//
// 无需任何真实 IM token 或 LLM key（NFR-7）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools';

import ImRuntime from '../lib/index.js';
import { MockChannel } from '../lib/mock-channel.js';

/** 脚本化 mock LLM：按请求顺序播放 chunk 序列。 */
class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super();
    this.script = script;
    this.calls = 0;
    this.requestTexts = [];
  }
  async *stream(options) {
    this.requestTexts.push(options.messages.map((m) => {
      const text = m.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      return `${m.role}:${String(text ?? '').slice(0, 80)}`;
    }));
    const step = this.script[Math.min(this.calls++, this.script.length - 1)];
    for (const chunk of step.chunks) yield chunk;
  }
}

/** 轮询等待条件成立（带超时）。 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const MOCK_CFG = {
  security: {
    allowlist: ['mock:user-1'],
    admins: ['mock:user-1'],
    autoCreate: true,
    maxSessions: 10,
    trustOnFirstContact: true,
  },
  approvals: {
    enabled: true,
    timeoutSec: 60,
    pendingMaxSec: 120,
    autoApproveRisk: 'none',
    riskRules: [{ tool: 'test-danger', args: '', risk: 'high' }],
  },
  notifications: {
    onTurnEnd: true,
    onError: true,
    includeCost: false,
    streamWhileOnline: false, // 测试里不测流式增量，只测结果卡片
    onlineWindowMin: 10,
    quietHours: [],
    flushIntervalMs: 400,
  },
  agent: { provider: 'mock-llm', model: 'mock-model', workspace: process.cwd() },
  storeDir: '',
};

async function setup(script, cfgOverrides = {}) {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  ctx.plugin(ApprovalService, { policy: 'ask' });
  ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new ScriptedAdapter(script);
  ctx.get('llm').registerAdapter(['mock-llm'], adapter);

  const storeDir = mkdtempSync(join(tmpdir(), 'im-int-'));
  const mergedCfg = {
    ...MOCK_CFG,
    security: { ...MOCK_CFG.security, ...(cfgOverrides.security ?? {}) },
    approvals: { ...MOCK_CFG.approvals, ...(cfgOverrides.approvals ?? {}) },
    notifications: { ...MOCK_CFG.notifications, ...(cfgOverrides.notifications ?? {}) },
    agent: { ...MOCK_CFG.agent, ...(cfgOverrides.agent ?? {}) },
    storeDir,
  };
  const imHandle = ctx.plugin(ImRuntime, mergedCfg);
  await imHandle.await(); // 等插件 setup 完成（构造/init）
  const im = ctx.get('im');
  await im.whenReady();

  const mock = new MockChannel();
  im.registerChannel(mock);

  return {
    ctx,
    mock,
    adapter,
    im,
    teardown: async () => {
      await imHandle?.dispose?.();
      await ctx.get('llm')?.dispose?.();
    },
  };
}

test('派活 → 审批 → 放行 → 结果卡片（全链路）', async () => {
  const script = [
    {
      chunks: [
        { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'test-danger', argumentsDelta: '{"command":"rm -rf ~"}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    },
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '搞定！危险操作已执行，测试通过 ✅' },
        { type: 'usage', usage: { inputTokens: 120, outputTokens: 18 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { ctx, mock, im, teardown } = await setup(script);
  ctx.get('tools').register(defineContentToolFixture({
    name: 'test-danger',
    description: '危险测试工具（集成测试用）',
    parameters: { command: { type: 'string' } },
    execute: async (args) => [{ type: 'text', text: `ran: ${args.command}` }],
  }));

  try {
    // 1) 派活
    await mock.sendFromUser({ text: '跑一下测试' });
    // 2) agent 请求高危工具 → 审批卡片推送到 IM
    const card = await waitFor(() => mock.sent.find((m) => m.buttons?.some((b) => b.id.startsWith('approve:'))), { label: 'approval card' });
    assert.ok(card.text.includes('test-danger'), '卡片包含工具名');
    assert.ok(card.text.includes('rm -rf ~'), '卡片包含脱敏后的参数摘要');
    const approveId = card.buttons.find((b) => b.id.startsWith('approve:')).id.split(':')[1];
    // 3) 未批准前 agent 阻塞在审批上
    assert.ok(!mock.sent.some((m) => m.text.includes('任务完成')), '未批准前不应有结果卡片');
    // 4) 点【批准】
    await mock.pressButton(`approve:${approveId}:yes`, { userId: 'user-1' });
    // 5) 工具执行 → 第二轮模型回复 → turn/end 结果卡片
    const result = await waitFor(() => mock.sent.find((m) => m.text.includes('任务完成')), { label: 'result card', timeoutMs: 8000 });
    assert.ok(result.text.includes('搞定！危险操作已执行'), '结果卡片包含回复摘要');
    assert.ok(result.text.includes('120 in / 18 out'), '结果卡片包含 token 用量');
    // 6) 审批日志已写
    const { readFile } = await import('node:fs/promises');
    const log = await readFile(join(im.storeDir, 'approvals.log'), 'utf8');
    assert.ok(log.includes('allowed-once'), '审批日志记录放行');
    assert.ok(log.includes('test-danger'));
  } finally {
    await teardown();
  }
});

test('拒绝高危工具调用（deny-by-default）', async () => {
  const script = [
    {
      chunks: [
        { type: 'tool-call-delta', index: 0, id: 'call-2', name: 'test-danger', argumentsDelta: '{"command":"rm -rf /"}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    },
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '用户拒绝了，我不执行。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { ctx, mock, teardown } = await setup(script);
  ctx.get('tools').register(defineContentToolFixture({
    name: 'test-danger',
    description: '危险测试工具',
    parameters: { command: { type: 'string' } },
    execute: async () => [{ type: 'text', text: 'should not run' }],
  }));
  try {
    await mock.sendFromUser({ text: '执行危险命令' });
    const card = await waitFor(() => mock.sent.find((m) => m.buttons?.some((b) => b.id.startsWith('approve:'))), { label: 'approval card' });
    const approveId = card.buttons.find((b) => b.id.startsWith('approve:')).id.split(':')[1];
    await mock.pressButton(`approve:${approveId}:no`, { userId: 'user-1' });
    const result = await waitFor(() => mock.sent.find((m) => m.text.includes('任务完成')), { label: 'result card' });
    assert.ok(result.text.includes('用户拒绝'), 'agent 收到拒绝结果');
  } finally {
    await teardown();
  }
});

test('/new 创建会话 + /status 状态查询 + /log 全量输出', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '这是一段非常长的输出：' + 'x'.repeat(500) },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { ctx, mock, teardown } = await setup(script);
  try {
    await mock.sendFromUser({ text: '/new' });
    await waitFor(() => mock.sent.some((m) => m.text.includes('新会话已创建')), { label: '/new reply' });
    await mock.sendFromUser({ text: '生成一个长报告' });
    await waitFor(() => mock.sent.some((m) => m.text.includes('任务完成')), { label: 'result card' });
    // /status
    await mock.sendFromUser({ text: '/status' });
    const status = await waitFor(() => mock.sent.find((m) => m.text.includes('渠道连接')), { label: '/status reply' });
    assert.ok(status.text.includes('mock'), '/status 列出渠道');
    assert.ok(status.text.includes('会话'), '/status 列出会话');
    // /log 全量交付
    await mock.sendFromUser({ text: '/log' });
    const full = await waitFor(() => mock.sent.find((m) => m.text.includes('这是一段非常长的输出')), { label: '/log full output' });
    assert.ok(full.text.includes('x'.repeat(100)), '/log 返回完整输出');
  } finally {
    await teardown();
  }
});

test('首次信任确认：未知用户 → 管理员确认（FR-9.2）', async () => {
  const script = [];
  const { ctx, mock, teardown } = await setup(script, { security: { trustOnFirstContact: false } });
  try {
    // 未知用户发消息（不在 allowlist）
    await mock.sendFromUser({ chatId: 'c2', userId: 'stranger', userName: '陌生人', text: 'hello' });
    // 管理员（user-1 的私聊是 mock:user-1 → chatId 'user-1'）收到信任确认
    await waitFor(() => mock.sent.some((m) => m.chatId === 'user-1' && m.text.includes('信任确认')), { label: 'admin trust prompt' });
    // 未知用户收到等待提示
    assert.ok(mock.sent.some((m) => m.chatId === 'c2' && m.text.includes('尚未被授权')));
    // 管理员批准信任（/trust 或按钮）
    await mock.pressButton('trust:mock:stranger', { chatId: 'user-1', userId: 'user-1' });
    // 陌生人可派活了
    await mock.sendFromUser({ chatId: 'c2', userId: 'stranger', text: 'hi again' });
    // autoCreate=true → 直接创建会话并派活（无 LLM 脚本时 turn 会失败，但会话已建立，会收到反馈）
    await waitFor(() => mock.sent.some((m) => m.chatId === 'c2' && !m.text.includes('尚未被授权')), { label: 'stranger accepted' });
  } finally {
    await teardown();
  }
});

test('管理员只配 admins（allowlist 留空）也能直接通过安全门（隐式放行）', async () => {
  const script = [];
  const { ctx, mock, teardown } = await setup(script, {
    security: { allowlist: [], admins: ['mock:user-1'], autoCreate: true, trustOnFirstContact: false },
  });
  try {
    // 管理员自己发消息：不应收到 ⛔ 未授权
    await mock.sendFromUser({ chatId: 'user-1', userId: 'user-1', text: 'hello' });
    await waitFor(() => mock.sent.some((m) => m.chatId === 'user-1' && !m.text.includes('未授权')), {
      label: 'admin passes gate',
      timeoutMs: 8000,
    });
    assert.ok(!mock.sent.some((m) => m.text.includes('未授权')), 'admin 不应被安全门拦截');
  } finally {
    await teardown();
  }
});
