// dsh-im-weixin 渠道适配器（腾讯 iLink 个人微信机器人，官方协议）
//
// 连接方式：ilink/bot/getupdates 长轮询（免公网，无需隧道/回调 URL）。
// 入站：微信消息 → ImMessage（仅文本，以及微信自带转写的语音）；
// 出站：文本（微信无原生审批按钮，核心层会自动降级为文本审批）。
//
// 前提（平台硬性要求，插件无法绕过）：
//   手机微信账号必须已获得「微信机器人」功能（我 → 设置 → 插件 有入口）。
//   腾讯分批开放，账号无入口时扫码会失败或连不上。
//
// 密钥：botToken/ownerUserId 支持 "env:WECHAT_BOT_TOKEN" / "env:WECHAT_OWNER_USER_ID"；
//   未设置时回退扫码接入产物（$DSH_HOME/dsh-im/weixin-credentials.json，
//   由 bin/weixin-qr.mjs 写入）。环境变量优先。

import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { createWeixinApi, extractWeixinText, weixinMessageId, splitWeixinText, normalizeWeixinApiBaseUrl } from './weixin-api.js';
import { installWeixinWebRpc } from './web-rpc.js';
import { createWeixinBindSession } from './provision.js';

const name = 'im-weixin';
// connection 不是硬依赖：web 设置页签（扫码绑定）需要它，但无 Connection RPC 的
// 运行器组合必须照样激活——installWeixinWebRpc 会优雅降级（与 dsh-im-feishu 同因修复）。
const inject = ['im'];

const Config = z.object({
  botToken: z.string().default('env:WECHAT_BOT_TOKEN'),
  ownerUserId: z.string().default('env:WECHAT_OWNER_USER_ID'),
  baseUrl: z.string().default('https://ilinkai.weixin.qq.com/'),
  debug: z.boolean().default(false),
});

/** env 变量名 → 扫码凭据文件字段（bin/weixin-qr.mjs 的产物）。 */
const ENV_CRED_FIELDS = { WECHAT_BOT_TOKEN: 'botToken', WECHAT_OWNER_USER_ID: 'ownerUserId' };
/** 扫码接入产物路径（相对 $DSH_HOME）。 */
export const QR_CREDENTIALS_REL = join('dsh-im', 'weixin-credentials.json');

/**
 * 解析密钥引用：'env:NAME' → 环境变量；为空时回退扫码凭据文件。
 * env 可注入（测试传空对象，避免宿主环境变量干扰）。
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
      return '';
    }
  }
  return value;
}

/** 从配置文件读取 baseUrl（扫码 confirmed 响应里的服务端地址，域名可能重定向）。 */
export function resolveBaseUrl(configBase, { home, read = readFileSync, env = process.env } = {}) {
  const credFile = join(home ?? env.DSH_HOME ?? join(homedir(), '.dsh'), QR_CREDENTIALS_REL);
  try {
    const creds = JSON.parse(read(credFile, 'utf8'));
    if (creds.baseUrl) return normalizeWeixinApiBaseUrl(creds.baseUrl);
  } catch { /* 无文件则用配置默认 */ }
  return configBase;
}

