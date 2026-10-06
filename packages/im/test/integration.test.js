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
  // 间谍：testkit 不提供官方 agentPresets 注册表，这里记录挂载调用。
  // IM agent 若不挂载 preset，就拿不到文件/shell 工具（read/write/edit/glob/grep/pwsh），
  // 表现为「IM 会话读不了文件」—— 这是 issue 的回归点。
  const presetMounts = [];
  ctx.provide('agentPresets', {
    mount: async (_agentCtx, presetId) => {
      presetMounts.push(presetId);
      return { id: presetId };
    },
  });
  const adapter = new ScriptedAdapter(script);
  ctx.get('llm').registerAdapter(['mock-llm'], adapter);

  const storeDir = mkdtempSync(join(tmpdir(), 'im-int-'));
  const mergedCfg = {
    ...MOCK_CFG,
    security: { ...MOCK_CFG.security, ...(cfgOverrides.security ?? {}) },
    approvals: { ...MOCK_CFG.approvals, ...(cfgOverrides.approvals ?? {}) },
    notifications: { ...MOCK_CFG.notifications, ...(cfgOverrides.notifications ?? {}) },
    agent: { ...MOCK_CFG.agent, ...(cfgOverrides.agent ?? {}) },
    userQuestions: { ...(MOCK_CFG.userQuestions ?? {}), ...(cfgOverrides.userQuestions ?? {}) },
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
    presetMounts,
    teardown: async () => {
      await imHandle?.dispose?.();
      await ctx.get('llm')?.dispose?.();
    },
  };
}

// ── 回归：userQuestions.sendTimeoutSec 必须进入配置 schema（round-8 P3）──────
// 此前 schema 漏声明该字段：部署者配置的值被配置解析剥离，生产环境永远回落
// 构造器默认 60s（看门狗无法按部署者意图调整/关闭）。验证以**真实插件挂载**
// 为准：配置值必须原样到达 UserQuestionAnswerer.cfg。

test('回归：userQuestions.sendTimeoutSec 经插件挂载透传（round-8 P3）', async () => {
  const { im, teardown } = await setup(QSCRIPT, {
    userQuestions: { sendTimeoutSec: 10 },
  });
  try {
    assert.equal(
      im.userQuestions.cfg.sendTimeoutSec,
      10,
      '配置的值必须保留到应答器，不能被 schema 剥离',
    );
  } finally {
    await teardown();
  }
});

test('回归：userQuestions.sendTimeoutSec 缺省 60s（round-8 P3）', async () => {
  const { im, teardown } = await setup(QSCRIPT);
  try {
    assert.equal(
      im.userQuestions.cfg.sendTimeoutSec,
      60,
      '缺省 60s（与构造器默认一致）',
    );
  } finally {
    await teardown();
  }
});

// ── 回归：IM agent 必须挂载 agent preset ────────────────────────────────────
//
// 症状：钉钉/飞书会话里 agent 无法读取文件。
// 根因：dsh-im 创建 agent 时既没传 meta.agentPreset，也没用 setup 挂载 preset。
//       文件与 shell 工具（tool-fs / tool-fs-search / tool-pwsh）都声明在 preset 里，
//       不是根级插件贡献的 —— 于是 IM 会话只剩 agent-team/schedule/skill 那几个工具。
//       实测对照：未挂载时 15 个工具（无一个文件工具），挂载后 37 个。
// 修复：createAgent 传 meta.agentPreset 并在 setup 里 agentPresets.mount。

test('回归：派活时必须挂载 agent preset（否则 IM 会话没有文件/shell 工具）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, presetMounts, teardown } = await setup(script);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => presetMounts.length > 0, { label: 'agentPresets.mount', timeoutMs: 8000 });
    assert.ok(
      presetMounts.includes('standard'),
      'IM agent 必须挂载 standard preset；不挂载则没有 read/write/edit/glob/grep/pwsh',
    );
  } finally {
    await teardown();
  }
});

test('回归：agent.preset 可配置（非 standard 时按配置挂载）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, presetMounts, teardown } = await setup(script, { agent: { preset: 'minimal' } });
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => presetMounts.length > 0, { label: 'agentPresets.mount', timeoutMs: 8000 });
    assert.deepEqual(presetMounts, ['minimal'], '应按配置的 preset id 挂载');
  } finally {
    await teardown();
  }
});

// ── 回归：出站必须把平台 userId 下传给渠道 ──────────────────────────────────
//
// 症状：钉钉里审批卡片、提问卡片都收不到，且无明显报错。
// 根因：钉钉 sessionWebhook 是会话级短期凭证，过期后出站降级到「机器人主动推送」，
//       而那条路径要求**平台 userId**；dsh-im 传来的 chatId 却是 conversationId
//       （会话级不透明串），平台返回 staffId.notExisted。适配器当时只依赖自己入站
//       学到的**内存**映射，进程一重启就丢，于是降级路径必然用错值并静默失败。
// 修复：核心层从**持久化**会话映射取 userId 一并下传（out.userId）。

test('回归：出站把持久化会话映射里的 userId 下传给渠道', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    // 入站带 userId → 会话映射记录该用户
    await mock.sendFromUser({ text: '你好', userId: 'user-42' });
    await waitFor(() => mock.sent.length > 0, { label: 'outbound message', timeoutMs: 8000 });

    // 所有出站消息都应带上该会话的 userId，渠道才能主动推送
    const missing = mock.sent.filter((m) => m.userId !== 'user-42');
    assert.equal(
      missing.length,
      0,
      `出站消息必须带 userId（渠道据此主动推送）；缺失 ${missing.length} 条：`
      + JSON.stringify(missing.slice(0, 2).map((m) => ({ chatId: m.chatId, text: m.text?.slice(0, 30) }))),
    );
  } finally {
    await teardown();
  }
});

// ── /answer skip：跳过选择，让 agent 自行决定 ───────────────────────────────

