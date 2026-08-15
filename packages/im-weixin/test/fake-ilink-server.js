// 假 iLink 服务器（测试用，无需真实微信凭据/网络）
//
// 用法：
//   const fake = await createFakeIlinkServer({ statusScript, queuedMsgs, rejectSend, notifyStartFail });
//   // fake.fetch 会把任何 https://*.weixin.qq.com 的请求改写成本地服务器，
//   // 从而 API 客户端的受信域名校验保持原样可测。
//   // 用完：await fake.close();

import { createServer } from 'node:http';

const QR_URL = 'https://weixin.qq.com/qr/abc';

export async function createFakeIlinkServer(options = {}) {
  const {
    statusScript = ['confirmed'],
    queuedMsgs = [],
    rejectSend = false,
    notifyStartFail = false,
    botToken = 'bot_tok_1',
    botId = 'ilink_bot_1',
    ownerUserId = 'wxid_user_1',
  } = options;

  let statusIdx = 0;
  const calls = { qrcode: 0, status: [], getupdates: 0, send: [], notifystart: 0, notifystop: 0 };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      calls.qrcode += 1;
      return send({ qrcode: 'qr_token_1', qrcode_img_content: QR_URL });
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      const status = statusScript[Math.min(statusIdx, statusScript.length - 1)];
      statusIdx += 1;
      calls.status.push(status);
      if (status === 'confirmed') {
        return send({ status, bot_token: botToken, ilink_bot_id: botId, ilink_user_id: ownerUserId, baseurl: 'ilinkai.weixin.qq.com' });
      }
      return send({ status });
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      calls.getupdates += 1;
      return send({ ret: 0, msgs: queuedMsgs, get_updates_buf: 'buf-1' });
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.send.push(JSON.parse(body || '{}'));
        if (rejectSend) return send({ ret: -1 });
        return send({ ret: 0 });
      });
      return;
    }
    if (url.pathname === '/ilink/bot/msg/notifystart') {
      calls.notifystart += 1;
      return notifyStartFail ? send({ ret: -1 }) : send({ ret: 0 });
    }
    if (url.pathname === '/ilink/bot/msg/notifystop') {
      calls.notifystop += 1;
      return send({ ret: 0 });
    }
    return send({ ret: -404 });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  /** 把受信 https URL 改写成本地假服务器（API 客户端校验保持不变）。 */
  const fetch = (url, opts) => {
    const u = new URL(url);
    return globalThis.fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, opts);
  };

  return {
    port,
    fetch,
    calls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
