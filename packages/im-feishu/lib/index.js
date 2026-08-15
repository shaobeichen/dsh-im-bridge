// dsh-im-feishu 渠道适配器
//
// 基于官方 SDK @larksuiteoapi/node-sdk：
//   - WSClient（长连接接收事件，免公网；心跳/断线重连由 SDK 内置，FR-1.5）
//   - Client.im.message.create / im.file.create（发文本、审批卡片、文件）
//
// 需要企业自建应用（长连接仅支持自建应用）：
//   1. 开放平台 open.feishu.cn/app 创建应用，开启「机器人」能力
//   2. 凭证与基础信息 → App ID / App Secret
//   3. 添加事件订阅：im.message.receive_v1（接收消息）、card.action.trigger（卡片按钮）
//   4. 发布版本，并把机器人加到可用范围/群里
//
// 密钥：appId/appSecret 支持 "env:FEISHU_APP_ID" / "env:FEISHU_APP_SECRET" 引用（§9）。

import z from '@deepseek-ai/schemastery';
import * as lark from '@larksuiteoapi/node-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { installFeishuWebRpc } from './web-rpc.js';
import { createFeishuProvisionSession } from './provision.js';

const name = 'im-feishu';
// connection 不是硬依赖：web 设置页签（扫码接入）需要它，但无 Connection RPC 的
// 运行器组合（demo/feishu-real.mjs 的裸 Context）必须照样激活——installFeishuWebRpc
// 会优雅降级。曾作为 inject 硬依赖导致此类组合里插件永远等待、apply 不执行。
const inject = ['im'];

/** 流式卡片正文上限（lark_md 字段限制内取保守值）。 */
const STREAM_TAIL_CHARS = 2800;
const STREAM_TITLE = 'DeepSeek Harness ⏳ 执行中';

const Config = z.object({
  appId: z.string().default('env:FEISHU_APP_ID'),
  appSecret: z.string().default('env:FEISHU_APP_SECRET'),
  debug: z.boolean().default(false), // 打印收到的每个事件/入站/出站结果（排障用）
  logLevel: z.string().default('warn'), // SDK 日志级别（'error'|'warn'|'info'|'debug'）
  /** 群聊仅回复 @机器人 的消息（私聊不受影响）。默认 true。 */
  groupMentionOnly: z.boolean().default(true),
});

/** env 变量名 → 扫码凭据文件字段（bin/feishu-qr.mjs 的产物）。 */
const ENV_CRED_FIELDS = { FEISHU_APP_ID: 'appId', FEISHU_APP_SECRET: 'appSecret' };
/** 扫码接入产物路径（相对 $DSH_HOME）。 */
export const QR_CREDENTIALS_REL = join('dsh-im', 'feishu-credentials.json');

/**
 * 解析密钥引用：'env:NAME' → 环境变量；环境变量为空时回退扫码接入产物
 * （$DSH_HOME/dsh-im/feishu-credentials.json，由 dsh-im-feishu-qr 写入）。
 * 环境变量优先，扫码只是缺省回退，两种方式共存。
 */
export function resolveSecret(value, { home, read = readFileSync, env = process.env } = {}) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const envName = value.slice(4);
    const fromEnv = env[envName];
    if (fromEnv) return fromEnv;
    const credFile = join(home ?? env.DSH_HOME ?? join(homedir(), '.dsh'), QR_CREDENTIALS_REL);
    try {
      const creds = JSON.parse(read(credFile, 'utf8'));
      return creds[ENV_CRED_FIELDS[envName]] ?? '';
    } catch {
      return ''; // 无凭据文件：回到「缺凭据 → 优雅断开」
    }
  }
  return value;
}

/** 消息是否 @ 了机器人本人（mentions 条目 key / id.open_id 命中 botOpenId）。 */
export function isBotMentioned(message, botOpenId) {
  if (!botOpenId) return false;
  const list = Array.isArray(message?.mentions) ? message.mentions : [];
  return list.some((m) => (m?.key ?? '') === botOpenId || (m?.id?.open_id ?? '') === botOpenId);
}

/**
 * 清理飞书文本里的 @_user_N 占位符：
 * - 指代机器人自己的 → 移除
 * - 其他被 @ 用户 → 替换为「@昵称」（无昵称则移除）
 * mentions 数组下标 N-1 对应 @_user_N（飞书文本占位约定）。
 */
export function cleanMentions(text, mentions, botOpenId) {
  if (typeof text !== 'string' || !text) return text;
  const list = Array.isArray(mentions) ? mentions : [];
  return text.replace(/@_user_(\d+)/g, (whole, idxRaw) => {
    const m = list[Number(idxRaw) - 1];
    const key = m?.key ?? m?.id?.open_id ?? '';
    const name = m?.name ?? '';
    if (botOpenId && key === botOpenId) return '';
    return name ? `@${name}` : '';
  }).replace(/ {2,}/g, ' ').trim();
}