test('/answer skip：跳过提问并把空答案回传（agent 自行决定继续）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    const sessionId = im.map.get('mock', 'chat-1').sessionId;

    // 直接走应答者，模拟 agent 提问
    let delegated = false;
    const p = im.userQuestions.answer(
      {
        agent: { id: sessionId },
        questions: [
          { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
          { id: 'q2', question: '要不要备份？', options: [{ label: '要' }, { label: '不要' }] },
        ],
      },
      async () => { delegated = true; return { answers: [] }; },
    );
    await waitFor(() => im.userQuestions.records.size > 0, { label: 'question pushed', timeoutMs: 8000 });
    assert.equal(delegated, false, 'IM 会话应由 IM 应答者认领');

    const qid = [...im.userQuestions.records.keys()][0];
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, 'skip']);

    const ans = await p;
    assert.deepEqual(
      ans.answers,
      [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }],
      'skip 必须回传空选择，agent 才能自行决定',
    );
    assert.ok(
      mock.sent.some((m) => m.text?.includes('已跳过')),
      '应回执「已跳过」',
    );
  } finally {
    await teardown();
  }
});

// ── /answer <id> <编号>：选编号（主要用法） ─────────────────────────────────

async function pushQuestion(im, questions) {
  const sessionId = im.map.get('mock', 'chat-1').sessionId;
  const p = im.userQuestions.answer({ agent: { id: sessionId }, questions }, async () => {
    throw new Error('不该委托');
  });
  await waitFor(() => im.userQuestions.records.size > 0, { label: 'question pushed', timeoutMs: 8000 });
  const qid = [...im.userQuestions.records.keys()][0];
  return { p, qid };
}

const QSCRIPT = [
  {
    chunks: [
      { type: 'text-delta', index: 0, text: '收到' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  },
];

test('/answer <编号>：多问题按 问题号.选项号 选中，selected 非空', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '环境？', options: [{ label: 'staging' }, { label: 'production' }] },
      { id: 'q2', question: '备份？', options: [{ label: '要' }, { label: '不要' }] },
    ]);
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '1.2,2.1']);

    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['production'] },
      { id: 'q2', selected: ['要'] },
    ], '按编号必须选中对应选项（不能是空选择）');
    assert.ok(mock.sent.some((m) => m.text?.includes('已回答')), '应回执「已回答」');
  } finally {
    await teardown();
  }
});

test('/answer <编号>：单问题直接写序号', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
    ]);
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '3']);

    assert.deepEqual((await p).answers, [{ id: 'q1', selected: ['C'] }]);
  } finally {
    await teardown();
  }
});

test('/answer <编号> <文字>：选编号并附自定义文字', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '2', '顺便', '加日志']);

    assert.deepEqual((await p).answers, [{ id: 'q1', selected: ['B'], custom: '顺便 加日志' }]);
  } finally {
    await teardown();
  }
});

test('/answer <编号>：越界编号被拒绝，提问仍可正常回答', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    // 负编号 → 直接拒绝，不应把提问结束掉
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '-1']);
    assert.ok(mock.sent.some((m) => m.text?.includes('编号无效')), '应提示编号无效');
    assert.equal(im.userQuestions.records.size, 1, '提问应仍然待答，不能被误判为已答');

    // 随后用有效编号仍能正常回答
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '1']);
    assert.deepEqual((await p).answers, [{ id: 'q1', selected: ['A'] }]);
  } finally {
    await teardown();
  }
});

test('直接回数字即作答：不必记 /answer 语法，也不会中断回合', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p } = await pushQuestion(im, [
      { id: 'q1', question: '环境？', options: [{ label: 'staging' }, { label: 'production' }] },
    ]);
    const before = mock.sent.length;

    // 用户只回一个数字
    await mock.sendFromUser({ text: '2' });

    assert.deepEqual((await p).answers, [{ id: 'q1', selected: ['production'] }],
      '回数字必须被当成作答，而不是新任务');
    assert.ok(
      mock.sent.slice(before).some((m) => m.text?.includes('已回答')),
      '应回执「已回答」',
    );
  } finally {
    await teardown();
  }
});

test('直接回 skip 即跳过', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p } = await pushQuestion(im, [
      { id: 'q1', question: '环境？', options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    await mock.sendFromUser({ text: 'skip' });
    assert.deepEqual((await p).answers, [{ id: 'q1', selected: [] }]);
  } finally {
    await teardown();
  }
});

test('无待答提问时，数字仍是普通消息（不劫持）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    assert.equal(im.userQuestions.records.size, 0);

    // 没有待答提问 → 「2」应作为普通任务派给 agent，而不是被当成作答
    await mock.sendFromUser({ text: '2' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('收到')), { label: 'agent reply', timeoutMs: 8000 });
  } finally {
    await teardown();
  }
});

test('出站：渠道声明 maxMessageBytes 时按字节分段发送（不超限、不丢内容）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    mock.maxMessageBytes = 300; // 让渠道声明很小的字节上限
    const long = '中文内容测试'.repeat(200); // 1200 字 ≈ 3600 字节
    await im.send({ platform: 'mock', chatId: 'chat-1' }, { text: long });

    const mine = mock.sent.filter((m) => m.text?.includes('中文内容测试'));
    assert.ok(mine.length > 1, `超限必须分段（实际 ${mine.length} 段）`);
    for (const m of mine) {
      assert.ok(
        Buffer.byteLength(m.text, 'utf8') <= 300,
        `每段必须 ≤300 字节（实际 ${Buffer.byteLength(m.text, 'utf8')}）`,
      );
    }
    assert.ok(mine[0].text.startsWith('(1/'), '应带 (i/n) 序号');
    // 去掉序号后拼回必须等于原文（splitByBytes 的无损不变式）
    const rejoined = mine.map((m) => {
      const idx = m.text.indexOf(') ');
      return m.text.startsWith('(') ? m.text.slice(idx + 2) : m.text;
    }).join('');
    assert.equal(rejoined, long, '分段必须无损');
  } finally {
    await teardown();
  }
});

