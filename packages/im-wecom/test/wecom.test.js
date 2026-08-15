// dsh-im-wecom 适配器测试（本地 HTTP 服务器 + 官方加解密，无需真实企微账号/公网）
//
// 覆盖：契约 / 加解密往返 / XML 解析 / URL 验证 / 消息回调 → ImMessage / 出站 send+sendFile

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapterContract } from 'dsh-im/channel';
import { wecomDecrypt, wecomEncrypt, wecomSignature } from '../lib/crypto.js';
import { apply, parseContent, xmlField } from '../lib/index.js';

const TOKEN = 'QDG6eK';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

/** 构造企微回调：加密 XML → 外包裹 Encrypt + 签名参数。 */
function buildCallback(xml) {
  const encrypt = wecomEncrypt(AES_KEY, xml);
  const outer = `<xml><ToUserName><![CDATA[corp1]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n1';
  const signature = wecomSignature(TOKEN, timestamp, nonce, encrypt);
  return { body: outer, timestamp, nonce, signature };
}

function messageXml({ from = 'zhangsan', type = 'text', content = '跑一下 pytest', msgId = '123456' } = {}) {
  return `<xml>
  <ToUserName><![CDATA[corp1]]></ToUserName>
  <FromUserName><![CDATA[${from}]]></FromUserName>
  <CreateTime>1403610513</CreateTime>
  <MsgType><![CDATA[${type}]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
  <MsgId>${msgId}</MsgId>
  <AgentID>1000002</AgentID>
</xml>`;
}

/** 假 fetch：记录调用；gettoken / message/send / media/upload 返回成功。 */
function fakeFetch(records) {
  return async (url, opts = {}) => {
    records.push({ url: String(url), opts });
    if (String(url).includes('/cgi-bin/gettoken')) {
      return { json: async () => ({ errcode: 0, access_token: 'TOKEN1', expires_in: 7200 }) };
    }
    if (String(url).includes('/cgi-bin/media/upload')) {
      return { json: async () => ({ errcode: 0, media_id: 'MEDIA_1' }) };
    }
    if (String(url).includes('/cgi-bin/message/send')) {
      return { json: async () => ({ errcode: 0 }) };
    }
    return { json: async () => ({ errcode: -1, errmsg: 'unhandled ' + url }) };
  };
}

function fakeIm() {
  const inbound = [];
  const callbacks = [];
  const channels = new Map();
  return {
    inbound, callbacks, channels,
    registerChannel(c) { channels.set(c.platform, c); c.attach?.(this); },
    async dispatchInbound(m) { inbound.push(m); },
    async handleCallback(p) { callbacks.push(p); },
  };
}

const ctx = (im) => ({ get: () => im, logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) });

const creds = {
  corpid: 'corp1', agentId: '1000002', secret: 'sec1',
  callbackToken: TOKEN, encodingAESKey: AES_KEY, port: 0, apiBase: 'https://fake.qyapi',
};

test('契约：完整通过；缺 send 抛错（FR-9.4）', () => {
  const r = validateAdapterContract({ platform: 'wecom', status: { connected: false, lastEventAt: null }, send: async () => ({}), sendFile: async () => ({}), dispose: async () => {} });
  assert.equal(r.ok, true);
  assert.throws(() => validateAdapterContract({ platform: 'wecom' }));
});

test('加解密往返 + 官方验签', () => {
  const enc = wecomEncrypt(AES_KEY, 'hello');
  assert.equal(wecomDecrypt(AES_KEY, enc), 'hello');
  const sig = wecomSignature(TOKEN, '1409659589', '4314', 'ww_123');
  assert.equal(sig, '5f2f0e98a9fa7547e6c14178d3c579df12f59777'); // 官方示例向量
});

test('parseContent / xmlField：text、CDATA、event', () => {
  const xml = messageXml();
  assert.equal(xmlField(xml, 'MsgType'), 'text');
  assert.equal(parseContent('text', xml).text, '跑一下 pytest');
  assert.equal(xmlField(messageXml({ type: 'event' }), 'MsgType'), 'event');
  assert.equal(parseContent('image', messageXml({ type: 'image' })).attachments[0].kind, 'image');
});

test('URL 验证 GET：解密 echostr 并返回', async () => {
  const im = fakeIm();
  const records = [];
  const dispose = apply(ctx(im), creds, { fetchImpl: fakeFetch(records) });
  await new Promise((r) => setTimeout(r, 50));
  const port = im.channels.get('wecom').status.port;
  assert.ok(port, 'server 已监听');

  const echostr = wecomEncrypt(AES_KEY, 'hello-echostr');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n1';
  const signature = wecomSignature(TOKEN, timestamp, nonce, echostr);
  const resp = await fetch(`http://127.0.0.1:${port}/wecom?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`);
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), 'hello-echostr');
  // 错误签名 → 403
  const bad = await fetch(`http://127.0.0.1:${port}/wecom?msg_signature=deadbeef&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`);
  assert.equal(bad.status, 403);
  dispose();
});