export function apply(ctx, config = {}, internals = {}) {
  const appId = resolveSecret(config.appId);
  const appSecret = resolveSecret(config.appSecret);
  const debug = config.debug === true;
  const logger = ctx.logger?.(name) ?? console;
  const log = (level, ...args) => {
    if (debug || level !== 'debug') logger[level](...args);
  };
  // 可注入的依赖（测试用）：sdk = { Client, WSClient, EventDispatcher, LoggerLevel }；
  // fetchImpl = 群聊 @ 判定用的机器人身份查询载体（bot/v3/info）；botOpenId 可直接注入跳过查询。
  const sdk = internals.sdk ?? lark;
  const fetchImpl = internals.fetchImpl ?? fetch;

  const logLevel = config.logLevel ?? 'warn';
  /** chatId → receive_id_type（'chat_id' | 'open_id'），入站时学习 */
  const chatIdKinds = new Map();

  let client = null;
  let dispatcher = null;
  let wsClient = null;
  let disposed = false;
  /** 机器人自身 open_id（群聊 @ 判定用；懒加载，失败可重试） */
  let botOpenId = typeof internals.botOpenId === 'string' && internals.botOpenId ? internals.botOpenId : null;
  let botInfoPromise = null;

  const channel = {
    platform: 'feishu',
    displayName: '飞书',
    status: {
      connected: false,
      detail: appId && appSecret ? 'starting' : 'missing appId/appSecret',
      lastEventAt: null, // 收到任何事件的时间戳（可观测性：连接活着 ≠ 事件在流）
    },
    send,
    edit,
    sendFile,
    dispose: async () => {
      disposed = true;
      try {
        wsClient?.close();
      } catch { /* 忽略 */ }
      wsClient = null;
    },
  };
  ctx.get('im').registerChannel(channel);

  // Web 设置页签（扫码接入）：浏览器 ⇄ Host loopback RPC；无凭据也能扫码建应用。
  // 凭据只写 Host 本机文件，App Secret 不进浏览器。
  const provisionSession = internals.provisionSession ?? createFeishuProvisionSession({ lark: sdk });
  const disposeRpc = installFeishuWebRpc(ctx, {
    session: provisionSession,
    getStatus: () => channel.status,
    log: logger,
  });
  const disposeAll = () => {
    disposeRpc();
    provisionSession.cancel();
    return channel.dispose();
  };

  if (!appId || !appSecret) {
    // FR-9.3：缺凭据 = 优雅断开，不崩启动；/status 会显示缺口
    logger.error('dsh-im-feishu: missing appId/appSecret — scan to connect in Settings → 飞书, or set FEISHU_APP_ID / FEISHU_APP_SECRET; channel stays disconnected | 缺少 appId/appSecret：可在网页设置「飞书」页扫码接入，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET，通道保持断开');
    return disposeAll;
  }

  client = new sdk.Client({ appId, appSecret, loggerLevel: sdk.LoggerLevel?.[logLevel] });
  dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel?.[logLevel] });

  dispatcher.register({
    'im.message.receive_v1': (data) => {
      void handleMessage(data).catch((err) => logger.warn('dsh-im-feishu: message handler failed | 消息处理失败: %s', err?.message ?? err));
    },
    'card.action.trigger': (data) => handleCardAction(data),
  });
  if (debug) logger.info('dsh-im-feishu: event handlers registered (im.message.receive_v1 / card.action.trigger)');
  wsClient = new sdk.WSClient({
    appId,
    appSecret,
    loggerLevel: sdk.LoggerLevel?.[logLevel],
    autoReconnect: true,
    onReady: () => {
      if (disposed) return;
      channel.status = { connected: true, detail: 'long connection ready | 长连接已就绪' };
      logger.info('dsh-im-feishu: long connection ready | 长连接已就绪');
    },
    onError: (err) => {
      if (disposed) return;
      channel.status = { connected: false, detail: `ws error: ${err?.message ?? err}` };
      logger.error('dsh-im-feishu: %s', err?.message ?? err);
    },
  });
  wsClient.start({ eventDispatcher: dispatcher }).catch((err) => {
    if (disposed) return;
    channel.status = { connected: false, detail: `start failed | 启动失败: ${err?.message ?? err}` };
    logger.error('dsh-im-feishu: start failed | 启动失败: %s', err?.message ?? err);
  });

  return disposeAll;

  // ── 入站 ─────────────────────────────────────────────────────────────────

  /** 机器人身份懒加载：bot/v3/info → open_id；失败返回 null（下次群消息重试）。 */
  async function ensureBotOpenId() {
    if (botOpenId) return botOpenId;
    if (!botInfoPromise) {
      botInfoPromise = fetchBotInfo().then((id) => {
        botOpenId = id;
        logger.info('dsh-im-feishu: bot identity resolved | 机器人身份已解析');
        return id;
      }).catch((err) => {
        logger.warn('dsh-im-feishu: bot info fetch failed | 机器人身份查询失败: %s', err?.message ?? err);
        botInfoPromise = null; // 允许下次重试
        return null;
      });
    }
    return botInfoPromise;
  }

  /** 官方 REST：租户 token + bot/v3/info（SDK 无公开 bot 信息方法，直接走平台 API）。 */
  async function fetchBotInfo() {
    const tokenRes = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenJson = await tokenRes.json();
    const token = tokenJson?.tenant_access_token;
    if (!token) throw new Error(`tenant token failed: ${JSON.stringify(tokenJson).slice(0, 120)}`);
    const infoRes = await fetchImpl('https://open.feishu.cn/open-apis/bot/v3/info', {
      headers: { authorization: `Bearer ${token}` },
    });
    const infoJson = await infoRes.json();
    const openId = infoJson?.bot?.open_id;
    if (!openId) throw new Error(`bot info missing open_id: ${JSON.stringify(infoJson).slice(0, 120)}`);
    return openId;
  }

  async function handleMessage(data) {
    const im = ctx.get('im');
    const message = data?.message;
    if (!message) return;
    const sender = data?.sender ?? {};
    channel.status.lastEventAt = Date.now();
    if (debug) logger.info('dsh-im-feishu: event=%s msgId=%s chatId=%s type=%s sender_type=%s', data?.event_type ?? '?', message.message_id, message.chat_id, message.message_type, sender.sender_type);
    // 忽略机器人自己发的消息
    if (sender.sender_type === 'bot') return;
    const chatId = String(message.chat_id ?? '');
    const chatType = message.chat_type === 'p2p' ? 'private' : 'group';
    chatIdKinds.set(chatId, 'chat_id');

    // 群聊 @ 过滤：只有手动 @ 机器人的消息才回复（私聊不受影响）
    if (chatType === 'group' && config.groupMentionOnly !== false) {
      const botId = await ensureBotOpenId();
      if (!botId) {
        // 身份未知无法校验 @：失败关闭（skip），宁可漏回也不在群里刷屏
        logger.warn('dsh-im-feishu: skipping group message — bot identity unavailable, cannot verify @mention | 跳过群消息：机器人身份未知，无法校验 @');
        return;
      }
      if (!isBotMentioned(message, botId)) {
        if (debug) logger.info('dsh-im-feishu: skipping group message without @mention (chatId=%s) | 群消息未 @ 机器人，跳过', chatId);
        return;
      }
    }

    const openId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '';
    const text = cleanMentions(parseMessageContent(message), message.mentions, botOpenId);
    void im.dispatchInbound({
      platform: 'feishu',
      chatId,
      userId: String(openId),
      userName: sender.sender_id?.open_id ?? '',
      text,
      msgId: String(message.message_id ?? ''),
      chatType,
    }).catch((err) => logger.warn('dsh-im-feishu: inbound dispatch failed | 入站消息处理失败: %s', err?.message ?? err));
  }

  function handleCardAction(data) {
    const im = ctx.get('im');
    const value = data?.action?.value ?? {};
    const operator = data?.operator ?? {};
    const openId = operator.open_id ?? operator.user_id ?? '';
    const chatId = data?.context?.open_chat_id ?? data?.open_chat_id ?? openId;
    channel.status.lastEventAt = Date.now();
    if (debug) logger.info('dsh-im-feishu: card callback action=%s id=%s by=%s', value.action, value.id, openId);
    if (!value.action) return;
    chatIdKinds.set(chatId, String(chatId).startsWith('oc_') ? 'chat_id' : 'open_id');
    void im.handleCallback({
      platform: 'feishu',
      chatId: String(chatId),
      userId: String(openId),
      userName: operator.name ?? openId,
      data: `${value.action}:${value.id ?? ''}:${value.answer ?? ''}`,
    }).catch((err) => logger.warn('dsh-im-feishu: callback failed | 回调处理失败: %s', err?.message ?? err));
  }

  // ── 出站 ─────────────────────────────────────────────────────────────────

  /** receive_id_type 判定：入站学习的类型优先；否则按 id 前缀启发（ou_=open_id，oc_=chat_id）。 */
  function kindFor(chatId) {
    const s = String(chatId);
    const known = chatIdKinds.get(s);
    if (known) return known;
    if (s.startsWith('ou_') || s.startsWith('on_') || s.startsWith('oi_')) return 'open_id';
    return 'chat_id';
  }

  async function send(out) {
    const receiveId = out.chatId;
    const receiveIdType = kindFor(receiveId);
    if (out.buttons?.length) {
      const r = await sendCard(receiveId, receiveIdType, out);
      return { messageId: r?.data?.message_id };
    }
    if (out.stream) {
      const r = await sendStreamCard(receiveId, receiveIdType, out);
      return { messageId: r?.data?.message_id };
    }
    if (out.text) {
      const r = await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: out.text }) },
      });
      ensureOk(r, `text to ${receiveId}`);
      if (debug) logger.info('dsh-im-feishu: text sent to %s (%s) ok=%s', receiveId, receiveIdType, r?.code === 0);
      return { messageId: r?.data?.message_id };
    }
    return {};
  }

  /** 流式原地更新（打字机体验）：核心发首帧后持 messageId 连续调用本方法。 */
  async function edit(messageId, out) {
    const r = await client.im.message.patch({
      path: { message_id: String(messageId) },
      data: { content: JSON.stringify(buildStreamCard(out)) },
    });
    ensureOk(r, `patch ${messageId}`);
    return {};
  }

  /** 业务失败（code != 0）必须抛出并带平台错误码——绝不静默吞掉（AGENTS.md 可观测三件套）。 */
  function ensureOk(r, what) {
    if (!r || r.code !== 0) {
      const err = new Error(`feishu ${what} failed: code=${r?.code ?? 'n/a'} msg=${r?.msg ?? String(r)}`);
      err.code = r?.code;
      err.msg = r?.msg;
      throw err;
    }
  }

  /** 流式卡片：lark_md 正文 + 实时提示脚注。核心已做尾部截断，这里再兜底一次。 */
  function buildStreamCard(out) {
    const text = String(out.text ?? '').slice(-STREAM_TAIL_CHARS);
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: out.title ?? STREAM_TITLE }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: text || '…' } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '🔄 实时输出中 · 完整结果：回复 /log' }] },
      ],
    };
  }

  async function sendStreamCard(receiveId, receiveIdType, out) {
    const r = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(buildStreamCard(out)) },
    });
    ensureOk(r, `stream card to ${receiveId}`);
    return r;
  }

  async function sendCard(receiveId, receiveIdType, out) {
    const actions = out.buttons.map((b) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label },
      type: b.style === 'danger' ? 'danger' : b.style === 'primary' ? 'primary' : 'default',
      value: parseButtonValue(b.id),
    }));
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: out.title ?? '🔐 审批请求' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: out.text } },
        { tag: 'action', actions },
      ],
    };
    const r = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    ensureOk(r, `card to ${receiveId}`);
    return r;
  }

  /** 按钮 id（approve:<id>:yes）→ 卡片 value（回调原样回传）。 */
  function parseButtonValue(id) {
    const parts = String(id).split(':');
    return { action: parts[0] ?? '', id: parts[1] ?? '', answer: parts[2] ?? '' };
  }

  /** 文件消息（/log 全量交付，FR-3.4）：上传文件 → 发 file 消息。 */
  async function sendFile(chatId, fileName, text) {
    const receiveIdType = kindFor(chatId);
    const upload = await client.im.file.create({
      data: { file_type: 'stream', file_name: fileName, file: Buffer.from(text, 'utf8') },
    });
    const fileKey = upload?.file_key;
    if (!fileKey) throw new Error('feishu file upload failed');
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    });
  }
}

/** 解析飞书消息内容（text / post / file / image / interactive）。 */
export function parseMessageContent(message) {
  if (!message?.content) return '';
  let obj;
  try {
    obj = JSON.parse(message.content);
  } catch {
    return String(message.content);
  }
  if (message.message_type === 'text') return typeof obj?.text === 'string' ? obj.text : '';
  if (message.message_type === 'post' && obj?.post) {
    const body = obj.post.zh_cn ?? obj.post.en_us ?? {};
    const lines = (body.content ?? []).map((row) =>
      row.map((seg) => (seg?.tag === 'text' ? seg.text : seg?.tag === 'a' ? `${seg.text} (${seg.href})` : seg?.text ?? '')).join('')
    );
    return lines.join('\n');
  }
  if (message.message_type === 'file') return `[文件] ${obj?.file_name ?? ''}`.trim();
  if (message.message_type === 'image') return '[图片]';
  if (message.message_type === 'interactive') return '[交互卡片]';
  return JSON.stringify(obj).slice(0, 500);
}

export { name, inject, Config };
export default { name, inject, Config, apply };
export const plugin = { name, inject, Config, apply };
