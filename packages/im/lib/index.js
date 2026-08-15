// dsh-im 核心插件（PRD §8 架构）
//
// 提供 ctx.im 服务：渠道注册、统一消息模型、会话映射、命令解析、
// 渲染、通知总线、审批管理。渠道 adapter 只做协议转换。
//
// 挂载顺序（PRD §12：MockChannel 契约测试先行 → core → adapter）：
//   1. 加载会话映射（mappings.json，重启恢复）
//   2. 挂接审批门（tools/pre-execute）与审批 answerer（approval/request）
//   3. 挂接通知总线（session/event、agent/error）
//   4. 注册命令集
//   5. 等待渠道 adapter 注册（registerChannel）

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFile, mkdir, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { chatKey, userKey, parseUserKey, sessionIdFor } from './message.js';
import { validateAdapterContract } from './channel.js';
import { SessionMap } from './session-map.js';
import { registerCommand, parseCommand, helpText, commands } from './commands.js';
import { markdownToText, splitLongText, summarizeLongOutput } from './renderer.js';
import { ApprovalManager } from './approvals.js';
import { NotifyBus } from './notify.js';
import { defaultRiskRules } from './risk.js';

const name = 'im';
const inject = ['agents'];

/** 核心配置（PRD §9；密钥一律 env: 引用，绝不落明文）。 */
const Config = z.object({
  security: z.object({
    allowlist: z.array(z.string()).default([]),       // ["feishu:user_a", "telegram:12345"]
    admins: z.array(z.string()).default([]),          // 可执行敏感命令/审批
    autoCreate: z.boolean().default(false),           // 新聊天是否自动建会话（FR-2.3）
    maxSessions: z.number().default(10),              // FR-2.4
    trustOnFirstContact: z.boolean().default(false),  // FR-9.2 MVP 形态：true=首条消息自动信任（个人自用）；
                                                      // 有 admin 时走「推送管理员确认」路径，无需开此开关
  }),
  approvals: z.object({
    enabled: z.boolean().default(true),
    timeoutSec: z.number().default(300),              // FR-6.4：超时 → pending（可恢复拒绝）
    pendingMaxSec: z.number().default(3600),          // 兜底：仍无人响应 → 失败关闭
    autoApproveRisk: z.union([z.const('none'), z.const('low'), z.const('medium')]).default('none'), // FR-6.6
    riskRules: z.array(z.object({
      tool: z.string(),
      args: z.string(),
      risk: z.union([z.const('low'), z.const('medium'), z.const('high')]),
    })), // 缺省时在 apply 中用 defaultRiskRules()（schemastery 不支持函数默认值）
  }),
  notifications: z.object({
    onTurnEnd: z.boolean().default(true),             // FR-5.3
    onError: z.boolean().default(true),
    includeReasoning: z.boolean().default(false),
    includeCost: z.boolean().default(true),
    pricing: z.object({
      inputPerM: z.number().default(0),
      outputPerM: z.number().default(0),
    }), // 0=仅显示 token，不估算金额
    quietHours: z.array(z.string()).default([]),      // 如 ["22:00-08:00"]（FR-5.4）
    streamWhileOnline: z.boolean().default(true),      // FR-3.3/5.5
    streamEdit: z.boolean().default(true),             // 渠道支持 edit() 时原地更新流式消息（打字机体验）
    onlineWindowMin: z.number().default(10),           // FR-5.5 在线判定窗口
    flushIntervalMs: z.number().default(400),
  }),
  agent: z.object({
    provider: z.string().default(''),                  // 空 → 用 agentDefaultModel 或内置默认
    model: z.string().default(''),
    workspace: z.string().default(''),                 // 空 → process.cwd()
  }),
  storeDir: z.string().default(''),                    // 空 → $DSH_HOME/dsh-im
});

/** 默认模型兜底（与官方 base agent-default-model 一致）。 */
const DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };

