// dsh-im-wecom 企业微信适配器
//
// 关键差异（vs 飞书/Telegram）：
//   1. 企微自建应用【没有长连接/轮询收消息】——只能走「回调 URL + 消息加解密」，
//      必须有一个公网 HTTPS 地址穿透到本地端口（ngrok / cloudflared / caddy）。
//   2. 企微应用消息【没有交互按钮】——审批走文本降级 `/approve <id> yes|no`
//      （FR-6.2 降级路径）。send() 遇到 buttons 会忽略并在文本里提示。
//
// 协议：
//   - 接收：企微 POST 加密 XML 到 /wecom，验签（sha1(sort(token,ts,nonce,msg))）
//     + AES-CBC 解密（EncodingAESKey），5 秒内响应 "success"
//   - URL 验证：GET /wecom?echostr=... 解密后原样返回
//   - 发送：/cgi-bin/message/send 应用消息（touser=userid）
//   - 文件：/cgi-bin/media/upload 上传 → file 消息
//   - access_token：/cgi-bin/gettoken 获取并缓存（2h 过期）
//
// 密钥一律 env: 引用（AGENTS.md 规则 #6）。加解密用官方 @wecom/crypto。

import z from '@deepseek-ai/schemastery';
import { createServer } from 'node:http';
import { wecomDecrypt, wecomSignature } from './crypto.js';

const name = 'im-wecom';
const inject = ['im'];

const Config = z.object({
  corpid: z.string().default('env:WECOM_CORP_ID'),
  agentId: z.string().default('env:WECOM_AGENT_ID'),
  secret: z.string().default('env:WECOM_SECRET'),
  callbackToken: z.string().default('env:WECOM_CALLBACK_TOKEN'),
  encodingAESKey: z.string().default('env:WECOM_ENCODING_AES_KEY'),
  port: z.number().default(8787),           // 本地接收服务器端口（公网穿透指向它）
  apiBase: z.string().default('https://qyapi.weixin.qq.com'),
  debug: z.boolean().default(false),       // 打印入站/出站详情（排障用）
});

/** 解析密钥引用：'env:NAME' → process.env.NAME。 */
export function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? '';
  }
  return value;
}

