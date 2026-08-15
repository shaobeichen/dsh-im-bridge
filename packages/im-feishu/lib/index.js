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

const name = 'im-feishu';
const inject = ['im'];

const Config = z.object({
  appId: z.string().default('env:FEISHU_APP_ID'),
  appSecret: z.string().default('env:FEISHU_APP_SECRET'),
  debug: z.boolean().default(false), // 打印收到的每个事件/入站/出站结果（排障用）
  logLevel: z.string().default('warn'), // SDK 日志级别（'error'|'warn'|'info'|'debug'）
});

/** 解析密钥引用：'env:NAME' → process.env.NAME。 */
export function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? '';
  }
  return value;
}

export function apply(ctx, config = {}, internals = {}) {
  const appId = resolveSecret(config.appId);
  const appSecret = resolveSecret(config.appSecret);
  const debug = config.debug === true;
  const logger = ctx.logger?.(name) ?? console;
  const log = (level, ...args) => {
    if (debug || level !== 'debug') logger[level](...args);
  };
  // 可注入的依赖（测试用）：sdk = { Client, WSClient, EventDispatcher, LoggerLevel }
  const sdk = internals.sdk ?? lark;

  const logLevel = config.logLevel ?? 'warn';
  /** chatId → receive_id_type（'chat_id' | 'open_id'），入站时学习 */
  const chatIdKinds = new Map();

  let client = null;
  let dispatcher = null;
  let wsClient = null;
  let disposed = false;

  const channel = {
    platform: 'feishu',
    displayName: '飞书',
    status: {
      connected: false,
      detail: appId && appSecret ? 'starting' : 'missing appId/appSecret',
      lastEventAt: null, // 收到任何事件的时间戳（可观测性：连接活着 ≠ 事件在流）
    },
    send,
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

  if (!appId || !appSecret) {
    // FR-9.3：缺凭据 = 优雅断开，不崩启动；/status 会显示缺口
    logger.error('dsh-im-feishu: missing appId/appSecret (set FEISHU_APP_ID / FEISHU_APP_SECRET); channel stays disconnected');
    return () => channel.dispose();
  }

  client = new sdk.Client({ appId, appSecret, loggerLevel: sdk.LoggerLevel?.[logLevel] });
  dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel?.[logLevel] });

  dispatcher.register({
    'im.message.receive_v1': (data) => handleMessage(data),
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
      channel.status = { connected: true, detail: 'long connection ready' };
      logger.info('dsh-im-feishu: long connection ready');
    },
    onError: (err) => {
      if (disposed) return;
      channel.status = { connected: false, detail: `ws error: ${err?.message ?? err}` };
      logger.error('dsh-im-feishu: %s', err?.message ?? err);
    },
  });
  wsClient.start({ eventDispatcher: dispatcher }).catch((err) => {
    if (disposed) return;
    channel.status = { connected: false, detail: `start failed: ${err?.message ?? err}` };
    logger.error('dsh-im-feishu: start failed: %s', err?.message ?? err);
  });

  return () => channel.dispose();

  // ── 入站 ─────────────────────────────────────────────────────────────────

  function handleMessage(data) {
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
    const openId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '';
    const text = parseMessageContent(message);
    void im.dispatchInbound({
      platform: 'feishu',
      chatId,
      userId: String(openId),
      userName: sender.sender_id?.open_id ?? '',
      text,
      msgId: String(message.message_id ?? ''),
      chatType,
    }).catch((err) => logger.warn('dsh-im-feishu: inbound dispatch failed: %s', err?.message ?? err));
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
    }).catch((err) => logger.warn('dsh-im-feishu: callback failed: %s', err?.message ?? err));
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
      await sendCard(receiveId, receiveIdType, out);
      return {};
    }
    if (out.text) {
      try {
        const r = await client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: out.text }) },
        });
        if (debug) logger.info('dsh-im-feishu: text sent to %s (%s) ok=%s', receiveId, receiveIdType, r?.code === 0);
      } catch (err) {
        logger.error('dsh-im-feishu: send text to %s failed: %s (code=%s msg=%s)', receiveId, err?.message ?? err, err?.code, err?.msg);
        throw err;
      }
    }
    return {};
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
      header: { title: { tag: 'plain_text', content: '🔐 审批请求' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: out.text } },
        { tag: 'action', actions },
      ],
    };
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
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