test('消息回调 POST → ImMessage（文本）', async () => {
  const im = fakeIm();
  const records = [];
  const dispose = apply(ctx(im), creds, { fetchImpl: fakeFetch(records) });
  await new Promise((r) => setTimeout(r, 50));
  const port = im.channels.get('wecom').status.port;

  const cb = buildCallback(messageXml());
  const resp = await fetch(`http://127.0.0.1:${port}/wecom?msg_signature=${cb.signature}&timestamp=${cb.timestamp}&nonce=${cb.nonce}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: cb.body,
  });
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), 'success');

  await new Promise((r) => setTimeout(r, 50));
  const msg = im.inbound[0];
  assert.ok(msg, '应收到 ImMessage');
  assert.equal(msg.platform, 'wecom');
  assert.equal(msg.chatId, 'zhangsan');
  assert.equal(msg.userId, 'zhangsan');
  assert.equal(msg.text, '跑一下 pytest');
  assert.equal(msg.msgId, '123456');
  assert.equal(im.channels.get('wecom').status.lastEventAt != null, true, '事件心跳已更新');
  dispose();
});

test('出站 send：文本 + token 缓存；buttons → 文本降级提示', async () => {
  const im = fakeIm();
  const records = [];
  const dispose = apply(ctx(im), creds, { fetchImpl: fakeFetch(records) });
  await new Promise((r) => setTimeout(r, 50));

  await im.channels.get('wecom').send({ chatId: 'zhangsan', text: '任务完成 ✅' });
  const sendReq = records.find((r) => r.url.includes('/cgi-bin/message/send'));
  const payload = JSON.parse(sendReq.opts.body);
  assert.equal(payload.msgtype, 'text');
  assert.equal(payload.touser, 'zhangsan');
  assert.equal(payload.agentid, 1000002);
  assert.equal(payload.text.content, '任务完成 ✅');

  // 带按钮 → 文本降级提示（企微无交互按钮，FR-6.2）
  await im.channels.get('wecom').send({ chatId: 'zhangsan', text: '🔐 审批请求 #abc', buttons: [{ id: 'approve:abc:yes', label: '批准' }] });
  const send2 = records.filter((r) => r.url.includes('/cgi-bin/message/send')).at(-1);
  const p2 = JSON.parse(send2.opts.body);
  assert.ok(p2.text.content.includes('/approve abc yes'));
  dispose();
});

test('出站 sendFile：media/upload → file 消息（/log 交付）', async () => {
  const im = fakeIm();
  const records = [];
  const dispose = apply(ctx(im), creds, { fetchImpl: fakeFetch(records) });
  await new Promise((r) => setTimeout(r, 50));

  await im.channels.get('wecom').sendFile('zhangsan', 'log.md', 'full text');
  const up = records.find((r) => r.url.includes('/cgi-bin/media/upload'));
  assert.ok(up, '先上传素材');
  const send = records.filter((r) => r.url.includes('/cgi-bin/message/send')).at(-1);
  const p = JSON.parse(send.opts.body);
  assert.equal(p.msgtype, 'file');
  assert.equal(p.file.media_id, 'MEDIA_1');
  dispose();
});

test('缺凭据：渠道断开并给出缺口提示（FR-9.3）', () => {
  const im = fakeIm();
  const dispose = apply(ctx(im), { ...creds, corpid: '' }, { fetchImpl: fakeFetch([]) });
  assert.equal(im.channels.get('wecom').status.connected, false);
  assert.match(im.channels.get('wecom').status.detail, /missing/);
  dispose();
});