test('出站：渠道未声明 maxMessageBytes 时不分段', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    const long = 'x'.repeat(5000);
    await im.send({ platform: 'mock', chatId: 'chat-1' }, { text: long });
    assert.equal(mock.sent.filter((m) => m.text === long).length, 1, '未声明上限则原样发送');
  } finally {
    await teardown();
  }
});

test('回归：分段时按钮命令块不被切开（可整条复制）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '收到' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    mock.maxMessageBytes = 300;
    mock.buttonsAsText = true;   // 文本型渠道：核心负责把按钮渲染进正文
    const buttons = [
      { id: 'a:1', label: '批准', command: '/approve aaaaaaaa yes' },
      { id: 'a:2', label: '拒绝', command: '/approve aaaaaaaa no' },
    ];
    const long = '中文正文内容'.repeat(80);   // ≈ 1440 字节，必然分段
    await im.send({ platform: 'mock', chatId: 'chat-1' }, { text: long, buttons });

    const mine = mock.sent.filter((m) => m.text?.includes('正文内容') || m.text?.includes('/approve'));
    assert.ok(mine.length > 1, `应分段（实际 ${mine.length} 段）`);
    for (const m of mine) {
      assert.ok(Buffer.byteLength(m.text, 'utf8') <= 300, `每段 ≤300 字节（实际 ${Buffer.byteLength(m.text, 'utf8')}）`);
    }
    // 每条命令都必须完整出现在**某一段**里（不能被切断）
    const joinedSegments = mine.map((m) => m.text);
    for (const b of buttons) {
      assert.ok(
        joinedSegments.some((t) => t.includes(b.command)),
        `命令 ${b.command} 必须完整落在某一段内`,
      );
    }
    // 且不得重复渲染（核心渲染后适配器不应再追加）
    const occurrences = joinedSegments.join('\n').split('/approve aaaaaaaa yes').length - 1;
    assert.equal(occurrences, 1, '命令不得重复');
  } finally {
    await teardown();
  }
});

test('回归：按钮回调走逐题累计（第一次 partial 且保留记录，第二次才结题）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
      { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
    ]);

    // 第一次点击：应为 partial（记录保留、回执含进度），而不是把第二题当空答案提交
    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'Tester',
      data: `q:${qid}:0:1`,
    });
    assert.equal(im.userQuestions.records.size, 1, '第一次点击后必须仍在等待');
    assert.ok(
      mock.sent.some((m) => m.text?.includes('进度 1/2')),
      '应回报累计进度',
    );

    // 第二次点击：答全 → 自动结题
    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'Tester',
      data: `q:${qid}:1:0`,
    });
    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['a2'] },
      { id: 'q2', selected: ['b1'] },
    ], '两题都必须是用户点的，不能被空答案顶替');
  } finally {
    await teardown();
  }
});

test('回归：混合题型（有选项 + 自由文本）不得被按钮自动结题', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { qid } = await pushQuestion(im, [
      { id: 'q1', question: '选一个', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: '项目叫什么？' },   // 自由文本题，按钮无法作答
    ]);

    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'Tester',
      data: `q:${qid}:0:0`,
    });
    // round-4 发现：含自由文本题时不能自动结题，否则该题被伪造成空答案
    assert.equal(im.userQuestions.records.size, 1, '含自由文本题时必须继续等待');
    assert.ok(
      mock.sent.some((m) => m.text?.includes('text <内容>')),
      '应告知按钮无法完成文字题、需要用显式 text 语法',
    );
  } finally {
    await teardown();
  }
});

test('回归：混合题型用显式 `/answer text` 填文字题并完成', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选一个', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: '项目叫什么？' },   // 自由文本题
    ]);
    // 先点有选项那题 → partial（含自由文本题，不自动结题）
    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'Tester',
      data: `q:${qid}:0:1`,
    });
    assert.equal(im.userQuestions.records.size, 1, '含自由文本题时先保持等待');

    // 混合题型的文字题必须用**显式**语法（round-6：普通文字不再被吞，避免丢任务）
    await im.commandAnswer(
      { platform: 'mock', chatId: 'chat-1', userId: 'user-1' },
      [qid, 'text', '我的', '项目名'],
    );

    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['b'] },
      { id: 'q2', selected: [], custom: '我的 项目名' },
    ], '文字必须填入自由文本题，且与选项题的答案一起提交');
  } finally {
    await teardown();
  }
});

test('回归：混合题型的普通文字**不再**被吞（保护用户新任务）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { qid } = await pushQuestion(im, [
      { id: 'q1', question: '选一个', options: [{ label: 'a' }, { label: 'b' }] },
      { id: 'q2', question: '项目叫什么？' },
    ]);
    const before = mock.sent.length;

    // 用户本意是派新任务 → 不得被当成问卷答案（否则任务丢失，round-6 P2）
    await mock.sendFromUser({ text: '部署生产环境' });

    assert.equal(im.userQuestions.records.size, 1, '提问应仍在等待');
    const rec = im.userQuestions.records.get(qid);
    assert.equal(rec.draftCustom.size, 0, '文字不得被吞成答案');
    // 该消息应作为新任务被派给 agent（而非静默丢弃）
    await waitFor(
      () => mock.sent.slice(before).some((m) => m.text?.includes('收到')),
      { label: 'agent 收到新任务', timeoutMs: 8000 },
    );
  } finally {
    await teardown();
  }
});

test('回归：纯文字题卡片回数字应作为文字答案（不是选项编号）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p } = await pushQuestion(im, [{ id: 'q1', question: '工单号？' }]);
    // 纯文字题卡片没有可选项 → 「123」必须是文字答案（round-6 P2）
    await mock.sendFromUser({ text: '123' });

    const ans = await p;
    assert.deepEqual(ans.answers, [{ id: 'q1', selected: [], custom: '123' }]);
  } finally {
    await teardown();
  }
});

