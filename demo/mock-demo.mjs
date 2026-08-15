// dsh-im-bridge 现场演示
//
// 组合：真实 DSH agent loop（dsh-agent-loop-testkit）+ dsh-user-approval
//      + dsh-im 核心 + MockChannel
//
// 用法：
//   node demo/mock-demo.mjs            # 交互模式：脚本化 demo LLM（无需任何 key）
//   node demo/mock-demo.mjs --auto     # 自动演示完整流程（demo LLM）
//   DEEPSEEK_API_KEY=sk-xxx node demo/mock-demo.mjs --real
//                                     # 真实模式：真实 DeepSeek 模型 + 真实 shell 工具
//                                     # （工作区隔离在临时目录，危险命令受审批门保护）
//
// 交互命令：
//   !approve <id>   批准审批（等价于点卡片按钮）
//   !reject <id>    拒绝审批
//   !sent           重看所有 bot 消息
//   !quit / Ctrl+C  退出

import { createRequire } from 'node:module';
import readline from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const require = createRequire(import.meta.url);
const { Context } = await import('@deepseek-ai/cordis');
const { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit');
const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
const { default: ApprovalService } = await import('@deepseek-ai/dsh-user-approval');
const { LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { defineContentToolFixture } = await import('@deepseek-ai/dsh-tools');
const { default: ImRuntime } = await import('../packages/im/lib/index.js');
const { MockChannel } = await import('../packages/im/lib/mock-channel.js');

const AUTO = process.argv.includes('--auto');
const REAL = process.argv.includes('--real');
const AUTO_APPROVE = process.argv.includes('--auto-approve');
if (REAL && AUTO) {
  console.error('真实模式只支持交互（--real 与 --auto 不能同时用；真实模型每次调用都要花钱）。');
  process.exit(1);
}
if (REAL && !process.env.DEEPSEEK_API_KEY) {
  console.error('真实模式需要 DEEPSEEK_API_KEY 环境变量。');
  process.exit(1);
}
const emoji = { platform: 'mock', icon: '📡' };

// ── demo LLM：规则化「agent」───────────────────────────────────────────────
// 用户消息含危险词 → 请求 demo-danger 工具（触发审批）；否则直接输出结果。
// 收到工具结果（已批准/已拒绝）→ 生成最终回复。
class DemoAdapter extends LlmAdapter {
  constructor() {
    super();
    this.turns = 0;
  }
  async *stream(options) {
    this.turns++;
    // 找真正的用户消息（IM 派活），跳过 runtime-context 等合成注入
    const userMsg = [...options.messages].reverse().find((m) => m.role === 'user' && m.source?.kind === 'user');
    const last = options.messages.at(-1);
    const text = extractText(userMsg ?? last);
    const hasToolResult = options.messages.some((m) => m.source?.kind === 'tool');
    if (hasToolResult) {
      // 审批会注入 runtime-context 快照，工具结果消息不一定在最后，需全量找
      const toolMsg = [...options.messages].reverse().find((m) => m.content?.some((b) => b.type === 'tool-result'));
      const toolBlock = toolMsg?.content.find((b) => b.type === 'tool-result');
      const isError = toolBlock?.isError === true;
      if (isError) {
        yield* textChunks('⛔ 用户拒绝了该危险操作，我没有执行。任务已安全结束。');
      } else {
        const detail = extractText(toolBlock ?? { content: [] }).slice(0, 120) || '（无输出）';
        yield* textChunks(`✅ 危险操作已批准并执行完成。\n结果：${detail}`);
      }
      yield { type: 'usage', usage: { inputTokens: 150 + this.turns * 10, outputTokens: 24 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (/rm -rf|危险|删除|危险操作/.test(text)) {
      yield { type: 'tool-call-delta', index: 0, id: `demo-call-${this.turns}`, name: 'demo-danger', argumentsDelta: JSON.stringify({ command: text.slice(0, 80) }) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield* textChunks(`✅ 收到任务：「${text.slice(0, 60)}」\n（demo 模式：已模拟执行完成，这是一条流式增量输出——按段落逐条发到 IM）`);
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 18 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function* textChunks(text) {
  const parts = text.split('\n').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    await new Promise((r) => setTimeout(r, 200)); // 模拟真实模型流式节奏
    yield { type: 'text-delta', index: 0, text: parts[i] + (i < parts.length - 1 ? '\n' : '') };
  }
}

function extractText(message) {
  const blocks = message?.content ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

// ── 启动组合 ────────────────────────────────────────────────────────────────
const ctx = new Context();
await mountAgentLoopTestDependencies(ctx);
ctx.plugin(ApprovalService, { policy: 'ask' });
ctx.plugin(AgentLoop, { agents: [] });

// 真实模式：工作区隔离在临时目录（agent 的 shell 只在这个目录里操作）
const workspace = mkdtempSync(join(tmpdir(), 'dsh-im-demo-ws-'));
let riskRules;
if (REAL) {
  const deepseekMod = await import('@deepseek-ai/dsh-llm-deepseek');
  ctx.plugin(deepseekMod, {}); // {name, inject, Config, apply}
  // 真实 shell 工具：在演示工作区执行命令（受审批门保护）
  ctx.get('tools').register(defineContentToolFixture({
    name: 'demo-shell',
    description: '在演示工作区（临时目录）执行 shell 命令，返回 stdout/stderr 与退出码。危险命令（删除、curl|sh、sudo 等）需要用户远程审批。',
    parameters: { command: { type: 'string' } },
    async execute(args, exec) {
      const cmd = String(args.command ?? '');
      try {
        const { stdout, stderr } = await execFileP('/bin/bash', ['-c', cmd], {
          cwd: workspace,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          signal: exec.signal,
        });
        const out = [stdout && `$ ${cmd}\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n').slice(0, 6000);
        return [{ type: 'text', text: out || '(无输出)' }];
      } catch (err) {
        const detail = String(err?.stdout ?? '') + String(err?.stderr ?? '') + (err?.message ?? '');
        return [{ type: 'text', text: `❌ 命令失败（exit ${err?.code ?? '?'}）：\n${detail.slice(0, 3000)}` }];
      }
    },
  }));
  // 审批规则：复用核心默认风险规则套用到 demo-shell；
  // 过滤空 args 的 catch-all 规则（避免 ls 这类常规命令也弹审批，防审批疲劳 FR-6.6）
  const { defaultRiskRules } = await import('../packages/im/lib/risk.js');
  riskRules = defaultRiskRules().filter((r) => r.args).map((r) => ({ ...r, tool: 'demo-shell' }));
} else {
  const adapter = new DemoAdapter();
  ctx.get('llm').registerAdapter(['demo-llm'], adapter);
  ctx.get('tools').register(defineContentToolFixture({
    name: 'demo-danger',
    description: '危险的 demo 工具（删除/危险操作会触发远程审批）',
    parameters: { command: { type: 'string' } },
    execute: async (args) => [{ type: 'text', text: `demo-danger 执行了: ${args.command}` }],
  }));
  riskRules = [{ tool: 'demo-danger', args: '', risk: 'high' }];
}

const imHandle = ctx.plugin(ImRuntime, {
  security: {
    allowlist: ['mock:user-1'],
    admins: ['mock:user-1'],
    autoCreate: true,
    maxSessions: 10,
    trustOnFirstContact: false,
  },
  approvals: {
    enabled: true,
    timeoutSec: 120,
    pendingMaxSec: 600,
    autoApproveRisk: 'none',
    riskRules,
  },
  notifications: {
    onTurnEnd: true,
    onError: true,
    includeCost: true,
    pricing: { inputPerM: 0, outputPerM: 0 },
    streamWhileOnline: true, // 开启流式增量演示（在线分流 FR-5.5）
    onlineWindowMin: 10,
    flushIntervalMs: 250,
  },
  agent: REAL
    ? { provider: 'deepseek-official', model: 'deepseek-v4-flash', workspace }
    : { provider: 'demo-llm', model: 'demo-model', workspace },
  storeDir: mkdtempSync(join(tmpdir(), 'dsh-im-demo-')),
});
await imHandle.await();
const im = ctx.get('im');
await im.whenReady();
const mock = new MockChannel({ platform: 'mock', displayName: 'Mock IM' });
im.registerChannel(mock);

// ── 输出：打印新到的 bot 消息 ──────────────────────────────────────────────
let printed = 0;
function printNew() {
  while (printed < mock.sent.length) {
    const m = mock.sent[printed++];
    const time = new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false });
    const head = `\n${emoji.icon} [${time}] bot → ${m.chatId}`;
    const text = m.text ? `\n${m.text}` : '';
    const buttons = m.buttons?.length
      ? `\n` + m.buttons.map((b) => `   [${b.label}]`).join('  ') + `\n   👉 输入 !approve <id> 或 !reject <id>`
      : '';
    console.log(`${head}${text}${buttons}`);
  }
}

const tick = setInterval(printNew, 80);

// --auto-approve：自动批准审批卡片（真实模式脚本化演示用）
let autoApproved = new Set();
if (AUTO_APPROVE) {
  setInterval(() => {
    for (const m of mock.sent) {
      const btn = m.buttons?.find((b) => b.id.startsWith('approve:'));
      if (!btn) continue;
      const id = btn.id.split(':')[1];
      if (autoApproved.has(id)) continue;
      autoApproved.add(id);
      console.log(`\n🤖 [auto-approve] 自动批准审批 ${id}`);
      void mock.pressButton(`approve:${id}:yes`, { chatId: 'c1', userId: 'user-1' });
    }
  }, 300);
}

/** 等 agent 收尾（真实模式长任务需要）。 */
async function drainAgent(timeoutMs = 150_000) {
  const agent = ctx.get('agents').get('im-mock-c1');
  if (!agent) return;
  try {
    await Promise.race([agent.whenIdle(), new Promise((r) => setTimeout(r, timeoutMs))]);
  } catch { /* 忽略 */ }
  printNew();
}

// ── 交互 ────────────────────────────────────────────────────────────────────
async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n' + '='.repeat(60));
  console.log(REAL
    ? '  dsh-im-bridge 演示（真实 DeepSeek 模型 + 真实 shell 工具）'
    : '  dsh-im-bridge 演示（MockChannel + demo LLM）');
  console.log('  输入消息指挥 agent；!approve <id> / !reject <id> 审批；!quit 退出');
  if (REAL) {
    console.log('  工作区：' + workspace);
    console.log('  试试：/new → "列出当前目录" → "写一个 hello.py 并运行" → "rm -rf 删除所有文件"');
  }
  console.log('='.repeat(60));
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '!quit' || line === '!exit') break;
    if (line === '!sent') {
      printNew();
      continue;
    }
    const m = line.match(/^!(approve|reject)\s+(\S+)(?:\s+(yes|no))?/);
    if (m) {
      const id = m[2];
      const answer = m[3] ?? (m[1] === 'approve' ? 'yes' : 'no');
      await mock.pressButton(`approve:${id}:${answer}`, { chatId: 'c1', userId: 'user-1' });
      continue;
    }
    await mock.sendFromUser({ chatId: 'c1', userId: 'user-1', userName: '演示员', text: line });
    await new Promise((r) => setTimeout(r, 200)); // 让输入流有机会让位给 bot 输出
  }
  await drainAgent();
  rl.close();
  await shutdown();
  process.exit(0);
}

async function autoDemo() {
  console.log('\n' + '='.repeat(60));
  console.log('  dsh-im-bridge 自动演示（真实 agent loop + 模拟 LLM + MockChannel）');
  console.log('='.repeat(60));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = async (text, gap = 1200) => {
    printNew();
    await sleep(400);
    console.log(`\n👤 演示员 > ${text}`);
    await mock.sendFromUser({ chatId: 'c1', userId: 'user-1', userName: '演示员', text });
    await sleep(gap);
  };
  await send('/new', 900);
  await send('跑一下 tests 目录的 pytest', 1500);
  await send('删除 ~/Downloads 里的构建产物（危险操作）', 1500);
  printNew();
  // 找到待审批卡片并批准
  const card = mock.sent.findLast((m) => m.buttons?.some((b) => b.id.startsWith('approve:')));
  if (card) {
    const approveId = card.buttons.find((b) => b.id.startsWith('approve:')).id.split(':')[1];
    console.log(`\n👆 审批卡片到达 —— 演示员点【✅ 批准】（approve:${approveId}）`);
    await mock.pressButton(`approve:${approveId}:yes`, { chatId: 'c1', userId: 'user-1' });
    await sleep(1800);
  }
  await send('/status', 1200);
  await send('/log', 1200);
  printNew();
  await sleep(500);
  await shutdown();
  console.log('\n演示结束。想亲自指挥？去掉 --auto 再跑一次：node demo/mock-demo.mjs\n');
  process.exit(0);
}

async function shutdown() {
  clearInterval(tick);
  try {
    await imHandle.dispose();
  } catch { /* 忽略 */ }
}

process.on('SIGINT', async () => { await shutdown(); process.exit(130); });

if (AUTO) await autoDemo();
else await interactive();
