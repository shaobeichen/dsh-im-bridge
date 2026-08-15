// 审批管理器（PRD FR-6，设计中心）
//
// 两段式接线：
//  1. tools/pre-execute 门：按风险规则（riskRules）对 IM 会话的工具调用返回 {kind:'ask'}
//     （autoApproveRisk 阈值以下直接放行，FR-6.6）。同时捕获 callId→参数摘要，
//     供审批卡片展示（FR-6.3；approval seam 本身不带工具参数）。
//  2. approval/request answerer：把官方审批 seam（ctx.approval.request）路由到 IM
//     —— 推送审批卡片（按钮优先，/approve 文本降级），首个响应者生效（FR-6.5）。
//
// 超时语义（FR-6.4，可恢复拒绝）：
//    timeoutSec 内无人响应 → 推送「任务被阻塞，等待审批」提醒，请求进入 pending；
//    用户可稍后点按钮或 /approve 恢复审批；pendingMaxSec 仍无人响应 → 失败关闭（rejected）。
//    状态语义依据 dsh-user-approval：request 只在一个 open turn 内有效，
//    阻塞期间该 step 同步等待（与官方 ask 拦截语义一致，PRD 开放问题 #5 的落地）。
//
// 审批记录：本地追加式 approvals.log（FR-6.7），不落 IM。

import { randomUUID } from 'node:crypto';
import { evaluateRisk, riskAtLeast } from './risk.js';
import { argsSummary } from './renderer.js';

export class ApprovalManager {
  /**
   * @param {Object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {import('./session-map.js').SessionMap} deps.map
   * @param {(chat: {platform:string, chatId:string}, out: import('./message.js').OutboundMessage) => Promise<any>} deps.send
   * @param {(line: Object) => void} deps.logLine
   */
  constructor({ ctx, map, send, logLine }) {
    this.ctx = ctx;
    this.map = map;
    this.send = send;
    this.logLine = logLine;
    /** approvalId → record */
    this.records = new Map();
    /** callId → {tool, argsSummary, at}（pre-execute 捕获，卡片渲染用） */
    this.callArgs = new Map();
    this.enabled = true;
    this.timeoutSec = 300;
    this.pendingMaxSec = 3600;
    this.autoApproveRisk = 'none';
    this.riskRules = [];
    this._dispose = [];
    /** 最近已决记录（保留短暂窗口，供「已被响应」提示，FR-6.5） */
    this.recentDecisions = new Map();
  }

  configure({ enabled, timeoutSec, pendingMaxSec, autoApproveRisk, riskRules }) {
    this.enabled = enabled ?? true;
    this.timeoutSec = timeoutSec ?? 300;
    this.pendingMaxSec = pendingMaxSec ?? 3600;
    this.autoApproveRisk = autoApproveRisk ?? 'none';
    this.riskRules = riskRules ?? [];
  }

  /** 挂接 tools/pre-execute 门 + approval/request answerer。 */
  mount() {
    this._dispose.push(this.ctx.on('tools/pre-execute', (exec, next) => this.gate(exec, next)));
    this._dispose.push(this.ctx.on('approval/request', (req, next) => this.answer(req, next)));
  }

  dispose() {
    for (const d of this._dispose) d();
    this._dispose = [];
    for (const rec of this.records.values()) {
      clearTimeout(rec.timeoutTimer);
      clearTimeout(rec.pendingTimer);
      rec.resolve('cancelled');
    }
    this.records.clear();
  }

  /** 只对 IM 绑定的会话做风险门；其余会话交给其他策略（Web UI 等），不双弹窗（§10）。 */
  gate(exec, next) {
    if (!this.enabled) return next();
    const agent = exec.agent;
    const binding = agent ? this.map.bySessionId(agent.id) : null;
    if (!binding) return next();
    const argsJson = JSON.stringify(exec.arguments ?? {});
    const risk = evaluateRisk(exec.name, argsJson, this.riskRules);
    // FR-6.6：autoApproveRisk 阈值 ≥ 实际风险 → 自动放行
    if (riskAtLeast(this.autoApproveRisk, risk)) return next();
    // 常规操作（low）永不触发审批——防审批疲劳（FR-6.6：npm install 等不应弹审批）
    if (!riskAtLeast(risk, 'medium')) return next();
    // 捕获参数摘要供卡片渲染
    const callId = exec.callId;
    if (callId) {
      this.callArgs.set(callId, {
        tool: exec.name,
        risk,
        args: argsSummary(argsJson),
        at: Date.now(),
      });
      if (this.callArgs.size > 200) {
        const oldest = this.callArgs.keys().next().value;
        this.callArgs.delete(oldest);
      }
    }
    const reason = `工具 "${exec.name}" 被判定为 ${risk} 风险（IM 远程审批，默认拒绝）`;
    return { kind: 'ask', reason };
  }

  /** approval/request answerer：只应答 IM 会话的请求，否则委托给下游（next()）。 */
  answer(req, next) {
    if (!this.enabled) return next();
    const binding = this.map.bySessionId(req.agent.id);
    if (!binding) return next();
    return this.prompt(req, binding);
  }