export function apply(ctx, config = {}, internals = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const log = (level, ...args) => {
    if (config.debug || level !== 'debug') logger[level](...args);
  };
  // 可注入依赖（测试）：fetchImpl（假 iLink 服务器）、home/read/env（凭据解析隔离）
  const api = internals.api ?? createWeixinApi({ fetchImpl: internals.fetchImpl ?? fetch });
  const home = internals.home;
  const read = internals.read;
  const env = internals.env;

  const botToken = resolveSecret(config.botToken, { home, read, env });
  const ownerUserId = resolveSecret(config.ownerUserId, { home, read, env });
  const baseUrl = resolveBaseUrl(config.baseUrl, { home, read, env });

  let disposed = false;
  let controller = null;

  const channel = {
    platform: 'weixin',
    displayName: '微信',
    status: {
      connected: false,
      detail: botToken ? 'starting' : 'missing bot token (扫码接入：npx -y dsh-im-weixin-qr) | 缺少 bot token',
      lastEventAt: null, // 最近事件心跳（可观测三件套）
    },
    send,
    dispose: async () => {
      disposed = true;
      controller?.abort();
      if (botToken) {
        api.notifyStop({ baseUrl, token: botToken, signal: controller?.signal }).catch(() => {});
      }
    },
  };
  ctx.get('im').registerChannel(channel);

  // Web 设置页签（扫码绑定）：浏览器 ⇄ Host loopback RPC；无凭据也能扫码绑定。
  const bindSession = internals.bindSession ?? createWeixinBindSession({ api, home });
  const disposeRpc = installWeixinWebRpc(ctx, {
    session: bindSession,
    getStatus: () => channel.status,
    log: logger,
  });
  const disposeAll = () => {
    disposeRpc();
    bindSession.cancel();
    return channel.dispose();
  };

  if (!botToken) {
    logger.error('dsh-im-weixin: missing bot token — scan to bind in Settings → 微信, run `npx -y dsh-im-weixin-qr`, or set WECHAT_BOT_TOKEN; channel stays disconnected | 缺少 bot token：可在网页设置「微信」页扫码绑定，或运行 `npx -y dsh-im-weixin-qr`，或设置 WECHAT_BOT_TOKEN，通道保持断开');
    return disposeAll;
  }

  // ── 长轮询主循环 ────────────────────────────────────────────────────────
  controller = new AbortController();
  let buf = '';
  let started = false;

  const loop = async () => {
    let backoffMs = 1_000;
    while (!disposed && !controller.signal.aborted) {
      try {
        const res = await api.getUpdates({
          baseUrl,
          token: botToken,
          getUpdatesBuf: buf,
          signal: controller.signal,
        });
        buf = typeof res.get_updates_buf === 'string' ? res.get_updates_buf : buf;
        if (!started) {
          started = true;
          channel.status = { connected: true, detail: 'long-poll active | 长轮询运行中', lastEventAt: channel.status.lastEventAt };
          logger.info('dsh-im-weixin: long-poll active | 长轮询运行中');
        }
        backoffMs = 1_000;
        for (const msg of res.msgs ?? []) {
          await handleMessage(msg);
        }
      } catch (err) {
        if (disposed || controller.signal.aborted) return;
        channel.status = { connected: false, detail: `poll error: ${err?.code ?? err?.message ?? err}`, lastEventAt: channel.status.lastEventAt };
        log('warn', 'dsh-im-weixin: getupdates error %s (code=%s), retry in %sms | 拉取消息失败，%sms 后重试', err?.message ?? err, err?.code ?? '-', backoffMs, backoffMs);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  };

  // 先 notifystart（协议要求：启动推送前先验证），再进长轮询
  void (async () => {
    try {
      await api.notifyStart({ baseUrl, token: botToken, signal: controller.signal });
      log('debug', 'dsh-im-weixin: notifystart ok');
    } catch (err) {
      if (disposed || controller.signal.aborted) return;
      channel.status = { connected: false, detail: `notifystart failed: ${err?.message ?? err}（可能账号未获微信机器人功能：检查 我→设置→插件）`, lastEventAt: channel.status.lastEventAt };
      logger.error('dsh-im-weixin: notifystart failed | 启动推送失败: %s', err?.message ?? err);
      return;
    }
    void loop();
  })();

  return disposeAll;

  // ── 入站 ────────────────────────────────────────────────────────────────

  async function handleMessage(msg) {
    const fromUserId = msg?.from_user_id;
    if (!fromUserId || fromUserId === 'wxid_ilinkbot') return; // 系统/机器人自身消息
    const text = extractWeixinText(msg);
    const msgId = weixinMessageId(msg);
    if (!text && !msgId) return;
    channel.status = { connected: true, detail: 'long-poll active | 长轮询运行中', lastEventAt: Date.now() };
    log('debug', 'dsh-im-weixin: inbound from=%s id=%s text=%s', fromUserId, msgId, String(text).slice(0, 60));
    await ctx.get('im').dispatchInbound({
      platform: 'weixin',
      chatId: fromUserId,
      userId: fromUserId,
      userName: msg?.from_user_name ?? '',
      text: text ?? '',
      msgId,
      chatType: 'private',
      contextToken: msg?.context_token ?? '',
    });
  }

  // ── 出站 ────────────────────────────────────────────────────────────────

  async function send(out) {
    const chatId = String(out.chatId);
    const text = String(out.text ?? '');
    if (!text) return { ok: true };
    // 微信无原生按钮：核心层审批会降级为文本（/approve <id> yes），直接发文本
    for (const chunk of splitWeixinText(text)) {
      try {
        await api.sendText({ baseUrl, token: botToken, toUserId: chatId, text: chunk, signal: controller?.signal });
      } catch (err) {
        log('error', 'dsh-im-weixin: send failed to=%s (code=%s) | 发送失败', chatId, err?.code ?? err?.message ?? err);
        throw err;
      }
    }
    return { ok: true };
  }
}

export { name, inject, Config };
export default { name, inject, Config, apply };
export const plugin = { name, inject, Config, apply };
