// 通知总线（PRD FR-5）
//
// 事件源：assistant/chunk（流式增量）、assistant/message（含 usage）、
//         turn/end（结果卡片）、agent/error（失败通知）。
//
// 关键策略：
//  - 蓄水池 + flush（FR-3.3）：每 flushIntervalMs 或累计 N 字符推送一次增量，turn/end 强制刷完
//  - 在线/离线分流（FR-5.5）：用户最近 onlineWindowMin 活跃才推流式增量；人不在只推结果卡片
//  - 聚合（FR-5.4）：同一任务只推 1 条结果通知；同类通知 1 分钟内不重复（除审批）
//  - 静默时段 quietHours（FR-5.4）：不推送、只落日志，任务不中断
//  - 可操作通知（FR-5.6）：失败通知带【重试】按钮（重新 followup 同一任务）

import { markdownToText, resultCard, estimateCost, splitLongText } from './renderer.js';

const FLUSH_CHARS = 1400; // 或累计 N 字符强制 flush
// 蓄水池上限：离线/静音/静默时段只蓄水不推送，长 turn 下必须有界（round-2 P2-8）。
// 取 ~256KB 字符量级：远超任何单次流式增量，又不会让内存失控。
const RESERVOIR_MAX_CHARS = 256 * 1024;

export class NotifyBus {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./session-map.js').SessionMap} deps.map
   * @param {(chat: {platform:string, chatId:string}, out: import('./message.js').OutboundMessage) => Promise<any>} deps.send
   * @param {(line: string) => void} deps.log
   * @param {() => string} deps.lastUserTextFor  sessionId → 最近一条用户消息（重试用）
   */
  constructor({ ctx, map, send, log, lastUserTextFor }) {
    this.ctx = ctx;
    this.map = map;
    this.send = send;
    this.log = log;
    this.lastUserTextFor = lastUserTextFor;
    /** sessionId → 会话内状态 */
    this.sessions = new Map();
    this.onTurnEnd = true;
    this.onError = true;
    this.includeReasoning = false;
    this.includeCost = true;
    this.pricing = null;
    this.quietHours = [];
    this.streamWhileOnline = true;
    this.onlineWindowMin = 10;
    this.flushIntervalMs = 400;
    /** sessionId → 最近 turn 是否失败（/retry 门用，round-2 P2-6） */
    this.markTurnFailed = null;
    this._dispose = [];
    this._lastPush = new Map(); // `${sessionId}:${kind}` → ts（1 分钟聚合）
  }

  configure(cfg) {
    this.onTurnEnd = cfg.onTurnEnd ?? true;
    this.onError = cfg.onError ?? true;
    this.includeReasoning = cfg.includeReasoning ?? false;
    this.includeCost = cfg.includeCost ?? true;
    this.pricing = cfg.pricing ?? null;
    this.quietHours = cfg.quietHours ?? [];
    this.streamWhileOnline = cfg.streamWhileOnline ?? true;
    this.onlineWindowMin = cfg.onlineWindowMin ?? 10;
    this.flushIntervalMs = cfg.flushIntervalMs ?? 400;
    if (cfg.markTurnFailed) this.markTurnFailed = cfg.markTurnFailed;
  }