test('回归：continued 状态下 done 仍能提交草稿（草稿不白丢）', async () => {
  const delivered = [];
  const svc = { answer: (agent, callId, answer) => { delivered.push({ callId, answer }); return true; } };
  const { UserQuestionAnswerer } = await import('../lib/user-questions.js');
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: (k) => (k === 'userQuestions' ? svc : undefined) },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => {},
    logLine: () => {},
    cfg: {},
  });
  const ac = new AbortController();
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
      signal: ac.signal,
      wait: { callId: 'call-7', timed: true },
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = [...a.records.keys()][0];
  const from = { platform: 'mock', chatId: 'c1' };
  a.accumulate(id, [{ qIndex: 0, oIndex: 1 }], from);   // 先累计一部分
  ac.abort();                                          // timed 超时 → 转 continued
  await assert.rejects(p);
  assert.equal(a.continued.size, 1);

  // round-5 发现 2：此前 commitDraft 只查 records，continued 下 done 会 not-found
  assert.equal(a.commitDraft(id, from), 'continued', 'continued 下 done 必须能提交草稿');
  assert.equal(delivered.length, 1, '必须经继续协议送达');
  // DSH 要求答案批必须"每题恰好一次"
  assert.deepEqual(delivered[0].answer.answers, [
    { id: 'q1', selected: ['a2'] },
    { id: 'q2', selected: [] },
  ]);
});

test('回归：原生按钮渠道分段时按钮只出现在最后一段', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    mock.maxMessageBytes = 300;
    // 不声明 buttonsAsText → 按钮走原生渲染，核心必须保留它们
    const buttons = [
      { id: 'a:1', label: '批准', command: '/approve a yes' },
      { id: 'a:2', label: '拒绝', command: '/approve a no' },
    ];
    await im.send({ platform: 'mock', chatId: 'chat-1' }, { text: 'x'.repeat(1200), buttons });

    const segs = mock.sent.filter((m) => m.text?.includes('x'));
    assert.ok(segs.length > 1, `应分段（实际 ${segs.length}）`);
    const withButtons = segs.filter((m) => m.buttons?.length);
    // round-6 P2：此前每段都带按钮，用户点前面的会拿到 not-found（无效操作）
    assert.equal(withButtons.length, 1, '按钮只能出现在一段里');
    assert.equal(withButtons[0], segs[segs.length - 1], '必须在最后一段');
  } finally {
    await teardown();
  }
});

test('回归：文本按钮渠道分段时附件不得丢失（恰好投递一次）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    mock.maxMessageBytes = 300;
    mock.buttonsAsText = true;   // 文本型渠道：核心把按钮渲染进正文、命令块独占末段
    await im.send({ platform: 'mock', chatId: 'chat-1' }, {
      text: 'x'.repeat(1200),
      buttons: [{ id: 'a:1', label: '批准', command: '/approve a yes' }],
      attachments: [{ kind: 'file', name: 'r.txt', text: '附件内容' }],
    });
    const withAtt = mock.sent.filter((m) => m.attachments?.length);
    // round-n1 F03：此前 lastBodyIdx=-1 让每段都清附件，命令末段也清 ⇒ 附件全丢
    assert.equal(withAtt.length, 1, '附件必须恰好投递一次');
    assert.equal(withAtt[0], mock.sent[mock.sent.length - 1], '必须挂在整体最后一条');
    // 文本型渠道：按钮已被核心渲染进正文（单一真源），不会再有 buttons 字段；
    // 渲染出的命令必须恰好出现一次
    assert.equal(mock.sent.filter((m) => m.buttons?.length).length, 0, '文本渠道不应再带 buttons 字段');
    const rendered = mock.sent.map((m) => m.text ?? '').join('\n');
    assert.equal(rendered.split('/approve a yes').length - 1, 1, '命令必须恰好渲染一次');
  } finally {
    await teardown();
  }
});

test('回归：被拒绝的作答不得污染草稿（原子合并）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
      { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
    ]);
    const from = { platform: 'mock', chatId: 'chat-1', userId: 'user-1' };

    // 第二题越界 → 整批拒绝，第一题也不得被写入（round-n1 F04）
    await im.commandAnswer(from, [qid, '1.1,2.99']);
    const rec = im.userQuestions.records.get(qid);
    assert.equal(rec.draft.size, 0, '被拒绝的请求不得留下任何草稿');

    // 随后正常答两题即可完成（若草稿被污染，这里会带上被拒绝的答案）
    await im.commandAnswer(from, [qid, '1.2,2.1']);
    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['a2'] },
      { id: 'q2', selected: ['b1'] },
    ]);
  } finally {
    await teardown();
  }
});

test('回归：retry 回调必须过权限与归属校验', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    const sessionId = im.map.get('mock', 'chat-1').sessionId;

    // 别的聊天（同平台）用本会话的 id 发起 retry → 必须被拒
    await im.handleCallback({
      platform: 'mock', chatId: 'other-chat', userId: 'user-1', userName: 'Tester',
      data: `retry:${sessionId}`,
    });
    assert.ok(
      mock.sent.some((m) => m.text?.includes('不属于本会话')),
      '跨会话 retry 必须被拒（round-n1 F01）',
    );

    // 未授权用户 → 必须被拒
    mock.reset();
    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'stranger', userName: 'X',
      data: `retry:${sessionId}`,
    });
    assert.ok(
      mock.sent.some((m) => m.text?.includes('无权限')),
      '未授权用户 retry 必须被拒',
    );
  } finally {
    await teardown();
  }
});