  /** 推送审批卡片并等待响应。 */
  async prompt(req, binding) {
    const approvalId = randomUUID().slice(0, 8);
    const callInfo = req.callId ? this.callArgs.get(req.callId) : null;
    const risk = callInfo ? callInfo.risk ?? 'medium' : 'medium';
    const record = {
      id: approvalId,
      req,
      binding,
      toolName: req.toolName,
      args: callInfo?.args ?? '',
      risk,
      reason: req.reason ?? '',
      createdAt: Date.now(),
      state: 'waiting', // waiting → pending（超时提醒后）→ decided
      responder: null,
      resolve: null,
      timeoutTimer: null,
      pendingTimer: null,
    };
    const outcome = new Promise((resolve) => {
      record.resolve = (value) => {
        if (record.state === 'decided') return;
        record.state = 'decided';
        clearTimeout(record.timeoutTimer);
        clearTimeout(record.pendingTimer);
        this.logLine({
          ts: new Date().toISOString(),
          approvalId,
          agent: binding.sessionId,
          tool: req.toolName,
          args: record.args,
          requester: `${binding.platform}:${binding.chatId}`,
          responder: record.responder,
          outcome: value,
          durationMs: Date.now() - record.createdAt,
        });
        this.records.delete(approvalId);
        this.recentDecisions.set(approvalId, { outcome: value, at: Date.now(), responder: record.responder });
        if (this.recentDecisions.size > 100) {
          const oldest = this.recentDecisions.keys().next().value;
          this.recentDecisions.delete(oldest);
        }
        resolve(value);
      };
    });
    record.decided = record.resolve;
    this.records.set(approvalId, record);

    const card = this.renderCard(record);
    try {
      await this.send({ platform: binding.platform, chatId: binding.chatId }, card);
    } catch (err) {
      // 推送失败：不阻塞 agent——按 unavailable 处理（fail closed）
      record.resolve('unavailable');
      return 'unavailable';
    }

    // 超时 → pending（可恢复拒绝，FR-6.4）
    record.timeoutTimer = setTimeout(() => {
      if (record.state !== 'waiting') return;
      record.state = 'pending';
      void this.send({ platform: binding.platform, chatId: binding.chatId }, {
        text: `⏳ 审批 #${approvalId} 等待中：任务被阻塞，等待你的审批。\n回复 /approve ${approvalId} yes 或 no；或直接点卡片按钮。`,
      }).catch(() => {});
      // 再超 → 失败关闭（deny-by-default 兜底）
      record.pendingTimer = setTimeout(() => {
        if (record.state !== 'pending') return;
        record.resolve('rejected');
        void this.send({ platform: binding.platform, chatId: binding.chatId }, {
          text: `❌ 审批 #${approvalId} 超时未响应，已拒绝（可重试）。`,
        }).catch(() => {});
      }, this.pendingMaxSec * 1000);
    }, this.timeoutSec * 1000);

    // 会话取消 → cancelled
    req.signal?.addEventListener('abort', () => record.resolve('cancelled'), { once: true });

    return outcome;
  }

  renderCard(record) {
    const lines = [
      `🔐 审批请求 #${record.id}`,
      `工具: ${record.toolName}`,
    ];
    if (record.args) lines.push(`参数: ${record.args}`);
    lines.push(`风险: ${record.risk}`);
    if (record.reason) lines.push(`原因: ${record.reason}`);
    lines.push(`会话: ${record.binding.sessionId}`);
    return {
      text: lines.join('\n'),
      title: '🔐 审批请求',
      buttons: [
        { id: `approve:${record.id}:yes`, label: '✅ 批准', style: 'primary' },
        { id: `approve:${record.id}:no`, label: '❌ 拒绝', style: 'danger' },
      ],
    };
  }

  /**
   * 用户响应（按钮回调 / /approve 命令）。首个响应者生效（FR-6.5）。
   * @returns {'accepted'|'rejected'|'ignored'|'not-found'|'forbidden'}
   */
  respond(approvalId, answer, { platform, userId, userName }) {
    const record = this.records.get(approvalId);
    if (!record) {
      // 已决或不存在：已决 → ignored（"已被响应"），否则 not-found
      return this.recentDecisions.has(approvalId) ? 'ignored' : 'not-found';
    }
    if (!this.map.isAllowed(platform, userId)) return 'forbidden';
    if (record.state === 'decided') return 'ignored';
    if (answer !== 'yes' && answer !== 'no') return 'ignored';
    record.responder = `${platform}:${userId}${userName ? ` (${userName})` : ''}`;
    record.resolve(answer === 'yes' ? 'allowed-once' : 'rejected');
    return answer === 'yes' ? 'accepted' : 'rejected';
  }

  /** 当前等待中的审批（/status 用）。 */
  pendingList() {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      tool: r.toolName,
      state: r.state,
      ageSec: Math.round((Date.now() - r.createdAt) / 1000),
    }));
  }
}
