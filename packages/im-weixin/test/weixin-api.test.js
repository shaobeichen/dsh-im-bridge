// iLink 协议客户端测试（假服务器，无真实凭据/网络）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWeixinApi, normalizeWeixinApiBaseUrl, normalizeWeixinQrUrl, extractWeixinText, weixinMessageId, splitWeixinText, WeixinApiError } from '../lib/weixin-api.js';
import { createFakeIlinkServer } from './fake-ilink-server.js';

test('beginLogin：返回二维码令牌 + 受信二维码地址', async () => {
  const fake = await createFakeIlinkServer();
  try {
    const api = createWeixinApi({ fetchImpl: fake.fetch });
    const { qrcode, qrcodeUrl } = await api.beginLogin({ localTokens: ['t1', 't1'] });
    assert.equal(qrcode, 'qr_token_1');
    assert.equal(qrcodeUrl, 'https://weixin.qq.com/qr/abc');
    assert.equal(fake.calls.qrcode, 1);
  } finally {
    await fake.close();
  }
});

test('pollLogin：wait → scaned → need_verifycode → confirmed（带回凭据）', async () => {
  const fake = await createFakeIlinkServer({
    statusScript: ['wait', 'scaned', 'need_verifycode', 'confirmed'],
  });
  try {
    const api = createWeixinApi({ fetchImpl: fake.fetch });
    const r1 = await api.pollLogin({ qrcode: 'qr_token_1' });
    assert.equal(r1.status, 'wait');
    const r2 = await api.pollLogin({ qrcode: 'qr_token_1' });
    assert.equal(r2.status, 'scaned');
    const r3 = await api.pollLogin({ qrcode: 'qr_token_1' });
    assert.equal(r3.status, 'need_verifycode');
    const r4 = await api.pollLogin({ qrcode: 'qr_token_1', verifyCode: '1234' });
    assert.equal(r4.status, 'confirmed');
    assert.equal(r4.bot_token, 'bot_tok_1');
    assert.equal(r4.ilink_user_id, 'wxid_user_1');
  } finally {
    await fake.close();
  }
});

test('getUpdates：返回消息与游标；超时降级为空结果', async () => {
  const fake = await createFakeIlinkServer({ queuedMsgs: [{ message_id: 'm1', from_user_id: 'wxid_user_1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }] });
  try {
    const api = createWeixinApi({ fetchImpl: fake.fetch });
    const res = await api.getUpdates({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', getUpdatesBuf: '' });
    assert.equal(res.ret, 0);
    assert.equal(res.msgs.length, 1);
    assert.equal(res.get_updates_buf, 'buf-1');
    assert.equal(fake.calls.getupdates, 1);
    // 超时（内部 timer 触发 abort）→ 空结果，不抛错
    const hanging = (url, opts) => new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('AbortError')), { once: true });
    });
    const timeoutApi = createWeixinApi({ fetchImpl: hanging });
    const empty = await timeoutApi.getUpdates({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', getUpdatesBuf: 'x', timeoutMs: 200 });
    assert.deepEqual(empty, { ret: 0, msgs: [], get_updates_buf: 'x' });
  } finally {
    await fake.close();
  }
});

test('sendText：载荷形状正确；ret!=0 抛错', async () => {
  const fake = await createFakeIlinkServer();
  try {
    const api = createWeixinApi({ fetchImpl: fake.fetch });
    await api.sendText({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', toUserId: 'wxid_user_1', text: '任务完成 ✅' });
    const payload = fake.calls.send[0];
    assert.equal(payload.msg.to_user_id, 'wxid_user_1');
    assert.equal(payload.msg.item_list[0].type, 1);
    assert.equal(payload.msg.item_list[0].text_item.text, '任务完成 ✅');
    assert.equal(payload.msg.message_type, 2);

    const fake2 = await createFakeIlinkServer({ rejectSend: true });
    try {
      const api2 = createWeixinApi({ fetchImpl: fake2.fetch });
      await assert.rejects(
        () => api2.sendText({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 't', toUserId: 'u', text: 'x' }),
        (e) => e instanceof WeixinApiError && e.code === 'send-rejected'
      );
    } finally {
      await fake2.close();
    }
  } finally {
    await fake.close();
  }
});

test('受信域名校验：非 weixin.qq.com 一律拒绝', () => {
  assert.throws(() => normalizeWeixinApiBaseUrl('http://ilinkai.weixin.qq.com/'), WeixinApiError);
  assert.throws(() => normalizeWeixinApiBaseUrl('https://evil.com/'), WeixinApiError);
  assert.throws(() => normalizeWeixinApiBaseUrl('https://weixin.qq.com.evil.com/'), WeixinApiError);
  assert.throws(() => normalizeWeixinQrUrl('https://evil.com/qr'), WeixinApiError);
  assert.throws(() => normalizeWeixinQrUrl('javascript:alert(1)'), WeixinApiError);
  assert.equal(normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com/');
});

test('extractWeixinText / weixinMessageId / splitWeixinText 纯函数', () => {
  assert.equal(extractWeixinText({ item_list: [{ type: 1, text_item: { text: '  跑一下  ' } }] }), '跑一下');
  assert.equal(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }), '语音转写');
  assert.equal(extractWeixinText({ item_list: [{ type: 2 }] }), null);
  assert.equal(weixinMessageId({ message_id: 123 }), '123');
  assert.equal(weixinMessageId({ client_id: 'c1' }), 'c1');
  const chunks = splitWeixinText('a'.repeat(9000), 4000);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 4000));
  assert.deepEqual(splitWeixinText('short'), ['short']);
});