  mount() {
    this._dispose.push(this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)));
    this._dispose.push(this.ctx.on('agent/error', ({ agent, error }) => this.onAgentError(agent, error)));
  }

  dispose() {
    for (const d of this._dispose) d();
    this._dispose = [];
    for (const s of this.sessions.values()) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      if (s.reservoir) void this.flush(s, true).catch(() => {});
    }
    this.sessions.clear();
  }

  onSessionEvent(session, event) {
    const binding = this.map.bySessionId(session.id);
    if (!binding) return;
    switch (event.type) {
      case 'turn/start': {
        // 记录 turn 起点（结果卡片的耗时统计）
        const s = this.state(session.id);
        s.running = true;
        s.turnStartAt = Date.now();
        break;
      }
      case 'assistant/chunk': {
        if (event.data.chunk.type === 'text-delta' && event.data.chunk.text) {
          this.appendStream(binding, event.data.chunk.text);
        }
        break;
      }
      case 'assistant/message': {
        this.recordMessage(binding, event.data);
        break;
      }
      case 'turn/end': {
        this.handleTurnEnd(binding, event.data);
        break;
      }
      default:
        break;
    }
  }

  onAgentError(agent, error) {
    const binding = this.map.bySessionId(agent.id);
    if (!binding) return;
    // 🔴 muted 门必须与 sendReservoir 一致（round-2 P2-3）：此前只有流式检查 muted，
    // 错误卡/结果卡照发 ⇒ `/mute` 对用户仍是"半失效"。
    if (binding.muted) return;
    if (!this.onError) return;
    if (this.inQuietHours()) return;
    const session = this.state(agent.id);
    const now = Date.now();
    const last = this._lastPush.get(`${agent.id}:error`) ?? 0;
    if (now - last < 60_000) return; // 同类通知 1 分钟聚合
    this._lastPush.set(`${agent.id}:error`, now);
    const message = error instanceof Error ? error.message : String(error);
    const lastUserText = this.lastUserTextFor(agent.id);
    const text = `❌ Agent 出错：${message.slice(0, 800)}`
      + (lastUserText ? '\n\n可点下方按钮重试，或直接发 `/retry`。' : '');
    void this.send({ platform: binding.platform, chatId: binding.chatId }, {
      text,
      // 🔴 必须带 `command`：文本型渠道（如钉钉）拿不到内联按钮，会把按钮降级成
      // 一行提示文字；没有 command 时那行文字**不可执行**，用户在钉钉里根本没法重试
      // （round-n1 F12）。带上后可复制可执行。
      buttons: lastUserText
        ? [{ id: `retry:${agent.id}`, label: '🔁 重试', style: 'default', command: '/retry' }]
        : undefined,
    }).catch((err) => this.log(`[notify] error push failed: ${err.message}`));
  }

  state(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        reservoir: '',
        flushTimer: null,
        lastAssistantText: '',
        lastUsage: null,
        turnStartAt: Date.now(),
        lastTurn: 0,
        lastUserText: this.lastUserTextFor(sessionId),
        running: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 流式增量进蓄水池；仅在线且开启流式时发送。 */
  appendStream(binding, text) {
    const s = this.state(binding.sessionId);
    s.reservoir += text;
    // 🔴 蓄水池必须有界（round-2 P2-8）：离线/静音/静默时段只蓄水不推送，
    // 长 turn 可把内存推到无界。截尾保留（结果卡只引用 lastAssistantText，
    // 蓄水池内容只是过程性流式输出，丢头不丢尾对用户更友好）。
    if (s.reservoir.length > RESERVOIR_MAX_CHARS) {
      s.reservoir = s.reservoir.slice(-RESERVOIR_MAX_CHARS);
    }
    if (!this.streamWhileOnline || !this.map.isOnline(binding.platform, binding.chatId, this.onlineWindowMin * 60_000)) {
      // 人不在：只蓄水不推送（结果卡片兜底）
      return;
    }
    if (this.inQuietHours()) return;
    if (s.reservoir.length >= FLUSH_CHARS) {
      void this.flush(s, false).catch(() => {});
      return;
    }
    if (!s.flushTimer) {
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        void this.flush(s, false).catch(() => {});
      }, this.flushIntervalMs);
    }
  }

  async flush(s, force) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    const text = markdownToText(s.reservoir);
    if (!text) return;
    // 🔴 未达阈值时**不要清空** reservoir：此前先清空再判断长度，
    // 短片段（<40 字）会被直接丢弃、永远发不出去（round-n1 F13）。
    // 现在留在缓冲里继续累积，等下一次 flush 或 turn 结束（force）再发。
    if (!force && text.length < 40) return;
    s.reservoir = '';
    await this.sendReservoir(s, text);
  }

  async sendReservoir(s, text) {
    const binding = this.map.bySessionId(s.sessionId);
    if (!binding) return;
    // 🔴 `/mute` 此前只写 binding.muted 却**从不读取**，命令完全无效（round-n1 F14）。
    // 静默只作用于**普通通知**；审批（走 ApprovalManager 自己的 send）不受影响，
    // 与 `/mute` 的回复文案「审批仍会推送」保持一致。
    if (binding.muted) return;
    const chunks = splitLongText(text);
    for (const chunk of chunks) {
      await this.send({ platform: binding.platform, chatId: binding.chatId }, { text: chunk });
    }
  }

  recordMessage(binding, data) {
    const s = this.state(binding.sessionId);
    const text = extractText(data.message);
    if (text) s.lastAssistantText = text;
    if (data.usage) s.lastUsage = data.usage;
  }

  handleTurnEnd(binding, data) {
    const s = this.state(binding.sessionId);
    const now = Date.now();
    const durationMs = s.running ? now - s.turnStartAt : 0;
    s.running = false;
    s.turnStartAt = now;

    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    // 在线时强制刷完蓄水池
    if (s.reservoir && this.map.isOnline(binding.platform, binding.chatId, this.onlineWindowMin * 60_000)) {
      void this.flush(s, true).catch(() => {});
    }
    s.reservoir = '';

    // 🔴 状态维护**无条件**先于通知门（新计轮 round-1 P2）：「上一 turn 是否失败」是
    // /retry 的上下文，不是通知。旧版在 quiet-hours / onTurnEnd=false 时早退，
    // 不清除陈旧失败标记 ⇒ 静默期后 /retry 被误放行（可能重放带写操作的任务）。
    const reason = data.reason;
    const status = reason.kind === 'completed' ? 'completed'
      : reason.kind === 'error' ? 'error'
        : reason.kind === 'aborted' ? 'aborted'
          : reason.kind === 'max-tokens' ? 'max-tokens'
            : reason.kind === 'blocked' ? 'blocked'
              : reason.kind === 'interrupted' ? 'interrupted' : 'completed';
    // 🔴 /retry 的失败上下文（round-2 P2-6）：只有**上一 turn 真的失败**才允许重试，
    // 否则用户在成功任务后发 /retry 会把（可能带写操作的）任务原样重跑一遍。
    if (this.markTurnFailed) this.markTurnFailed(binding.sessionId, status === 'error');

    if (!this.onTurnEnd) return;
    if (this.inQuietHours()) return;

    // 🔴 muted 门（round-2 P2-3）：静默聊天不推结果卡；蓄水池已在上面清掉，
    // 不会因跳过推送而堆积。审批仍走独立路径（见 /mute 回执文案）。
    if (binding.muted) return;

    // 聚合：同一任务只推 1 条结果通知（turn 已唯一）
    const costText = this.includeCost ? estimateCost(s.lastUsage, this.pricing) : null;
    const summary = s.lastAssistantText ? markdownToText(s.lastAssistantText) : '';
    const card = resultCard({
      status,
      summary: summary.slice(0, 1200),
      durationMs,
      usage: s.lastUsage,
      costText,
    });
    const out = { text: card };
    // 失败通知带重试按钮（FR-5.6）
    const lastUserText = this.lastUserTextFor(binding.sessionId);
    if (status === 'error' && lastUserText) {
      out.buttons = [{ id: `retry:${binding.sessionId}`, label: '🔁 重试', style: 'default', command: '/retry' }];
    }
    void this.send({ platform: binding.platform, chatId: binding.chatId }, out)
      .catch((err) => this.log(`[notify] result push failed: ${err.message}`));
  }

  /** 静默时段判定（"22:00-08:00" 格式）。 */
  inQuietHours() {
    if (!this.quietHours.length) return false;
    const d = new Date();
    const nowMin = d.getHours() * 60 + d.getMinutes();
    for (const range of this.quietHours) {
      const m = String(range).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = Number(m[3]) * 60 + Number(m[4]);
      if (start <= end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end) return true;
    }
    return false;
  }
}

/** 从 assistant message 的 content blocks 提取文本。 */
function extractText(message) {
  if (!message?.content) return '';
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}