test('回归：未授权首条消息不得创建会话绑定（F10，不得绕过 autoCreate/maxSessions）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    const before = im.map.size;
    // 陌生用户先说话 → 只应记录"最近发言者"，不应建绑定
    await mock.sendFromUser({ text: '你好', userId: 'stranger' });
    assert.equal(im.map.size, before, '未授权用户不得占用绑定名额');
    assert.ok(
      im.lastSeen.get('mock:chat-1')?.userId === 'stranger',
      '但仍须记住发言者，供出站带 userId',
    );
  } finally {
    await teardown();
  }
});

test('回归：多选按钮不得在第一次点击就结题（F06）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选几个？', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true },
    ]);
    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'T', data: `q:${qid}:0:0`,
    });
    // 第一次点击后必须仍在等待，否则用户无法再选第二项
    assert.equal(im.userQuestions.records.size, 1, '多选题第一次点击后应继续等待');

    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'T', data: `q:${qid}:0:2`,
    });
    assert.equal(im.userQuestions.records.size, 1, '仍未 done，继续等待');

    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, 'done']);
    const ans = await p;
    assert.deepEqual(ans.answers, [{ id: 'q1', selected: ['a', 'c'] }], '多选应累计两项');
  } finally {
    await teardown();
  }
});

test('回归：/answer 空格分隔与直接回数字口径一致（F07）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
      { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
    ]);
    // 空格分隔的两个 token 必须等价于 `/answer <id> 1.1,2.2`
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '1.1', '2.2']);
    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['a1'] },
      { id: 'q2', selected: ['b2'] },
    ]);
  } finally {
    await teardown();
  }
});

test('回归：/mute 必须真的静默通知（F14）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    const binding = im.map.get('mock', 'chat-1');

    await im.commandMute({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, true);
    assert.equal(binding.muted, true, '状态应写入');

    mock.reset();
    // 走真实的流式通知路径：appendStream + flush(force)
    const st = im.notify.state(binding.sessionId);
    im.notify.appendStream(binding, 'x'.repeat(80));
    await im.notify.flush(st, true);
    assert.equal(
      mock.sent.filter((m) => m.text?.includes('xxxx')).length, 0,
      '/mute 后普通通知必须被静默（此前 muted 从不被读取）',
    );

    await im.commandMute({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, false);
    const st2 = im.notify.state(binding.sessionId);
    im.notify.appendStream(binding, 'y'.repeat(80));
    await im.notify.flush(st2, true);
    assert.ok(mock.sent.some((m) => m.text?.includes('yyyy')), 'unmute 后应恢复推送');
  } finally {
    await teardown();
  }
});

// ── round-2 复审修复的回归（P1-1 / P1-2 连带 / P2 簇） ─────────────────────

test('回归：多选卡经 /answer 命令也不得自动结题（round-2 P1-1）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选几个？', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true },
    ]);
    // 此前：_isComplete 只看 draft.has(qi) → 第一项即结题，第二项 not-found
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '1']);
    assert.equal(im.userQuestions.records.size, 1, '多选卡 /answer 1 后必须继续等待');
    const incomplete = mock.sent.find((m) => m.text?.includes('多选题'));
    assert.ok(incomplete, '回执应明确提示多选题需显式 done');
    assert.ok(incomplete.text.includes('/answer'), '回执应给出 /answer <id> done 路径');

    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '3']);
    assert.equal(im.userQuestions.records.size, 1, '第二项后仍未结题');

    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, 'done']);
    const ans = await p;
    assert.deepEqual(ans.answers, [{ id: 'q1', selected: ['a', 'c'] }], '多选累计两项后由 done 提交');
  } finally {
    await teardown();
  }
});

test('回归：mixed 卡（多选+文字）填完文字也不得自动结题（round-2 P1-1）', async () => {
  const { im, teardown } = await setup(QSCRIPT);
  try {
    await (im.map.get('mock', 'chat-1') ?? im.createBinding('mock', 'chat-1', 'private'));
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选几个？', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
      { id: 'q2', question: '备注？' },
    ]);
    // 先点一个多选选项（按钮路径累计）
    await im.handleCallback({
      platform: 'mock', chatId: 'chat-1', userId: 'user-1', userName: 'T', data: `q:${qid}:0:0`,
    });
    assert.equal(im.userQuestions.records.size, 1, '多选第一项后继续等待');
    // 文字题填完的瞬间，卡片"形式上答全"——但多选未完成，不得结题
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, 'text', '备注内容']);
    assert.equal(im.userQuestions.records.size, 1, '文字题填完但多选未完成 → 必须继续等待');

    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, 'done']);
    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['a'] },
      { id: 'q2', selected: [], custom: '备注内容' },
    ]);
  } finally {
    await teardown();
  }
});

test('回归：/mute 后错误卡与结果卡都被静默（round-2 P2-3）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: 'ok' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    const binding = im.map.get('mock', 'chat-1');

    await im.commandMute({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, true);
    assert.equal(binding.muted, true);

    // 结果卡：此前 handleTurnEnd 不查 muted，照发
    mock.reset();
    im.notify.handleTurnEnd(binding, { reason: { kind: 'completed' }, message: { content: [{ type: 'text', text: 'done' }] } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(mock.sent.length, 0, '/mute 后结果卡必须被静默（此前 handleTurnEnd 不查 muted）');

    // 错误卡：此前 onAgentError 不查 muted，照发
    im.notify.onAgentError({ id: binding.sessionId }, new Error('boom'));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      mock.sent.filter((m) => m.text?.includes('Agent 出错')).length,
      0, '/mute 后错误卡必须被静默',
    );

    // 🔴 状态维护不被 muted 跳过（round-1 P2）：失败标记照常设置/清除，
    // 蓄水池照常清 —— 静默的是通知，不是状态。
    im.notify.handleTurnEnd(binding, { reason: { kind: 'error' }, message: { content: [] } });
    assert.equal(im.lastTurnFailed.get(binding.sessionId), true, '失败 turn 后失败标记应设置（muted 同样生效）');
    im.notify.appendStream(binding, '流式内容');
    im.notify.handleTurnEnd(binding, { reason: { kind: 'completed' }, message: { content: [{ type: 'text', text: 'done' }] } });
    assert.equal(im.lastTurnFailed.get(binding.sessionId), undefined, '成功 turn 后失败标记应清除（muted 同样生效）');
    assert.equal(im.notify.state(binding.sessionId).reservoir, '', 'turn 结束蓄水池必须清空（muted 同样生效）');
    assert.equal(mock.sent.length, 0, '以上 turn 全程未发任何消息（muted）');
  } finally {
    await teardown();
  }
});