export function apply(ctx, config = {}, internals = {}) {
  const corpid = resolveSecret(config.corpid);
  const agentId = resolveSecret(config.agentId);
  const secret = resolveSecret(config.secret);
  const callbackToken = resolveSecret(config.callbackToken);
  const encodingAESKey = resolveSecret(config.encodingAESKey);
  const logger = ctx.logger?.(name) ?? console;
  const api = config.apiBase ?? 'https://qyapi.weixin.qq.com';
  const debug = config.debug === true;
  const fetchImpl = internals.fetchImpl ?? globalThis.fetch?.bind(globalThis);

  const creds = { corpid, agentId, secret, callbackToken, encodingAESKey };
  const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);

  let server = null;
  let disposed = false;
  let tokenCache = { value: '', expireAt: 0 };

  const channel = {
    platform: 'wecom',
    displayName: '企业微信',
    status: {
      connected: false,
      detail: missing.length ? `missing credentials: ${missing.join(',')}` : 'starting',
      lastEventAt: null,
    },
    send,
    sendFile,
    dispose: async () => {
      disposed = true;
      if (server) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
        server = null;
      }
    },
  };
  ctx.get('im').registerChannel(channel);

  if (missing.length) {
    logger.error(`dsh-im-wecom: missing ${missing.join(', ')}; channel stays disconnected | 缺少凭据：${missing.join(', ')}，通道保持断开`);
    return () => channel.dispose();
  }

  // ── 本地接收服务器（需公网穿透） ──────────────────────────────────────────
  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/wecom') {
      res.writeHead(404); res.end('not found'); return;
    }
    if (req.method === 'GET') {
      // URL 验证：验签 + 解密 echostr，原样返回
      const ok = verifyQuery(url, '', 'GET');
      if (!ok) { res.writeHead(403); res.end('verify failed'); return; }
      const echostr = url.searchParams.get('echostr') ?? '';
      let plain;
      try {
        plain = wecomDecrypt(encodingAESKey, echostr);
      } catch (err) {
        logger.error('dsh-im-wecom: echostr decrypt failed: %s', err?.message ?? err);
        res.writeHead(403); res.end('decrypt failed'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(plain);
      return;
    }
    if (req.method === 'POST') {
      // 消息回调：验签（用 body 的 Encrypt 值参与签名）+ 解密 XML → ImMessage；5 秒内响应 success
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        void (async () => {
          try {
            const encryptMsg = xmlField(body, 'Encrypt');
            const ok = verifyQuery(url, encryptMsg, 'POST');
            if (!ok) { res.writeHead(403); res.end('verify failed'); return; }
            const plain = wecomDecrypt(encodingAESKey, encryptMsg);
            channel.status.lastEventAt = Date.now();
            await handleMessageXml(plain);
          } catch (err) {
            logger.warn('dsh-im-wecom: callback handling failed: %s', err?.message ?? err);
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('success');
        })();
      });
      return;
    }
    res.writeHead(405); res.end('method not allowed');
  });
  server.listen(config.port ?? 8787, () => {
    if (disposed) return;
    const port = server.address().port;
    channel.status = { connected: true, detail: `listening :${port} (needs public tunnel | 需公网穿透)`, port };
    logger.info(`dsh-im-wecom: callback server listening on :${port} | 回调服务已监听 :${port}`);
  });

  // 启动自检：查公网出口 IP 并提示加入「企业可信 IP」（60020 前置，免得发消息才炸）。
  // 多源兜底（国内网络可能屏蔽部分服务）：ip.sb → myip.ipip.net → 4.ipw.cn → api.ipify.org
  const IP_PROVIDERS = ['https://ip.sb', 'https://myip.ipip.net', 'https://4.ipw.cn', 'https://api.ipify.org'];
  void (async () => {
    for (const url of IP_PROVIDERS) {
      try {
        const resp = await fetchImpl(url);
        const text = (await resp.text()).trim();
        const ipv4 = text.match(/(\d{1,3}\.){3}\d{1,3}/)?.[0];
        if (ipv4) {
          channel.status.publicIp = ipv4;
          console.warn('⚠️ WeCom requires your server egress IP in the "Trusted IP" list (App settings → Trusted IP) | 企业微信要求把服务器出口 IP 加入「企业可信 IP」（应用详情 → 企业可信IP）。');
          console.warn(`   Your egress IP: ${ipv4} (as reported by WeCom errors) | 你的出口 IP：${ipv4}（以企微报错里的 from ip 为准）`);
          console.warn('   Until added, replies fail with 60020 (not allow to access from your ip) | 未加入前，回复消息会报 60020。');
          break;
        }
      } catch { /* 试下一个 */ }
    }
  })();

  return () => channel.dispose();

  // ── 验签与消息处理 ────────────────────────────────────────────────────────

  /** 验签：GET 用 echostr、POST 用 body 的 Encrypt 值参与签名（企微规则）。 */
  function verifyQuery(url, postEncrypt = '', method = 'GET') {
    const signature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const msg = method === 'GET' ? (url.searchParams.get('echostr') ?? '') : postEncrypt;
    const sig = wecomSignature(callbackToken, timestamp, nonce, msg);
    return sig === signature;
  }

  async function handleMessageXml(xml) {
    const im = ctx.get('im');
    const msgType = xmlField(xml, 'MsgType');
    if (msgType === 'event') {
      if (debug) logger.info('dsh-im-wecom: event %s from %s', xmlField(xml, 'Event'), xmlField(xml, 'FromUserName'));
      return; // 忽略事件（如进群/订阅），只处理消息
    }
    const fromUser = xmlField(xml, 'FromUserName');
    if (!fromUser) return;
    if (debug) logger.info('dsh-im-wecom: inbound msgId=%s from=%s type=%s text=%s', xmlField(xml, 'MsgId'), fromUser, msgType, xmlField(xml, 'Content').slice(0, 60));
    const { text, attachments } = parseContent(msgType, xml);
    await im.dispatchInbound({
      platform: 'wecom',
      chatId: fromUser,          // 企微应用消息：touser=userid，p2p 会话
      userId: fromUser,
      userName: fromUser,
      text,
      msgId: xmlField(xml, 'MsgId') || `${Date.now()}`,
      chatType: 'private',
      attachments,
    }).catch((err) => logger.warn('dsh-im-wecom: inbound dispatch failed | 入站消息处理失败: %s', err?.message ?? err));
  }

  // ── access_token ─────────────────────────────────────────────────────────

  async function getAccessToken() {
    if (tokenCache.value && tokenCache.expireAt > Date.now() + 60_000) return tokenCache.value;
    const url = `${api}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`;
    const resp = await fetchImpl(url);
    const data = await resp.json().catch(() => ({}));
    if (data.errcode !== 0) throw new Error(`wecom gettoken failed: ${data.errmsg ?? data.errcode}`);
    tokenCache = { value: data.access_token, expireAt: Date.now() + (data.expires_in ?? 7200) * 1000 };
    return data.access_token;
  }

  // ── 出站 ─────────────────────────────────────────────────────────────────

  async function send(out) {
    const token = await getAccessToken();
    // 企微应用消息无交互按钮 → 文本降级（FR-6.2），并给出带真实 id 的 /approve 提示
    let content = out.text;
    if (out.buttons?.length) {
      const btn = out.buttons[0];
      const aid = btn?.id?.startsWith('approve:') ? btn.id.split(':')[1] : null;
      content = `${out.text}\n\n（企业微信应用消息不支持按钮，请回复 ${aid ? `/approve ${aid} yes|no` : '/approve <id> yes|no'} 审批）`;
    }
    const payload = {
      touser: out.chatId,
      msgtype: 'text',
      agentid: Number(agentId),
      text: { content: content ?? '' },
    };
    const resp = await fetchImpl(`${api}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (data.errcode !== 0) {
      logger.error('dsh-im-wecom: message/send failed | 发送失败: %s (code=%s) touser=%s', data.errmsg, data.errcode, out.chatId);
      if (data.errcode === 60020) {
        const ip = String(data.errmsg ?? '').match(/from ip: ([\d.]+)/)?.[1] ?? '未知';
        console.warn(`❌ WeCom reply rejected (60020): egress IP not in whitelist | 企微回复被拒（60020）：服务器出口 IP 不在白名单。`);
        console.warn(`   Current egress IP: ${ip} → add it in WeCom admin (App → Trusted IP), then retry | 当前出口 IP：${ip} → 去企微后台「应用详情 → 企业可信 IP」添加后重试。`);
      }
      throw new Error(`wecom message/send failed: ${data.errmsg ?? data.errcode}`);
    }
    if (debug) logger.info('dsh-im-wecom: text sent to %s ok', out.chatId);
    return {};
  }

  /** 文件消息（/log 全量交付）：上传素材 → file 消息。 */
  async function sendFile(chatId, fileName, text, mime = 'text/plain') {
    const token = await getAccessToken();
    const form = new FormData();
    form.append('media', new Blob([text], { type: mime }), fileName);
    const up = await fetchImpl(`${api}/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=file`, {
      method: 'POST',
      body: form,
    });
    const upData = await up.json().catch(() => ({}));
    if (upData.errcode !== 0) throw new Error(`wecom media/upload failed: ${upData.errmsg ?? upData.errcode}`);
    const payload = {
      touser: chatId,
      msgtype: 'file',
      agentid: Number(agentId),
      file: { media_id: upData.media_id },
    };
    const resp = await fetchImpl(`${api}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (data.errcode !== 0) throw new Error(`wecom message/send(file) failed: ${data.errmsg ?? data.errcode}`);
    return {};
  }
}

