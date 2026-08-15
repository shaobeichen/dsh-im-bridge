// 工作区/开放文件工具（真实模式用）
//
// 权限模型（配合 demo/policy.js）：
//   - 工具内部对【解析后的绝对路径】执行 PathPolicy 判定（L2 路径层）
//   - 需要审批的操作在工具内走官方 approval seam → IM 审批卡片（L3 审批层）
//   - deny → 硬拒绝（不给审批机会）；ask → 审批；allow → 放行
//   - 写/编辑一律 ask；读敏感路径 ask；读普通路径 allow
//
// ⚠️ shell 默认不提供：本机无可用沙箱后端（macOS sandbox-exec 被禁）。
// 显式 allowShell: true 才挂 demo-shell（裸 shell 以用户权限运行，
// 审批门只兜底危险命令——开放模式下强烈不建议开）。

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PathPolicy } from './policy.js';

const execFileP = promisify(execFile);

/** 把用户给的路径解析到工作区内；越界抛错（受限模式用）。 */
export function resolveInWorkspace(workspace, p) {
  const abs = resolve(workspace, String(p ?? '.'));
  const rel = relative(workspace, abs);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`路径超出工作区：${p}`);
  }
  return abs;
}

/**
 * 工具内审批门：deny → 抛错；ask → 走 approval seam（IM 审批卡片）。
 * @returns 通过则返回；否则 throw。
 */
async function gate(ctx, exec, policy, absPath, op, toolName) {
  const c = policy.classify(absPath, { op });
  if (c.action === 'deny') throw new Error(`策略拒绝：${c.reason}`);
  if (c.action === 'ask') {
    const approval = ctx.get('approval');
    if (!approval) throw new Error(`策略要求审批，但审批服务不可用：${c.reason}`);
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason: c.reason,
      signal: exec.signal,
    });
    if (outcome !== 'allowed-once') {
      throw new Error(`操作被拒绝（${outcome}）：${c.reason}`);
    }
  }
}

function buildFileTools(ctx, policy, { hint }) {
  return [
    {
      name: 'list_dir',
      description: `列出某个目录的内容（含子目录）。${hint} 参数 path 为目录路径，如 '.' 或 '/Users/you/project/src'。`,
      parameters: { path: { type: 'string' } },
      async execute(args, exec) {
        const dir = policy.resolve(args.path ?? '.');
        await gate(ctx, exec, policy, dir, 'read', 'list_dir');
        const entries = await readdir(dir, { withFileTypes: true });
        const rows = [];
        for (const e of entries) {
          const st = await stat(join(dir, e.name)).catch(() => null);
          rows.push(`${e.isDirectory() ? '📁' : '📄'} ${e.name}${st ? ` (${st.size}B)` : ''}`);
        }
        return [{ type: 'text', text: rows.join('\n') || '(空目录)' }];
      },
    },
    {
      name: 'read_file',
      description: `读取一个文本文件的内容（UTF-8）。${hint} 参数 path 为文件路径（绝对路径或相对路径）。`,
      parameters: { path: { type: 'string' } },
      async execute(args, exec) {
        const file = policy.resolve(args.path);
        await gate(ctx, exec, policy, file, 'read', 'read_file');
        const text = await readFile(file, 'utf8');
        return [{ type: 'text', text: `【${file}】\n${text.slice(0, 8000)}${text.length > 8000 ? '\n…（已截断）' : ''}` }];
      },
    },
    {
      name: 'write_file',
      description: `创建/覆盖一个文件（UTF-8），会先创建父目录。${hint} 参数 path 为文件路径。写入前会请求审批。`,
      parameters: { path: { type: 'string' }, content: { type: 'string' } },
      async execute(args, exec) {
        const file = policy.resolve(args.path);
        await gate(ctx, exec, policy, file, 'write', 'write_file');
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, String(args.content ?? ''), 'utf8');
        return [{ type: 'text', text: `✅ 已写入 ${file}（${String(args.content ?? '').length} 字符）` }];
      },
    },
    {
      name: 'edit_file',
      description: `替换一个文件中的文本（精确匹配，替换所有出现）。适合改代码。${hint} 参数 path 为文件路径。编辑前会请求审批。`,
      parameters: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } },
      async execute(args, exec) {
        const file = policy.resolve(args.path);
        await gate(ctx, exec, policy, file, 'write', 'edit_file');
        const text = await readFile(file, 'utf8');
        if (!String(args.find)) throw new Error('find 不能为空');
        const count = text.split(String(args.find)).length - 1;
        if (count === 0) throw new Error(`未找到要替换的文本：${String(args.find).slice(0, 50)}`);
        const next = text.split(String(args.find)).join(String(args.replace ?? ''));
        await writeFile(file, next, 'utf8');
        return [{ type: 'text', text: `✅ 已替换 ${count} 处：${file}` }];
      },
    },
  ];
}

function buildShellTool({ workspace }) {
  return {
    name: 'demo-shell',
    description: `在工作区根执行 shell 命令，返回 stdout/stderr 与退出码。⚠️ 裸 shell：以你的用户权限运行，能读取你电脑上的文件。当前目录：${workspace}。危险命令（rm -rf、curl|sh、sudo 等）需要用户远程审批。`,
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
  };
}

/** 受限模式：所有文件操作限制在 workspace 内（roots=[workspace]）。 */
export function registerWorkspaceTools(ctx, workspace, { allowShell = false } = {}) {
  return import('@deepseek-ai/dsh-tools').then(async ({ defineContentToolFixture }) => {
    const policy = new PathPolicy({ writeRoots: [workspace], baseDir: workspace });
    const tools = buildFileTools(ctx, policy, { hint: `工作区根：${workspace}。` });
    if (allowShell) tools.push(buildShellTool({ workspace }));
    for (const t of tools) ctx.get('tools').register(defineContentToolFixture(t));

    const rules = [];
    if (allowShell) {
      const { defaultRiskRules } = await import('../packages/im/lib/risk.js');
      rules.push(...defaultRiskRules().filter((r) => r.args).map((r) => ({ ...r, tool: 'demo-shell' })));
    }
    return rules; // 文件工具的审批由工具内 policy 处理，不再走通用风险规则
  });
}

/**
 * 开放模式：任意文件夹。
 * @param {object} opts
 * @param {PathPolicy} opts.policy  路径策略（roots/sensitive/deny）
 * @param {boolean}   opts.allowShell
 */
export function registerOpenFileTools(ctx, { policy, allowShell = false } = {}) {
  return import('@deepseek-ai/dsh-tools').then(async ({ defineContentToolFixture }) => {
    const pol = policy ?? new PathPolicy({});
    const hint = '可访问任意文件夹（相对路径基于主目录，绝对路径直接用）；敏感文件与写入/编辑会请求审批。';
    const tools = buildFileTools(ctx, pol, { hint });
    if (allowShell) tools.push(buildShellTool({ workspace: pol.baseDir }));
    for (const t of tools) ctx.get('tools').register(defineContentToolFixture(t));

    const rules = [];
    if (allowShell) {
      const { defaultRiskRules } = await import('../packages/im/lib/risk.js');
      rules.push(...defaultRiskRules().filter((r) => r.args).map((r) => ({ ...r, tool: 'demo-shell' })));
    }
    return rules;
  });
}