test('回归：/retry 只在最近一次任务失败后可用（round-2 P2-6）', async () => {
  const script = [
    {
      chunks: [
        { type: 'text-delta', index: 0, text: 'ok' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    await mock.sendFromUser({ text: '跑一个任务' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('任务完成')), { label: 'result card', timeoutMs: 8000 });
    const binding = im.map.get('mock', 'chat-1');
    assert.ok(im.lastUserTexts.get(binding.sessionId), '应记录最后用户文本');
    assert.equal(im.lastTurnFailed.get(binding.sessionId), undefined, '成功任务后失败标记应未设置');

    // 成功任务后 /retry 必须被拒绝（此前会原样重跑任务，可能重复执行写操作）
    await im.commandRetry({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' });
    assert.ok(
      mock.sent.some((m) => m.text?.includes('没有失败')),
      '成功任务后 /retry 应明确拒绝',
    );

    // 失败 turn 后放行
    im.notify.handleTurnEnd(binding, { reason: { kind: 'error' }, message: { content: [] } });
    assert.equal(im.lastTurnFailed.get(binding.sessionId), true, '失败 turn 后应设置标记');
    const followups = [];
    const agent = im.ctx.agents.get(binding.sessionId);
    const orig = agent.followup.bind(agent);
    agent.followup = (m) => { followups.push(m); return orig(m); };
    await im.commandRetry({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' });
    assert.equal(followups.length, 1, '失败后 /retry 应重新提交任务');
  } finally {
    await teardown();
  }
});

test('回归：quiet hours 内失败 turn 仍设置标记、成功 turn 清除标记（round-1 P2）', async () => {
  const script = [
    { chunks: [ { type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } } ] },
  ];
  const { mock, im, teardown } = await setup(script);
  try {
    await mock.sendFromUser({ text: '跑一个任务' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('任务完成')), { label: 'result card', timeoutMs: 8000 });
    const binding = im.map.get('mock', 'chat-1');

    // 进入静默时段（00:00-24:00 覆盖全天，测试不依赖真实时刻）
    im.notify.quietHours = ['00:00-24:00'];
    assert.ok(im.notify.inQuietHours(), '前置：此刻应在静默时段内');

    // 🔴 静默时段内失败 turn 必须仍设置失败标记（旧版在 markTurnFailed 前就 return 了）
    im.notify.handleTurnEnd(binding, { reason: { kind: 'error' }, message: { content: [] } });
    assert.equal(im.lastTurnFailed.get(binding.sessionId), true, '静默时段内失败 turn 也应设置失败标记');

    // 🔴 静默时段内成功 turn 必须清除标记（旧版不清 ⇒ 标记滞留 ⇒
    // 静默期结束后 /retry 被误放行，可能重放带写操作的任务）
    im.notify.handleTurnEnd(binding, { reason: { kind: 'completed' }, message: { content: [{ type: 'text', text: 'done' }] } });
    assert.equal(im.lastTurnFailed.get(binding.sessionId), undefined, '静默时段内成功 turn 也必须清除失败标记（否则 /retry 被误放行）');
  } finally {
    await teardown();
  }
});

test('回归：/new 创建 agent 失败 → 回滚绑定，不留僵尸会话（round-1 P2）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    // 必须等首个 turn 结束（agent idle）——否则 /new 走"会话仍在运行"早退，测不到目标路径
    await waitFor(() => mock.sent.some((m) => m.text?.includes('任务完成')), { label: 'result card', timeoutMs: 8000 });
    const firstSessionId = im.map.get('mock', 'chat-1').sessionId;

    // 强制下一次 agent 创建失败（模拟 preset 挂载失败）
    const origCreateAgent = im.createAgent.bind(im);
    im.createAgent = async () => { throw new Error('boom: simulated agent init failure'); };
    try {
      await im.commandNew({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' });
    } finally {
      im.createAgent = origCreateAgent;
    }

    // 绑定必须被回滚：不留僵尸绑定（旧绑定已释放、新绑定已回滚）
    assert.ok(!im.map.get('mock', 'chat-1'), '/new 失败时绑定必须回滚（不留僵尸会话）');
    // 明确失败通知
    assert.ok(mock.sent.some((m) => m.text?.includes('新会话创建失败')), '应明确通知创建失败');

    // 状态一致：用户可再次 /new 成功
    mock.reset();
    await im.commandNew({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' });
    const newBinding = im.map.get('mock', 'chat-1');
    assert.ok(newBinding?.sessionId, '/new 失败后再次 /new 应成功');
    assert.notEqual(newBinding.sessionId, firstSessionId, '新会话应是新的 id');
  } finally {
    await teardown();
  }
});

test('回归：autoCreate 首条消息 agent 创建失败 → 回滚绑定 + 回执（round-2 P2）', async () => {
  // MOCK_CFG.autoCreate=true：新聊天首条授权消息自动建会话（/new 的 P2-4 同类路径）
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    const origCreateAgent = im.createAgent.bind(im);
    im.createAgent = async () => { throw new Error('boom: simulated agent init failure'); };
    try {
      await mock.sendFromUser({ text: '跑一个任务' });
    } finally {
      im.createAgent = origCreateAgent;
    }

    // 🔴 僵尸绑定必须回滚（旧版：binding 已落盘、异常裸抛、任务静默丢失、
    // 且僵尸占用 maxSessions 额度）
    assert.ok(!im.map.get('mock', 'chat-1'), 'autoCreate 首条消息失败后绑定必须回滚（不留僵尸会话）');
    // 明确失败回执（任务未执行）
    assert.ok(mock.sent.some((m) => m.text?.includes('会话创建失败')), '应告知用户任务未执行');

    // 状态一致：用户重发同一条消息即可成功
    mock.reset();
    await mock.sendFromUser({ text: '再跑一次' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('任务完成')), { label: 'retry result card', timeoutMs: 8000 });
    assert.ok(im.map.get('mock', 'chat-1')?.sessionId, '重试成功后会话应建立');
  } finally {
    await teardown();
  }
});

test('回归：并发替换后 dispatchTask 失败回滚不得误删他人绑定（round-3 P2 身份校验）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    const origCreateAgent = im.createAgent.bind(im);
    im.createAgent = async () => {
      // 模拟并发 /new：createAgent 的 await 期间绑定被替换成别的会话
      im.map.remove('mock', 'chat-1');
      im.map.create('mock', 'chat-1', { chatType: 'private', sessionId: 'im-mock-concurrent' });
      throw new Error('boom: simulated agent init failure');
    };
    try {
      await mock.sendFromUser({ text: '跑一个任务' });
    } finally {
      im.createAgent = origCreateAgent;
    }

    // 🔴 旧版按 key 盲删：会把并发 /new 刚建的绑定删掉（运行中的 agent 失去映射）。
    // 现在回滚带身份校验（sessionId 匹配才删）。
    assert.equal(
      im.map.get('mock', 'chat-1')?.sessionId,
      'im-mock-concurrent',
      '失败回滚不得误删并发替换进来的绑定（身份校验）',
    );
    assert.ok(mock.sent.some((m) => m.text?.includes('会话创建失败')), '仍应发失败回执');
  } finally {
    await teardown();
  }
});

test('回归：并发替换后 /new 失败回滚不得误删他人绑定（round-3 P2 身份校验）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('任务完成')), { label: 'result card', timeoutMs: 8000 });

    const origCreateAgent = im.createAgent.bind(im);
    im.createAgent = async () => {
      // 模拟并发消息：/new 新绑定创建后、createAgent 期间被替换
      im.map.remove('mock', 'chat-1');
      im.map.create('mock', 'chat-1', { chatType: 'private', sessionId: 'im-mock-concurrent2' });
      throw new Error('boom: simulated agent init failure');
    };
    try {
      await im.commandNew({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' });
    } finally {
      im.createAgent = origCreateAgent;
    }

    assert.equal(
      im.map.get('mock', 'chat-1')?.sessionId,
      'im-mock-concurrent2',
      '/new 失败回滚不得误删并发替换进来的绑定（身份校验）',
    );
    assert.ok(mock.sent.some((m) => m.text?.includes('新会话创建失败')), '仍应发失败回执');
  } finally {
    await teardown();
  }
});

test('回归：多题卡分次手打编号——合法部分答案回执"已记录"且可续答（round-6 F1）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '环境？', options: [{ label: 'staging' }, { label: 'production' }] },
      { id: 'q2', question: '备份？', options: [{ label: '要' }, { label: '不要' }] },
    ]);
    mock.reset();
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '1.1']);

    // 旧版：合法 pick 已进草稿却回执"编号越界"（状态与回执矛盾，用户以为被拒）
    assert.ok(mock.sent.some((m) => m.text?.includes('已记录选择')), '合法部分答案应回执"已记录选择"');
    assert.ok(mock.sent.some((m) => m.text?.includes('1/2 题')), '回执应给出已答题数（1/2）');
    assert.ok(!mock.sent.some((m) => m.text?.includes('编号越界')), '合法部分答案不得报"编号越界"');
    assert.equal(im.userQuestions.records.size, 1, '提问仍在等待（未提前结题）');

    mock.reset();
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, '2.2']);
    const ans = await p;
    assert.deepEqual(ans.answers, [
      { id: 'q1', selected: ['staging'] },
      { id: 'q2', selected: ['不要'] },
    ], '分次手打的选择必须都进入最终答案');
  } finally {
    await teardown();
  }
});