/** 从企微 XML 取字段（支持 CDATA 与纯文本两种写法）。 */
export function xmlField(xml, name) {
  const m = xml.match(new RegExp(`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>|<${name}>([\\s\\S]*?)</${name}>`));
  return m ? (m[1] ?? m[2] ?? '') : '';
}

/**
 * 消息内容解析（纯函数，可单测）。
 * @param {string} msgType text|image|voice|video|file|location|link
 * @param {string} xml     消息 XML
 * @returns {{text: string, attachments?: Array<{kind:string, name?:string}>}}
 */
export function parseContent(msgType, xml) {
  const content = xmlField(xml, 'Content');
  switch (msgType) {
    case 'text':
      return { text: content };
    case 'image': {
      const mediaId = xmlField(xml, 'MediaId');
      const picUrl = xmlField(xml, 'PicUrl');
      return { text: '[图片]', attachments: [{ kind: 'image', name: mediaId || undefined }] };
    }
    case 'voice':
      return { text: '[语音]' };
    case 'video':
      return { text: '[视频]' };
    case 'file':
      return { text: '[文件]' };
    case 'location':
      return { text: `[位置] ${xmlField(xml, 'Label') || ''}`.trim() };
    case 'link':
      return { text: `[链接] ${xmlField(xml, 'Title') || ''} ${xmlField(xml, 'Url') || ''}`.trim() };
    default:
      return { text: `[${msgType}消息]` };
  }
}

export { name, inject, Config };
export default { name, inject, Config, apply };
export const plugin = { name, inject, Config, apply };
