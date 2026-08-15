// IM 斜杠命令集（PRD FR-4）
//
// 命令表 + 解析器。执行逻辑由核心在 dispatch 时按权限调用（见 index.js）。
// 群聊权限分层：admin 才能执行敏感命令；普通 allowlist 成员只能派活与查状态（FR-4.2）。

/**
 * 命令定义。
 * @typedef {Object} CommandDef
 * @property {'user'|'admin'} perm  权限：user=allowlist 内；admin=allowlist 中标记 admin
 * @property {string} usage         用法示例
 * @property {string} desc          中文说明（/help 展示）
 * @property {string} [descEn]      英文说明
 * @property {(ctx: import('./commands.js').CommandContext, args: string[]) => Promise<any>} run
 */

/**
 * @typedef {Object} CommandContext
 * @property {import('./message.js').ImMessage} msg
 * @property {import('./session-map.js').SessionMap} map
 * @property {Object} core  核心运行时的公共引用（send/agents/...，由 index.js 注入）
 */

/** 命令名 → 定义。命令处理器由核心注册（避免模块环依赖）。 */
export const commands = new Map();

/** 注册命令（核心启动时调用）。 */
export function registerCommand(name, def) {
  commands.set(name, def);
}

/**
 * 解析 IM 文本中的命令。
 * 支持："/cmd args"、"/cmd@botname args"（Telegram 群聊带 bot 用户名）。
 * @returns {null | {name:string, args:string[], raw:string}}
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  if (!t.startsWith('/')) return null;
  const match = t.match(/^\/([A-Za-z0-9_-]+)(?:@[A-Za-z0-9_]+)?\s*(.*)$/s);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const rest = (match[2] ?? '').trim();
  const args = rest ? rest.split(/\s+/).filter(Boolean) : [];
  return { name, args, raw: t };
}

/** 检查某用户是否有权执行某命令。 */
export function canRun(def, { isAllowed, isAdmin }) {
  if (def.perm === 'admin') return isAdmin;
  return isAllowed;
}

/** /help 文本（双语）。 */
export function helpText() {
  const rows = [];
  for (const [name, def] of commands) {
    const en = def.descEn ? ` / ${def.descEn}` : '';
    const perm = def.perm === 'admin' ? ' [admin]' : '';
    rows.push(`/${name} ${def.usage}${perm} — ${def.desc}${en}`);
  }
  return ['**IM 命令（DeepSeek Harness）**', '', ...rows].join('\n');
}