test('回归：多选按钮回执必须插值真实提问 ID（round-7 F03）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '选几个？', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true },
    ]);
    mock.reset();
    await im.handleCallback({ platform: 'mock', chatId: 'chat-1', userId: 'user-1', data: `q:${qid}:0:0` });

    const m = mock.sent.find((x) => x.text?.includes('已记录'));
    assert.ok(m, '按钮点击应有回执');
    assert.ok(!m.text.includes('${qid}'), '回执不得含未插值的 ${qid} 字面量（照抄会得到无效命令）');
    assert.ok(m.text.includes(`/answer ${qid} done`), '回执的提交命令必须含真实提问 ID');
    // 注意：多选卡停在等待 done 状态，p 不会 resolve——不得 await（teardown 清理）
  } finally {
    await teardown();
  }
});

test('回归：multiSelect 文字卡直接回复的回执提示 done（round-7 F05）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });

    const { p, qid } = await pushQuestion(im, [
      { id: 'q1', question: '叫什么名字？', multiSelect: true }, // 文字题 + multiSelect（特殊组合）
    ]);
    mock.reset();
    await mock.sendFromUser({ text: '张三' });

    const m = mock.sent.find((x) => x.text?.includes('已记录'));
    assert.ok(m, '直接文字回复应有回执');
    assert.ok(m.text.includes(`/answer ${qid} done`), '含 multiSelect 的回执必须提示 done（否则用户卡在无入口状态）');
    assert.equal(im.userQuestions.records.size, 1, 'multiSelect 卡不得自动结题');

    mock.reset();
    await im.commandAnswer({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, [qid, 'done']);
    const ans = await p;
    assert.ok(JSON.stringify(ans).includes('张三'), '文字答案必须经 done 提交');
  } finally {
    await teardown();
  }
});