export class ImRuntime extends Service {
  static inject = inject;
  static Config = Config;

  constructor(ctx, config = {}) {
    super(ctx, name);
    this.cfg = config;
    this.channels = new Map();
    this.lastUserTexts = new Map(); // sessionId → 最近一条用户文本（重试用，FR-5.6）
    this._lastFullOutput = new Map(); // sessionId → 最近 turn 的完整输出（/log 用）
    this.log = ctx.logger('im');
    this._dispose = [];
    this._ready = this.init();
    // 消费方 await 初始化完成
    this.whenReady = () => this._ready;
    // 随插件卸载自动清理（cordis fiber effect；构造函数内同步注册，避免 await 后注册失效）
    this.ctx.effect(() => () => {
      void this.dispose();
    });
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────

  async init() {
    const cfg = this.cfg;
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    this.storeDir = cfg.storeDir || join(home, 'dsh-im');

    this.map = new SessionMap(this.storeDir);
    await this.map.load();
    // 配置中的 allowlist/admins 为权威来源，与运行期追加合并
    for (const u of cfg.security.allowlist ?? []) this.map.allowlist.add(u);
    for (const u of cfg.security.admins ?? []) this.map.admins.add(u);

    // 安全默认引导：allowlist 与 admins 全空 = deny-all，管理员需一次性配置自己的键
    if ((cfg.security.allowlist?.length ?? 0) === 0 && (cfg.security.admins?.length ?? 0) === 0) {
      this.log.warn(
        'security: deny-all — no allowlist/admins configured yet. Add your own key once, e.g. im.security.admins: ["feishu:ou_xxx"], then every new user is approved by you with one tap. | '
        + '安全：当前拒绝所有用户。请一次性在配置 im.security.admins 填入你自己的用户键（如 ["feishu:ou_xxx"]），之后新用户首条消息会触发你的一键信任确认。'
      );
    }

    // 审批
    this.approvals = new ApprovalManager({
      ctx: this.ctx,
      map: this.map,
      send: (chat, out) => this.send(chat, out),
      logLine: (line) => this.appendLog('approvals', line),
    });
    this.approvals.configure({
      enabled: cfg.approvals.enabled,
      timeoutSec: cfg.approvals.timeoutSec,
      pendingMaxSec: cfg.approvals.pendingMaxSec,
      autoApproveRisk: cfg.approvals.autoApproveRisk,
      riskRules: cfg.approvals.riskRules ?? defaultRiskRules(),
    });
    this.approvals.mount();

    // 通知
    this.notify = new NotifyBus({
      ctx: this.ctx,
      map: this.map,
      send: (chat, out) => this.send(chat, out),
      edit: (chat, messageId, out) => this.edit(chat, messageId, out),
      log: (line) => this.log.info(line),
      lastUserTextFor: (sessionId) => this.lastUserTexts.get(sessionId) ?? '',
    });
    this.notify.configure({
      onTurnEnd: cfg.notifications.onTurnEnd,
      onError: cfg.notifications.onError,
      includeReasoning: cfg.notifications.includeReasoning,
      includeCost: cfg.notifications.includeCost,
      pricing: cfg.notifications.pricing ?? null,
      quietHours: cfg.notifications.quietHours ?? [],
      streamWhileOnline: cfg.notifications.streamWhileOnline,
      streamEdit: cfg.notifications.streamEdit,
      onlineWindowMin: cfg.notifications.onlineWindowMin,
      flushIntervalMs: cfg.notifications.flushIntervalMs,
    });
    this.notify.mount();

    // 命令
    this.registerCommands();

    // 会话事件：捕获完整输出（/log 用）
    this._dispose.push(this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      if (!this.map.bySessionId(session.id)) return;
      const text = event.data.message?.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text ?? '').join('\n');
      if (text) this._lastFullOutput.set(session.id, text);
    }));

    this._dispose.push(() => {
      this.approvals.dispose();
      this.notify.dispose();
      void this.map.dispose();
    });
  }

  // ── 渠道注册（FR-1.1 / §8.3 扩展点） ─────────────────────────────────────

  /** 注册渠道 adapter（契约不完整 → 抛错，FR-9.4）。 */
  registerChannel(channel) {
    const contract = validateAdapterContract(channel);
    for (const w of contract.warnings) this.log.warn(w);
    if (this.channels.has(channel.platform)) {
      throw new Error(`im: channel "${channel.platform}" already registered`);
    }
    if (typeof channel.attach === 'function') channel.attach(this);
    this.channels.set(channel.platform, channel);
    this.log.info(`channel "${channel.platform}" registered | 渠道已注册`);
    return () => {
      this.channels.delete(channel.platform);
      if (typeof channel.dispose === 'function') void channel.dispose();
    };
  }

  getChannel(platform) {
    return this.channels.get(platform) ?? null;
  }

  /** 出站路由：统一模型 → 渠道 send()。 */
  async send({ platform, chatId }, out) {
    await this._ready;
    const channel = this.channels.get(platform);
    if (!channel) throw new Error(`im: no channel registered for "${platform}"`);
    return channel.send({ ...out, platform, chatId });
  }

  /** 流式原地更新路由：统一模型 → 渠道 edit()（渠道未实现时抛错，调用方回退发新消息）。 */
  async edit({ platform, chatId }, messageId, out) {
    await this._ready;
    const channel = this.channels.get(platform);
    if (!channel) throw new Error(`im: no channel registered for "${platform}"`);
    if (typeof channel.edit !== 'function') {
      throw new Error(`im: channel "${platform}" does not implement edit()`);
    }
    return channel.edit(String(messageId), { ...out, platform, chatId });
  }

  /** 出站路由（显式目标，含按钮/附件），供其他插件复用。 */
  async push(platform, chatId, out) {
    return this.send({ platform, chatId }, out);
  }

  // ── 入站管道（adapter → 核心） ───────────────────────────────────────────

  /**
   * 统一入站入口：adapter 构造 ImMessage 后调用。
   * 流程：去重 → 信任校验（FR-9.2）→ 会话映射（FR-2）→ 命令/派活（FR-3.1）。
   */
  async dispatchInbound(msg) {
    await this._ready;
    if (!msg || typeof msg.platform !== 'string' || typeof msg.chatId !== 'string') {
      this.log.warn('dropped malformed inbound message | 丢弃格式错误的入站消息: %o', msg);
      return;
    }
    const { platform, chatId, userId, text = '' } = msg;
    if (!this.channels.has(platform)) {
      this.log.warn(`inbound from unregistered platform "${platform}" ignored | 忽略来自未注册平台的消息`);
      return;
    }
    if (!this.map.dedupe(platform, msg.msgId)) return; // FR-1.4 幂等去重

    // FR-8.2：allowlist 之外的用户「可读不可写」→ 派活/命令一律拒绝（admins 隐式放行）
    if (!this.isAllowed(platform, userId)) {
      await this.trustGate(msg);
      return;
    }

    // 有文本 → 命令优先（FR-4.1：未知命令回 /help 摘要，不吞消息）
    const parsed = text ? parseCommand(text) : null;
    if (parsed && commands.has(parsed.name)) {
      await this.handleCommand(msg, parsed);
      return;
    }

    // 普通消息 → 派活
    await this.dispatchTask(msg);
  }

  /**
   * 按钮/回调统一入口（adapter 解析平台回调后调用）。
   * data 载荷约定：approve:<id>:yes|no / trust:<platform>:<userId> / retry:<sessionId>
   */
  async handleCallback({ platform, chatId, userId, userName, data }) {
    await this._ready;
    if (!data || typeof data !== 'string') return;
    const parts = data.split(':');
    const kind = parts[0];
    const reply = (text) => this.send({ platform, chatId }, { text }).catch(() => {});

    switch (kind) {
      case 'approve': {
        // 审批按钮回调身份校验（§10）：点按钮的人必须 ∈ allowlist
        if (!this.isAllowed(platform, userId)) {
          return reply(`⛔ 无权限：审批需要 allowlist 成员身份（当前 ${platform}:${userId} 未授权）。`);
        }
        const [, id, answer] = parts;
        const result = this.approvals.respond(id, answer, { platform, userId, userName });
        const texts = {
          accepted: `✅ 已批准 #${id}，agent 继续执行。`,
          rejected: `❌ 已拒绝 #${id}。`,
          ignored: `ℹ️ 审批 #${id} 已被响应或不存在。`,
          'not-found': `ℹ️ 审批 #${id} 不存在或已结束。`,
          forbidden: `⛔ 无权限。`,
        };
        return reply(texts[result] ?? `ℹ️ ${result}`);
      }
      case 'trust': {
        const [, targetPlatform, ...rest] = parts;
        const targetUserId = rest.join(':');
        if (!this.isAdmin(platform, userId)) {
          return reply('⛔ 仅管理员可信任用户。');
        }
        if (!targetPlatform || !targetUserId) return reply('用法：/trust <platform:userId>');
        this.map.addToAllowlist(targetPlatform, targetUserId);
        this.log.info(`admin ${platform}:${userId} trusted ${targetPlatform}:${targetUserId}`);
        return reply(`✅ 已信任 ${targetPlatform}:${targetUserId}，对方可开始派活。`);
      }
      case 'retry': {
        const sessionId = parts.slice(1).join(':');
        const text = this.lastUserTexts.get(sessionId);
        if (!text) return reply('ℹ️ 没有可重试的任务。');
        const agent = this.ctx.agents.get(sessionId);
        if (!agent) return reply('ℹ️ 会话不在线（重启后需先发一条消息恢复）。');
        agent.followup(this.userMessage(text));
        return reply('🔁 已重新提交任务。');
      }
      default:
        this.log.warn(`unknown callback data: "${data}"`);
    }
  }

  // ── 信任与授权（FR-9.2 / FR-8.2） ────────────────────────────────────────

  isAllowed(platform, userId) {
    return this.map.isAllowed(platform, userId);
  }

  isAdmin(platform, userId) {
    return this.map.isAdmin(platform, userId);
  }

  /** 首次接触：未知用户 → 信任确认（默认拒绝，但授权从改配置变成点一次确认）。 */
  async trustGate(msg) {
    const { platform, chatId, userId, userName } = msg;
    const cfg = this.cfg.security;

    // MVP 形态：trustOnFirstContact=true（个人自用）→ 自动信任
    if (cfg.trustOnFirstContact) {
      this.map.addToAllowlist(platform, userId);
      this.log.info(`trust-on-first-contact: auto-trusted ${platform}:${userId} | 首次接触：已自动信任 ${platform}:${userId}`);
      await this.send({ platform, chatId }, {
        text: `👋 首次接触，已自动信任 ${userName ?? userId}（security.trustOnFirstContact=true）。\n发送 /new 创建会话开始派活。`,
      });
      return;
    }

    // 有 admin → 推送管理员确认；否则提示配置
    const adminKeys = [...this.map.admins];
    if (adminKeys.length > 0) {
      const pending = `${platform}:${userId}`;
      this.log.info(`trust request from ${pending}, notifying admins`);
      for (const adminKey of adminKeys) {
        const admin = parseUserKey(adminKey);
        if (!admin) continue;
        await this.send({ platform: admin.platform, chatId: admin.userId }, {
          text: `🔐 信任确认：用户 ${userName ?? userId}（${platform}）想与 agent 对话。\n回复 /trust ${pending} 信任，或 /revoke ${pending} 拒绝。`,
          title: '🔐 信任确认',
          buttons: [{ id: `trust:${platform}:${userId}`, label: '✅ 信任', style: 'primary' }],
        }).catch(() => {});
      }
      await this.send({ platform, chatId }, {
        text: `⏳ 你尚未被授权（${platform}:${userId}）。已向管理员发送信任确认，请稍候。`,
      });
      return;
    }

    // 无 admin 也无自动信任：拒绝并给出配置指引（FR-9.3 /status 缺口提示），
    // 同时控制台提示管理员自己的一次性配置（普通用户无需碰配置）
    const pendingKey = `${platform}:${userId}`;
    this.log.warn(
      `untrusted inbound ${pendingKey}; no admins configured. To approve users by one tap, add yourself once: im.security.admins: ["${pendingKey}"] | `
      + `收到未授权消息 ${pendingKey}，且未配置管理员。想一键审批用户，请一次性在配置 im.security.admins 填入你自己的键：["${pendingKey}"]`
    );
    await this.send({ platform, chatId }, {
      text: `⛔ 当前未授权（${platform}:${userId}）。\n请管理员在配置中授权：\n  im.security.admins: ["${platform}:${userId}"]\n（只需管理员配置一次；之后新用户首条消息会推送一键信任确认，普通用户无需改任何配置。）`,
    });
  }

  // ── 派活（FR-3.1） ───────────────────────────────────────────────────────

  async dispatchTask(msg) {
    const { platform, chatId, userId, userName, text } = msg;
    const cfg = this.cfg.security;
    let binding = this.map.get(platform, chatId);

    // 新聊天默认不自动建 session（FR-2.3）
    if (!binding) {
      if (!cfg.autoCreate) {
        await this.send({ platform, chatId }, {
          text: '📝 当前未创建会话。\n发送 /new 创建会话后即可派活（或设置 security.autoCreate: true 自动创建）。',
        });
        return;
      }
      if (this.map.size >= cfg.maxSessions) {
        await this.send({ platform, chatId }, {
          text: `⛔ 会话数已达上限（${cfg.maxSessions}）。请用 /status 查看，或清理旧会话后重试。`,
        });
        return;
      }
      binding = this.createBinding(platform, chatId, msg.chatType ?? 'private');
    }

    this.map.touch(platform, chatId, userId, userName);

    // 附件：落盘 session 工作区 im-inbox/<chatId>/，文本附路径（FR-7.1 v1）
    let payload = text;
    if (msg.attachments?.length) {
      const inbox = join(this.storeDir, 'im-inbox', String(chatId));
      await mkdir(inbox, { recursive: true });
      const paths = [];
      for (const att of msg.attachments) {
        if (att.path) {
          try {
            const dest = join(inbox, `${Date.now()}-${att.name ?? 'file'}`);
            await copyFile(att.path, dest);
            paths.push(dest);
          } catch (err) {
            this.log.warn(`attachment copy failed | 附件保存失败: ${err.message}`);
          }
        } else if (att.url) {
          // v1 不主动下载远程 URL（SSRF 风险），留 v2 视觉桥
          this.log.warn('remote attachment url ignored (v2 vision bridge) | 远程附件 URL 暂不下载（v2 视觉桥）: %s', att.url);
        }
      }
      if (paths.length) {
        payload = payload ? `${payload}\n\n[附件已保存] ${paths.join('\n')}` : `[附件已保存]\n${paths.join('\n')}`;
      }
    }

    let agent = this.ctx.agents.get(binding.sessionId);
    if (!agent) {
      // DSH 重启后：优先恢复原会话（FR-2.2 / UC6），失败才新建
      agent = await this.tryResume(binding.sessionId);
      if (!agent) {
        agent = await this.createAgent(binding.sessionId);
      }
    }

    this.lastUserTexts.set(binding.sessionId, text);
    agent.followup(this.userMessage(payload));
    this.emit('im/dispatch', { sessionId: binding.sessionId, platform, chatId, text });
  }

  createBinding(platform, chatId, chatType) {
    return this.map.create(platform, chatId, { chatType });
  }

  async tryResume(sessionId) {
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: await this.agentOptions(),
      });
      return handle.agent;
    } catch (err) {
      this.log.warn(`resume ${sessionId} failed (will create fresh) | 恢复会话失败（将新建）: ${err.message}`);
      return null;
    }
  }

  async createAgent(sessionId) {
    const options = await this.agentOptions();
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.workspace() },
      agentOptions: options,
    });
    return handle.agent;
  }

  async agentOptions() {
    const cfg = this.cfg.agent;
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
    const defaultModel = this.ctx.get('agentDefaultModel');
    if (defaultModel && typeof defaultModel.get === 'function') {
      try {
        const m = await defaultModel.get();
        if (m?.provider && m?.model) return { provider: m.provider, model: m.model };
      } catch { /* fall through */ }
    }
    return { ...DEFAULT_MODEL, ...(cfg.provider ? { provider: cfg.provider } : {}), ...(cfg.model ? { model: cfg.model } : {}) };
  }

  workspace() {
    return this.cfg.agent.workspace || process.cwd();
  }

  /** 构造 UserMessage（dsh-llm 词汇；官方助手生成稳定 id，避免并发 followup 冲突）。 */
  userMessage(text) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
  }

  // ── 命令（FR-4） ─────────────────────────────────────────────────────────

  registerCommands() {
    const core = this;

    registerCommand('start', {
      perm: 'user',
      usage: '',
      desc: '创建新会话',
      descEn: 'create a new session',
      run: (c) => c.core.commandNew(c.msg),
    });
    registerCommand('new', {
      perm: 'user',
      usage: '',
      desc: '创建新会话',
      descEn: 'create a new session',
      run: (c) => c.core.commandNew(c.msg),
    });
    registerCommand('status', {
      perm: 'user',
      usage: '',
      desc: '当前会话、渠道连接、审批',
      descEn: 'sessions, channels, approvals',
      run: (c) => c.core.commandStatus(c.msg),
    });
    registerCommand('log', {
      perm: 'user',
      usage: '',
      desc: '把当前/上一任务完整输出发回（文件或长文本）',
      descEn: 'deliver the full output as file',
      run: (c) => c.core.commandLog(c.msg),
    });
    registerCommand('help', {
      perm: 'user',
      usage: '',
      desc: '命令与用法',
      descEn: 'show help',
      run: (c) => c.core.commandHelp(c.msg),
    });
    registerCommand('mute', {
      perm: 'user',
      usage: '',
      desc: '本聊天通知开关（关）',
      descEn: 'mute notifications for this chat',
      run: (c) => c.core.commandMute(c.msg, true),
    });
    registerCommand('unmute', {
      perm: 'user',
      usage: '',
      desc: '本聊天通知开关（开）',
      descEn: 'unmute notifications',
      run: (c) => c.core.commandMute(c.msg, false),
    });
    registerCommand('approve', {
      perm: 'user',
      usage: '<id> yes|no',
      desc: '文本方式审批（无按钮渠道降级路径）',
      descEn: 'approve/reject by text',
      run: (c, args) => c.core.commandApprove(c.msg, args),
    });
    registerCommand('trust', {
      perm: 'admin',
      usage: '<platform:userId>',
      desc: '信任用户（写入 allowlist）',
      descEn: 'trust a user',
      run: (c, args) => c.core.commandTrust(c.msg, args),
    });
    registerCommand('revoke', {
      perm: 'admin',
      usage: '<platform:userId>',
      desc: '撤销用户授权',
      descEn: 'revoke a user',
      run: (c, args) => c.core.commandRevoke(c.msg, args),
    });
    // 预留（v2）：/resume <id>、/attach <path>、/bind、/share
  }

  async handleCommand(msg, parsed) {
    const def = commands.get(parsed.name);
    const ctx = {
      msg,
      map: this.map,
      core: this,
    };
    const allowed = def.perm === 'admin'
      ? this.isAdmin(msg.platform, msg.userId)
      : this.isAllowed(msg.platform, msg.userId);
    if (!allowed) {
      await this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: `⛔ 命令 /${parsed.name} 需要 ${def.perm === 'admin' ? '管理员' : 'allowlist'} 权限。`,
      });
      return;
    }
    try {
      await def.run(ctx, parsed.args);
    } catch (err) {
      this.log.error(`command /${parsed.name} failed: %o`, err);
      await this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: `❌ 命令执行失败：${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => {});
    }
  }

  async commandNew(msg) {
    const { platform, chatId, userId } = msg;
    const cfg = this.cfg.security;
    const existing = this.map.get(platform, chatId);
    if (existing) {
      // 旧会话释放（历史日志保留在磁盘，/resume v2 可恢复）
      const oldAgent = this.ctx.agents.get(existing.sessionId);
      if (oldAgent && oldAgent.status !== 'idle') {
        await this.send({ platform, chatId }, { text: '⏳ 当前会话仍在运行，先等它结束或取消后再新建。' });
        return;
      }
      this.map.remove(platform, chatId);
    }
    if (this.map.size >= cfg.maxSessions) {
      await this.send({ platform, chatId }, {
        text: `⛔ 会话数已达上限（${cfg.maxSessions}）。请用 /status 查看，或清理旧会话后重试。`,
      });
      return;
    }
    const binding = this.createBinding(platform, chatId, msg.chatType ?? 'private');
    await this.createAgent(binding.sessionId);
    await this.send({ platform, chatId }, {
      text: `✅ 新会话已创建（${binding.sessionId}）。\n直接发送任务即可，例如：\n> 跑一下 tests 目录的 pytest`,
    });
  }

  async commandStatus(msg) {
    const { platform, chatId } = msg;
    const lines = ['📡 **渠道连接**'];
    for (const [p, ch] of this.channels) {
      const st = ch.status;
      const ok = !st || st.connected !== false;
      lines.push(`  ${ok ? '✅' : '❌'} ${p}${st?.detail ? ` (${st.detail})` : ''}`);
    }
    lines.push('', `💬 **会话** ${this.map.size}/${this.cfg.security.maxSessions}`);
    for (const s of this.map.list().slice(-5)) {
      lines.push(`  • ${s.platform}:${s.chatId} → ${s.sessionId}（${s.chatType}）`);
    }
    const pending = this.approvals.pendingList();
    lines.push('', `🔐 **审批** ${pending.length} 个等待中`);
    for (const p of pending.slice(-5)) {
      lines.push(`  • #${p.id} ${p.tool}（${p.state}，${p.ageSec}s）`);
    }
    const allowlist = [...this.map.allowlist];
    lines.push('', `👥 **allowlist** ${allowlist.length} 人`);
    if (allowlist.length > 5) lines.push(`  ${allowlist.slice(0, 5).join(', ')} …`);
    else if (allowlist.length) lines.push(`  ${allowlist.join(', ')}`);
    await this.send({ platform, chatId }, { text: lines.join('\n') });
  }

  async commandLog(msg) {
    const binding = this.map.get(msg.platform, msg.chatId);
    if (!binding) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 尚未创建会话。' });
    }
    const full = this._lastFullOutput.get(binding.sessionId);
    if (!full) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 暂无完整输出。' });
    }
    const channel = this.channels.get(msg.platform);
    if (channel && typeof channel.sendFile === 'function') {
      await channel.sendFile(binding.chatId, `im-${binding.sessionId}.md`, full, 'text/markdown');
      return;
    }
    // 无 sendFile 的渠道：长文本分段发送
    const chunks = splitLongText(markdownToText(full), { maxChunks: 6 });
    for (const chunk of chunks) {
      await this.send({ platform: msg.platform, chatId: msg.chatId }, { text: chunk });
    }
  }

  async commandHelp(msg) {
    await this.send({ platform: msg.platform, chatId: msg.chatId }, { text: helpText() });
  }

  async commandMute(msg, muted) {
    const binding = this.map.get(msg.platform, msg.chatId);
    if (!binding) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: 'ℹ️ 先创建会话（/new）。' });
    }
    binding.muted = muted;
    binding.mutedBy = `${msg.platform}:${msg.userId}`;
    await this.map.save();
    await this.send({ platform: msg.platform, chatId: msg.chatId }, {
      text: muted ? '🔕 本聊天通知已关闭（审批仍会推送）。' : '🔔 本聊天通知已开启。',
    });
  }

  async commandApprove(msg, args) {
    const [id, answer] = args;
    if (!id || !answer || !['yes', 'no'].includes(answer)) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, {
        text: '用法：/approve <id> yes|no（如 /approve a1b2c3d4 yes）',
      });
    }
    const result = this.approvals.respond(id, answer, {
      platform: msg.platform, userId: msg.userId, userName: msg.userName,
    });
    const texts = {
      accepted: `✅ 已批准 #${id}，agent 继续执行。`,
      rejected: `❌ 已拒绝 #${id}。`,
      ignored: `ℹ️ 审批 #${id} 已被响应或不存在。`,
      'not-found': `ℹ️ 审批 #${id} 不存在或已结束。`,
      forbidden: `⛔ 无权限：审批需要 allowlist 成员身份。`,
    };
    await this.send({ platform: msg.platform, chatId: msg.chatId }, { text: texts[result] ?? `ℹ️ ${result}` });
  }

  async commandTrust(msg, args) {
    const [raw] = args;
    const parsed = parseUserKey(raw, msg.platform);
    if (!parsed) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: '用法：/trust <platform:userId>' });
    }
    this.map.addToAllowlist(parsed.platform, parsed.userId);
    this.map.addAdmin(parsed.platform, parsed.userId);
    await this.send({ platform: msg.platform, chatId: msg.chatId }, {
      text: `✅ 已信任 ${parsed.key}（管理员）。对方可开始派活。`,
    });
  }

  async commandRevoke(msg, args) {
    const [raw] = args;
    const parsed = parseUserKey(raw, msg.platform);
    if (!parsed) {
      return this.send({ platform: msg.platform, chatId: msg.chatId }, { text: '用法：/revoke <platform:userId>' });
    }
    this.map.removeFromAllowlist(parsed.platform, parsed.userId);
    this.map.removeAdmin(parsed.platform, parsed.userId);
    await this.send({ platform: msg.platform, chatId: msg.chatId }, {
      text: `✅ 已撤销 ${parsed.key}。`,
    });
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  /** 追加式日志（approvals.log 等，FR-6.7）。 */
  async appendLog(kind, line) {
    try {
      await mkdir(this.storeDir, { recursive: true });
      await appendFile(join(this.storeDir, `${kind}.log`), JSON.stringify(line) + '\n', 'utf8');
    } catch (err) {
      this.log.warn(`append ${kind}.log failed: ${err.message}`);
    }
  }

  /** 内部事件（其他插件可复用：im/message、im/command、im/dispatch、im/approval）。 */
  emit(type, payload) {
    this.ctx.emit(`im/${type}`, payload);
  }

  /** /status 用：渠道连接状态。 */
  channelsStatus() {
    return [...this.channels.entries()].map(([p, ch]) => ({
      platform: p,
      connected: !ch.status || ch.status.connected !== false,
      detail: ch.status?.detail ?? '',
    }));
  }

  async dispose() {
    await this._ready;
    for (const d of this._dispose) d();
    this._dispose = [];
  }
}

export default ImRuntime;
export { name, inject, Config, sessionIdFor, chatKey, userKey };
export { MockChannel } from './mock-channel.js';
