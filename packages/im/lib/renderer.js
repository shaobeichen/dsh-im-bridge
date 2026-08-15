// 渲染器（PRD FR-3.2 / FR-3.4 / FR-3.5）
//
// v1 策略：把 agent 输出的 Markdown 降级为手机友好的纯文本
// （不渲染表格/图片，代码块保留缩进），并做长度截断。
// 长输出单条消息超限时按段落拆分；无法拆分时折叠为「摘要 + 关键结论」，
// 完整输出经 /log 以文件形式交付（FR-3.4，人在外也能拿全量结果）。

/** 单条 IM 消息的安全上限（各平台普遍限制，取保守值）。 */
export const MAX_MESSAGE_CHARS = 3500;

/**
 * Markdown → 纯文本（降级渲染）。
 * - 代码围栏：保留内容，代码块不丢失
 * - 行内代码/粗体/斜体/链接：剥掉标记，链接保留为 "标题 (url)"
 * - 标题：转为 "▍标题"
 * - 表格：逐行合并为 " | " 分隔的文本行
 * - 列表：保留 "-"/数字 前缀
 * - 图片/HTML：丢弃
 */
export function markdownToText(md) {
  if (typeof md !== 'string') return '';
  let lines = md.split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (let raw of lines) {
    const fence = raw.match(/^\s*```+/);
    if (fence) {
      inFence = !inFence;
      out.push(inFence ? '```' : '```');
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    let line = raw;
    // 表格行 → " | " 分隔
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()).join(' | ').replace(/^\s*:?-{2,}:?\s*$/, '');
      out.push(line);
      continue;
    }
    // 标题
    line = line.replace(/^(#{1,6})\s+/, (_, h) => `${'▍'.repeat(h.length)} `);
    // 行内标记
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')           // 图片 → 标题
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')       // 链接 → 标题 (url)
      .replace(/`([^`]+)`/g, '$1')                           // 行内代码
      .replace(/\*\*([^*]+)\*\*/g, '$1')                     // 粗体
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')             // 斜体
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')                         // 删除线
      .replace(/<[^>]+>/g, '');                              // HTML
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按段落拆分长文本；返回最多 chunks 段（每段 ≤ maxLen，优先在段落边界断）。 */
export function splitLongText(text, { maxLen = MAX_MESSAGE_CHARS, maxChunks = 6 } = {}) {
  if (text.length <= maxLen) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  const push = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };
  for (const para of paragraphs) {
    if (para.length > maxLen) {
      push();
      // 超长段落：按行断
      let buf = '';
      for (const line of para.split('\n')) {
        if ((buf + '\n' + line).length > maxLen) {
          chunks.push(buf);
          buf = line;
        } else {
          buf = buf ? buf + '\n' + line : line;
        }
      }
      if (buf) current = buf;
      continue;
    }
    if ((current + '\n\n' + para).length > maxLen) {
      push();
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  push();
  return chunks.slice(0, maxChunks);
}

/**
 * 长输出折叠为「摘要 + 关键结论」（FR-3.4）。
 * 摘取开头 head 字符 + 结尾 tail 字符（结论通常在尾部），
 * 并附加 /log 提示——摘要必须包含可执行结论，不依赖回 Web 看。
 */
export function summarizeLongOutput(text, { head = 600, tail = 400 } = {}) {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n\n……（中间 ${text.length - head - tail} 字符已省略）\n\n${text.slice(-tail)}\n\n> 完整输出：回复 /log 获取全文`;
}

/**
 * 组装 turn/end 结果卡片（FR-5.1）。
 * @param {Object} opts
 * @param {string} opts.status  'completed' | 'error' | 'aborted' | 'max-tokens' | 'blocked'
 * @param {string} [opts.summary] 最后一条 assistant 文本（截断后）
 * @param {number} [opts.durationMs]
 * @param {{inputTokens?:number, outputTokens?:number}} [opts.usage]
 * @param {string} [opts.costText]  已格式化的成本文本（如 "¥0.012"）
 */
export function resultCard({ status, summary = '', durationMs, usage, costText }) {
  const icon = { completed: '✅', error: '❌', aborted: '⏹️', 'max-tokens': '⚠️', blocked: '⏳', interrupted: '⚠️' }[status] ?? '✅';
  const label = { completed: '任务完成', error: '任务失败', aborted: '任务已取消', 'max-tokens': '输出达到上限', blocked: '任务被阻塞', interrupted: '任务被中断' }[status] ?? '任务结束';
  const lines = [`${icon} ${label}`];
  if (summary) lines.push('', summary);
  const meta = [];
  if (durationMs != null) meta.push(`⏱ ${(durationMs / 1000).toFixed(1)}s`);
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    meta.push(`🔢 ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out tokens`);
  }
  if (costText) meta.push(`💰 ${costText}`);
  if (meta.length) lines.push('', meta.join(' · '));
  return lines.join('\n');
}

/** 估算成本：无定价表时返回 null（调用方改为只显示 token）。 */
export function estimateCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const input = (usage.inputTokens ?? 0) / 1_000_000 * (pricing.inputPerM ?? 0);
  const output = (usage.outputTokens ?? 0) / 1_000_000 * (pricing.outputPerM ?? 0);
  const total = input + output;
  if (total <= 0) return null;
  return total >= 1 ? `$${total.toFixed(2)}` : `$${total.toFixed(4)}`;
}

/** 工具调用参数摘要（FR-6.3 审批内容，敏感参数脱敏）。 */
export function argsSummary(argsJson) {
  if (!argsJson) return '';
  let obj;
  try {
    obj = JSON.parse(argsJson);
  } catch {
    return String(argsJson).slice(0, 120);
  }
  const REDACT_KEYS = /(token|secret|key|password|passwd|credential|authorization|cookie|api[_-]?key)/i;
  const REDACT_PATTERN = /(Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9._-]{20,})/g;
  const walk = (value, depth = 0) => {
    if (depth > 4) return '…';
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') {
      return value.replace(REDACT_PATTERN, '***').slice(0, 200);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      if (value.length > 6) return `[${value.slice(0, 6).map((v) => walk(v, depth + 1)).join(', ')}, …×${value.length - 6}]`;
      return `[${value.map((v) => walk(v, depth + 1)).join(', ')}]`;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 8) {
        const shown = entries.slice(0, 8).map(([k, v]) => `${k}=${walk(v, depth + 1)}`);
        return `{${shown.join(', ')}, …+${entries.length - 8}}`;
      }
      return `{${entries.map(([k, v]) => {
        if (REDACT_KEYS.test(k)) return `${k}=***`;
        if (typeof v === 'string' && REDACT_PATTERN.test(v)) return `${k}=***`;
        return `${k}=${walk(v, depth + 1)}`;
      }).join(', ')}}`;
    }
    return '…';
  };
  return walk(obj).slice(0, 400);
}
