// 通知总线（PRD FR-5）
//
// 事件源：assistant/chunk（流式增量）、assistant/message（含 usage）、
//         turn/end（结果卡片）、agent/error（失败通知）。
//
// 关键策略：
//  - 蓄水池 + flush（FR-3.3）：每 flushIntervalMs 或累计 N 字符推送一次增量，turn/end 强制刷完
//  - 流式原地更新（streamEdit）：渠道实现 edit() 且 send 返回 messageId 时，后续增量
//    编辑同一条消息（对照成熟 Claude Code↔IM 桥的打字机体验）；edit 失败或渠道不支持
//    时回退为逐条新消息，绝不丢内容
//  - 在线/离线分流（FR-5.5）：用户最近 onlineWindowMin 活跃才推流式增量；人不在只推结果卡片
//  - 聚合（FR-5.4）：同一任务只推 1 条结果通知；同类通知 1 分钟内不重复（除审批）
//  - 静默时段 quietHours（FR-5.4）：不推送、只落日志，任务不中断
//  - 可操作通知（FR-5.6）：失败通知带【重试】按钮（重新 followup 同一任务）

import { markdownToText, resultCard, estimateCost, splitLongText } from './renderer.js';

const FLUSH_CHARS = 1400; // 或累计 N 字符强制 flush
const MAX_RESERVOIR = 3500; // 蓄水池上限：超长离线输出只保留尾部（完整输出走 /log）
/** 流式卡片单帧的字符上限（飞书 lark_md 字段限制内取保守值）。 */
const STREAM_TAIL_CHARS = 2800;
const STREAM_TITLE = 'DeepSeek Harness ⏳ 执行中';

/** 截取流式帧的尾部（超出部分提示用 /log 取全文）。 */
export function streamTail(text, { max = STREAM_TAIL_CHARS, title = STREAM_TITLE } = {}) {
  const body = typeof text === 'string' ? text : '';
  if (body.length <= max) return body;
  return `…（前文省略，完整结果回复 /log）\n${body.slice(-max)}`;
}

export class NotifyBus {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./session-map.js').SessionMap} deps.map
   * @param {(chat: {platform:string, chatId:string}, out: import('./message.js').OutboundMessage) => Promise<any>} deps.send
   * @param {(chat: {platform:string, chatId:string}, messageId: string, out: import('./message.js').OutboundMessage) => Promise<any>} [deps.edit]
   * @param {(line: string) => void} deps.log
   * @param {() => string} deps.lastUserTextFor  sessionId → 最近一条用户消息（重试用）
   */
  constructor({ ctx, map, send, edit, log, lastUserTextFor }) {
    this.ctx = ctx;
    this.map = map;
    this.send = send;
    /** 渠道 edit 路由（无则流式退化为逐条新消息）。 */
    this.edit = edit ?? null;
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
    this.streamEdit = true; // 渠道支持 edit() 时原地更新流式消息（FR-3.3 增强）
    this.onlineWindowMin = 10;
    this.flushIntervalMs = 400;
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
    this.streamEdit = cfg.streamEdit ?? true;
    this.onlineWindowMin = cfg.onlineWindowMin ?? 10;
    this.flushIntervalMs = cfg.flushIntervalMs ?? 400;
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
    if (!this.onError) return;
    if (this.inQuietHours()) return;
    const session = this.state(agent.id);
    const now = Date.now();
    const last = this._lastPush.get(`${agent.id}:error`) ?? 0;
    if (now - last < 60_000) return; // 同类通知 1 分钟聚合
    this._lastPush.set(`${agent.id}:error`, now);
    const message = error instanceof Error ? error.message : String(error);
    const text = `❌ Agent 出错：${message.slice(0, 800)}`;
    const lastUserText = this.lastUserTextFor(agent.id);
    void this.send({ platform: binding.platform, chatId: binding.chatId }, {
      text,
      buttons: lastUserText ? [{ id: `retry:${agent.id}`, label: '🔁 重试', style: 'default' }] : undefined,
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
        /** 当前 turn 的流式消息 id（渠道 edit 目标）；null = 尚未发送。 */
        streamMessageId: null,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 流式增量进蓄水池；仅在线且开启流式时发送。 */
  appendStream(binding, text) {
    const s = this.state(binding.sessionId);
    s.reservoir += text;
    // 蓄水池上限：超长离线输出只保留尾部，防止无限内存增长（完整输出走 /log）
    if (s.reservoir.length > MAX_RESERVOIR) {
      s.reservoir = s.reservoir.slice(-MAX_RESERVOIR);
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
    s.reservoir = '';
    if (!text) return;
    if (force || text.length >= 40) {
      await this.pushStream(s, text);
    }
  }

  /**
   * 推送一帧流式增量。
   * streamEdit 且已有流式消息 id → 原地编辑；否则发送新消息并记录 id。
   * edit 失败 → 丢弃 id 回退发新消息（渠道可能不支持 patch 或消息过期）。
   */
  async pushStream(s, text) {
    const binding = this.map.bySessionId(s.sessionId);
    if (!binding) return;
    const chat = { platform: binding.platform, chatId: binding.chatId };

    if (this.streamEdit && s.streamMessageId && this.edit) {
      try {
        await this.edit(chat, s.streamMessageId, { text: streamTail(text), stream: true, title: STREAM_TITLE });
        return;
      } catch (err) {
        this.log(`[notify] stream edit failed, falling back to new message: ${err instanceof Error ? err.message : String(err)}`);
        s.streamMessageId = null;
      }
    }

    if (this.streamEdit) {
      // 流式模式：一条消息承载全部增量（只显示尾部），不做分段
      const res = await this.send(chat, { text: streamTail(text), stream: true, title: STREAM_TITLE });
      if (res?.messageId) s.streamMessageId = res.messageId;
      return;
    }

    // 非流式模式：按段落拆分发新消息（渠道无 edit 或用户关闭 streamEdit）
    const chunks = splitLongText(text);
    for (const chunk of chunks) {
      await this.send(chat, { text: chunk });
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
    void this.finishTurn(s, binding, data, durationMs);
  }

  /** 异步收尾：先刷完蓄水池（可能编辑流式消息），再发结果卡片（全新消息）。 */
  async finishTurn(s, binding, data, durationMs) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    // 在线时强制刷完蓄水池
    if (s.reservoir && this.map.isOnline(binding.platform, binding.chatId, this.onlineWindowMin * 60_000)) {
      await this.flush(s, true).catch(() => {});
    }
    s.reservoir = '';
    // 结果卡片是全新消息：结束本 turn 的流式编辑目标
    s.streamMessageId = null;

    if (!this.onTurnEnd) return;
    if (this.inQuietHours()) return;

    const reason = data.reason;
    const status = reason.kind === 'completed' ? 'completed'
      : reason.kind === 'error' ? 'error'
        : reason.kind === 'aborted' ? 'aborted'
          : reason.kind === 'max-tokens' ? 'max-tokens'
            : reason.kind === 'blocked' ? 'blocked'
              : reason.kind === 'interrupted' ? 'interrupted' : 'completed';

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
      out.buttons = [{ id: `retry:${binding.sessionId}`, label: '🔁 重试', style: 'default' }];
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
