// 桥核心（demo 运行器共用）：组合真实 agent loop + LLM + 工作区工具 + dsh-im 核心
//
// 飞书/企微等渠道运行器都通过它启动同一套核心，再各自注册自己的渠道插件：
//
//   const core = await bootBridge({ mode: 'demo', mockLLM: false });
//   ctx.plugin(ImFeishu, {...});   // 渠道插件用自己的 ctx（core.ctx）
//
// 配置统一从环境变量读取（运行器不用重复解析）：
//   IM_ALLOWLIST / IM_ADMINS      逗号分隔用户键（prod 必填，否则拒绝启动）
//   IM_POLICY_ROOTS               写免审批根目录（逗号分隔；默认 ~/Downloads/im-workspace）
//   IM_POLICY_DENY                硬拒绝路径正则（逗号分隔，可选）
//   WORKSPACE_DIR                 设置后退回"受限工作区"模式
//
// 权限模型（demo/policy.js）：读任意目录放行；写/编辑在工作根内免审批、之外要审批。

import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, join as pathJoin } from 'node:path';

import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const { Context } = await import('@deepseek-ai/cordis');
const { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit');
const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
const { default: ApprovalService } = await import('@deepseek-ai/dsh-user-approval');
const { default: ImRuntime } = await import('../packages/im/lib/index.js');

/** demo LLM（mockLLM=true 时用，不花钱）。 */
class EchoAdapter extends LlmAdapter {
  async *stream(options) {
    const userMsg = [...options.messages].reverse().find((m) => m.role === 'user' && m.source?.kind === 'user');
    const text = userMsg?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
    const parts = `✅ 收到任务：「${text.slice(0, 50)}」（demo LLM 模式）`.split('\n');
    for (let i = 0; i < parts.length; i++) {
      yield { type: 'text-delta', index: 0, text: parts[i] + (i < parts.length - 1 ? '\n' : '') };
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function csv(name) {
  return (process.env[name] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 启动桥核心（配置从环境变量读取）。
 * @param {object} opts
 * @param {'demo'|'prod'} opts.mode
 * @param {boolean} opts.mockLLM  用 demo LLM（prod 禁止）
 * @param {boolean} opts.allowShell 挂裸 shell（prod 禁止；本机无沙箱，默认不要开）
 * @returns {Promise<{ctx, im, workRoot, restricted, mode, dispose}>}
 */
export async function bootBridge({ mode = 'demo', mockLLM = false, allowShell = false } = {}) {
  const allowlist = csv('IM_ALLOWLIST');
  const admins = csv('IM_ADMINS');
  if (mode === 'prod') {
    if (mockLLM) throw new Error('--mock-llm is forbidden in prod mode | prod 模式禁止 --mock-llm');
    if (allowShell) throw new Error('--allow-shell is forbidden in prod mode (no sandbox backend on this host) | prod 模式禁止 --allow-shell（本机无沙箱后端）');
    if (allowlist.length === 0 || admins.length === 0) {
      throw new Error('prod mode requires IM_ALLOWLIST and IM_ADMINS (comma-separated feishu:<open_id> / wecom:<userid>). Deny-all is the safe default (PRD §10) | prod 模式必须配置 IM_ALLOWLIST 和 IM_ADMINS（逗号分隔的 feishu:<open_id> / wecom:<userid>）——默认全禁才是安全默认（PRD §10）');
    }
  }

  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  ctx.plugin(ApprovalService, { policy: 'ask' });
  const loopHandle = ctx.plugin(AgentLoop, { agents: [] });
  await loopHandle.await();

  const restricted = !!process.env.WORKSPACE_DIR;
  const workRoot = process.env.WORKSPACE_DIR
    ? pathJoin(process.env.WORKSPACE_DIR)
    : pathJoin(homedir(), 'Downloads', 'im-workspace');
  let riskRules = [];
  let agentOptions = {};

  if (mockLLM) {
    ctx.get('llm').registerAdapter(['demo-llm'], new EchoAdapter());
    agentOptions = { provider: 'demo-llm', model: 'demo-model', workspace: workRoot };
  } else {
    const deepseekMod = await import('@deepseek-ai/dsh-llm-deepseek');
    ctx.plugin(deepseekMod, {});
    agentOptions = { provider: 'deepseek-official', model: 'deepseek-v4-flash', workspace: workRoot };
    const { registerWorkspaceTools, registerOpenFileTools } = await import('./workspace-tools.mjs');
    const { PathPolicy } = await import('./policy.js');
    if (restricted) {
      riskRules = await registerWorkspaceTools(ctx, workRoot, { allowShell });
      console.log(`工作区（受限模式）：${workRoot}`);
    } else {
      const roots = csv('IM_POLICY_ROOTS');
      if (!roots.length) roots.push(workRoot);
      const deny = csv('IM_POLICY_DENY').map((x) => new RegExp(x));
      const policy = new PathPolicy({ writeRoots: roots, deny });
      riskRules = await registerOpenFileTools(ctx, { policy, allowShell });
      console.log('权限模型：读任意目录放行；写/编辑在【工作根】内免审批，之外需审批');
      console.log(`  工作根：${roots.join(', ')}（可用 IM_POLICY_ROOTS 配置）`);
      if (deny.length) console.log(`  黑名单 deny：${process.env.IM_POLICY_DENY}`);
    }
  }

  const imHandle = ctx.plugin(ImRuntime, {
    security: {
      allowlist,
      admins,
      autoCreate: true,
      maxSessions: 10,
      trustOnFirstContact: mode === 'demo', // 演示才自动信任
    },
    approvals: {
      enabled: true,
      timeoutSec: 300,
      pendingMaxSec: 3600,
      autoApproveRisk: 'none',
      riskRules,
    },
    notifications: {
      onTurnEnd: true,
      onError: true,
      includeCost: true,
      pricing: { inputPerM: 0, outputPerM: 0 },
      streamWhileOnline: true,
      onlineWindowMin: 10,
      flushIntervalMs: 300,
    },
    agent: agentOptions,
    storeDir: mode === 'prod'
      ? pathJoin(homedir(), '.dsh', 'dsh-im')
      : mkdtempSync(join(tmpdir(), 'dsh-im-demo-')),
  });
  await imHandle.await();
  const im = ctx.get('im');
  await im.whenReady();

  return {
    ctx,
    im,
    workRoot,
    restricted,
    mode,
    dispose: async () => {
      try { await imHandle.dispose(); } catch { /* 忽略 */ }
    },
  };
}
