// dsh-im-weixin 适配器接线测试（假 iLink 服务器，无真实凭据/网络）
//
// 验证：
//   1. 入站：getupdates 消息 → dispatchInbound(ImMessage)，心跳 lastEventAt 更新
//   2. 出站：send 文本 → sendmessage 载荷
//   3. 缺凭据 → 优雅断开并提示扫码
//   4. notifystart 失败 → 断开并提示账号可能未获微信机器人功能
//   5. resolveSecret / resolveBaseUrl 扫码凭据文件回退（env 可注入）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { apply, resolveSecret, resolveBaseUrl, plugin as weixinPlugin } from '../lib/index.js';
import { createFakeIlinkServer } from './fake-ilink-server.js';

function fakeIm() {
  const inbound = [];
  return {
    inbound,
    registerChannel(c) { this.channel = c; },
    async dispatchInbound(m) { inbound.push(m); },
    async handleCallback() {},
  };
}

const ctx = (im) => ({ get: () => im, logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) });

function waitFor(predicate, { timeoutMs = 4000, intervalMs = 30, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test('入站：微信消息 → ImMessage，心跳更新', async () => {
  const fake = await createFakeIlinkServer({
    queuedMsgs: [{
      message_id: 'm_1',
      from_user_id: 'wxid_user_1',
      from_user_name: '张三',
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '列出当前目录' } }],
    }],
  });
  const im = fakeIm();
  const dispose = apply(ctx(im), {
    botToken: 'bot_tok_1',
    ownerUserId: 'wxid_user_1',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
  }, { fetchImpl: fake.fetch, env: {} });
  try {
    const msg = await waitFor(() => im.inbound[0], { label: 'inbound message' });
    assert.equal(msg.platform, 'weixin');
    assert.equal(msg.chatId, 'wxid_user_1');
    assert.equal(msg.userId, 'wxid_user_1');
    assert.equal(msg.text, '列出当前目录');
    assert.equal(msg.msgId, 'm_1');
    assert.equal(msg.chatType, 'private');
    await waitFor(() => im.channel.status.connected === true, { label: 'connected' });
    assert.ok(im.channel.status.lastEventAt > 0, '心跳已更新');
  } finally {
    dispose();
    await fake.close();
  }
});

test('出站：send 文本 → sendmessage（长文本自动切分）', async () => {
  const fake = await createFakeIlinkServer();
  const im = fakeIm();
  const dispose = apply(ctx(im), {
    botToken: 'bot_tok_1', ownerUserId: 'wxid_user_1', baseUrl: 'https://ilinkai.weixin.qq.com/',
  }, { fetchImpl: fake.fetch, env: {} });
  try {
    await im.channel.send({ chatId: 'wxid_user_1', text: '任务完成 ✅' });
    const payload = fake.calls.send[0];
    assert.equal(payload.msg.to_user_id, 'wxid_user_1');
    assert.equal(payload.msg.item_list[0].text_item.text, '任务完成 ✅');

    // 长文本切分（>4000）
    await im.channel.send({ chatId: 'wxid_user_1', text: 'x'.repeat(9000) });
    assert.ok(fake.calls.send.length >= 4, '多条 sendmessage');
  } finally {
    dispose();
    await fake.close();
  }
});

test('缺凭据：优雅断开并提示扫码接入', () => {
  const im = fakeIm();
  let dispose;
  assert.doesNotThrow(() => {
    dispose = apply(ctx(im), { botToken: '', ownerUserId: '' }, { fetchImpl: async () => ({}), env: {} });
  });
  assert.equal(im.channel.status.connected, false);
  assert.match(im.channel.status.detail, /扫码接入/);
  dispose();
});

test('notifystart 失败：断开并提示账号可能未获微信机器人功能', async () => {
  const fake = await createFakeIlinkServer({ notifyStartFail: true });
  const im = fakeIm();
  const dispose = apply(ctx(im), {
    botToken: 'bot_tok_1', ownerUserId: 'wxid_user_1', baseUrl: 'https://ilinkai.weixin.qq.com/',
  }, { fetchImpl: fake.fetch, env: {} });
  try {
    await waitFor(() => im.channel.status.detail.includes('notifystart'), { label: 'notifystart failure status' });
    assert.equal(im.channel.status.connected, false);
    assert.match(im.channel.status.detail, /微信机器人功能/);
  } finally {
    dispose();
    await fake.close();
  }
});

test('resolveSecret / resolveBaseUrl：扫码凭据文件回退', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-home-'));
  await mkdir(join(home, 'dsh-im'), { recursive: true });
  await writeFile(join(home, 'dsh-im', 'weixin-credentials.json'), JSON.stringify({
    botToken: 'tok_file', ownerUserId: 'wxid_file', baseUrl: 'https://ilinkai.weixin.qq.com/',
  }));
  assert.equal(resolveSecret('env:WECHAT_BOT_TOKEN', { home, env: {} }), 'tok_file');
  assert.equal(resolveSecret('env:WECHAT_OWNER_USER_ID', { home, env: {} }), 'wxid_file');
  assert.equal(resolveBaseUrl('https://default.weixin.qq.com/', { home, env: {} }), 'https://ilinkai.weixin.qq.com/');
  // env 优先
  assert.equal(resolveSecret('env:WECHAT_BOT_TOKEN', { home, env: { WECHAT_BOT_TOKEN: 'tok_env' } }), 'tok_env');
  // 无文件且 env 空 → 空串
  assert.equal(resolveSecret('env:WECHAT_BOT_TOKEN', { home: '/nonexistent', env: {} }), '');
});

test('无 Connection 服务：插件仍激活（回归：inject 不得硬依赖 connection）', async () => {
  // 与 dsh-im-feishu 同因的历史缺陷：inject 硬依赖 connection 时，裸 Context
  // 运行器里插件永远 waiting、apply 不执行。web 设置页签本来就优雅降级。
  const im = fakeIm();
  const ctx = new Context();
  ctx.provide('im', im);
  const handle = ctx.plugin(weixinPlugin, { botToken: '', ownerUserId: '' });
  await handle.await();
  assert.ok(im.channel, 'apply 已执行：渠道已注册');
  assert.equal(im.channel.status.connected, false);
  await handle.dispose();
});