test('回归：/new 双击合并处理（同聊天串行化，round-4 P2-2）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('任务完成')), { label: 'result card', timeoutMs: 8000 });

    // 放慢 disposeAgent，强制两个并发 /new 交错（旧版：后者 map.remove 误删前者的新绑定）
    const origDispose = im.disposeAgent.bind(im);
    let slowed = false;
    im.disposeAgent = async (sid) => {
      if (!slowed) { slowed = true; await new Promise((r) => setTimeout(r, 50)); }
      return origDispose(sid);
    };
    // 计数 createAgent：双击不得建两个 agent
    let creates = 0;
    const origCreate = im.createAgent.bind(im);
    im.createAgent = async (...args) => { creates++; return origCreate(...args); };
    try {
      await Promise.all([
        im.commandNew({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }),
        im.commandNew({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }),
      ]);
    } finally {
      im.disposeAgent = origDispose;
      im.createAgent = origCreate;
    }

    const b = im.map.get('mock', 'chat-1');
    assert.ok(b?.sessionId, '会话应建立');
    assert.equal(creates, 1, '双击 /new 只允许创建一个 agent（并发 /new 必须合并）');
    assert.equal(mock.sent.filter((m) => m.text?.includes('新会话已创建')).length, 2, '两个 /new 都应收到回执');
    assert.ok(mock.sent.some((m) => m.text?.includes('合并处理')), '第二个 /new 应说明合并处理');
  } finally {
    await teardown();
  }
});

test('回归：freshSessionId 快速连发不碰撞（round-4 P2-3）', async () => {
  const { im, teardown } = await setup(QSCRIPT);
  try {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(im.freshSessionId('mock', 'chat-1'));
    assert.equal(ids.size, 100, 'freshSessionId 同毫秒快速连发不得碰撞（时间戳+随机后缀）');
  } finally {
    await teardown();
  }
});

test('回归：/log 宣布段数 = 实际段数，无二次切分（round-2 P2-5）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    const binding = im.map.get('mock', 'chat-1');

    // 6546 字节输出（round-n1 实测样例量级）；给 mock 渠道临时声明 3000 字节上限
    mock.maxMessageBytes = 3000;
    const full = 'x'.repeat(6546);
    im._lastFullOutput.set(binding.sessionId, full);

    mock.reset();
    await im.commandLog({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' });
    // 等待所有分段发送完毕（无 sendFile 渠道 → 文本分段路径）
    await waitFor(() => {
      const body = mock.sent.filter((m) => m.text?.startsWith('('));
      const announced = mock.sent.find((m) => m.text?.includes('完整输出共'));
      const n = announced ? Number(announced.text.match(/共 (\d+) 段/)?.[1]) : 0;
      return n > 0 && body.length === n;
    }, { label: 'all segments sent', timeoutMs: 8000 });

    const announced = mock.sent.find((m) => m.text?.includes('完整输出共'));
    const n = Number(announced.text.match(/共 (\d+) 段/)[1]);
    const body = mock.sent.filter((m) => m.text?.startsWith('('));
    assert.equal(body.length, n, `宣布 ${n} 段，实发 ${body.length} 段（此前双重切分会 2N+1）`);
    // 拼回必须无损
    const joined = body.map((m) => m.text.replace(/^\(\d+\/\d+\) /, '')).join('');
    assert.equal(joined, full, '分段拼回必须等于原文');
    // 不再出现"回复 /log 取全文"的二次截断提示（round-n1 F15 回归）
    assert.ok(
      !mock.sent.some((m) => m.text?.includes('获取全文') && m.text?.includes('/log')),
      '不得再提示用户用 /log 取全文（/log 自己就是全文路径）',
    );
  } finally {
    delete mock.maxMessageBytes;
    await teardown();
  }
});

test('回归：/new 继承聊天级 /mute（round-2 P2-10）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    await im.commandMute({ platform: 'mock', chatId: 'chat-1', userId: 'user-1' }, true);
    assert.equal(im.map.get('mock', 'chat-1').muted, true);

    // /new 重建绑定：此前 muted 字段随旧绑定丢失，通知立刻恢复
    await mock.sendFromUser({ text: '/new' });
    await waitFor(() => mock.sent.some((m) => m.text?.includes('新会话已创建')), { label: '/new reply' });
    const fresh = im.map.get('mock', 'chat-1');
    assert.equal(fresh.muted, true, '/new 后聊天级 muted 必须保留');
  } finally {
    await teardown();
  }
});

test('回归：lastSeen 有界淘汰（round-2 P2-7）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    // 直接灌 510 个不同 chatId 的未授权消息：lastSeen 必须被压回上限
    for (let i = 0; i < 510; i++) {
      await mock.sendFromUser({
        chatId: `spike-${i}`, userId: `spike-${i}`, userName: 'S', text: 'hi',
      });
    }
    assert.ok(im.lastSeen.size <= 500, `lastSeen 超上限未淘汰：size=${im.lastSeen.size}`);
    // 最近发言的 chat 仍在表里（淘汰的是最旧）
    assert.ok(im.lastSeen.has(`mock:spike-509`), '最近聊天不得被淘汰');
  } finally {
    await teardown();
  }
});

test('回归：流式蓄水池有界（round-2 P2-8）', async () => {
  const { mock, im, teardown } = await setup(QSCRIPT);
  try {
    await mock.sendFromUser({ text: '你好' });
    await waitFor(() => im.map.get('mock', 'chat-1')?.sessionId, { label: 'binding', timeoutMs: 8000 });
    const binding = im.map.get('mock', 'chat-1');
    // 人离线 → 只蓄水不推送；灌 300KB 增量
    const st = im.notify.state(binding.sessionId);
    for (let i = 0; i < 300; i++) im.notify.appendStream(binding, 'z'.repeat(1024));
    assert.ok(st.reservoir.length <= 256 * 1024, `蓄水池超限：${st.reservoir.length}`);
  } finally {
    await teardown();
  }
});

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
