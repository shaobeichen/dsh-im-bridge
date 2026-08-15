// dsh-im-feishu 适配器测试（stub 官方 SDK，无需真实凭据/网络）
//
// 验证：事件 → ImMessage / 审批回调 → 出站文本/卡片/文件上传。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, parseMessageContent } from '../lib/index.js';

/** Stub 官方 SDK：记录调用，可触发事件 handler。 */
function fakeSdk() {
  const sentMessages = [];
  const fileUploads = [];
  let messageHandler = null;
  let cardHandler = null;
  let wsInstance = null;

  class FakeClient {
    constructor(opts) {
      // 模拟真实 lark SDK：缺 appSecret 时抛 ClientAssertionError（本适配器必须在创建前拦住）
      if (!opts?.appSecret || !opts?.appId) {
        const e = new Error('appSecret or clientAssertionProvider is required');
        e.code = 7104;
        throw e;
      }
      this.opts = opts;
    }
    get im() {
      return {
        message: {
          create: async (payload) => { sentMessages.push(payload); return { code: 0 }; },
        },
        file: {
          create: async (payload) => { fileUploads.push(payload); return { file_key: 'file_key_1' }; },
        },
      };
    }
  }
  class FakeEventDispatcher {
    constructor() { this.registered = {}; }
    register(map) { Object.assign(this.registered, map); return this; }
  }
  class FakeWSClient {
    constructor(opts) { this.opts = opts; wsInstance = this; this.started = false; }
    async start({ eventDispatcher }) {
      this.started = true;
      messageHandler = eventDispatcher.registered['im.message.receive_v1'];
      cardHandler = eventDispatcher.registered['card.action.trigger'];
      this.opts.onReady?.();
    }
    close() { this.closed = true; }
  }
  return {
    fakeSdk: { Client: FakeClient, EventDispatcher: FakeEventDispatcher, WSClient: FakeWSClient, LoggerLevel: { warn: 'warn' } },
    get sentMessages() { return sentMessages; },
    get fileUploads() { return fileUploads; },
    get wsInstance() { return wsInstance; },
    emitMessage(data) { messageHandler(data); },
    emitCard(data) { cardHandler(data); },
  };
}

function fakeIm() {
  const inbound = [];
  const callbacks = [];
  const channels = new Map();
  return {
    inbound,
    callbacks,
    channels,
    registerChannel(c) { channels.set(c.platform, c); c.attach?.(this); },
    async dispatchInbound(m) { inbound.push(m); },
    async handleCallback(p) { callbacks.push(p); },
  };
}

const ctx = (im) => ({ get: () => im, logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) });

test('parseMessageContent：text / post / file', () => {
  assert.equal(parseMessageContent({ message_type: 'text', content: JSON.stringify({ text: '跑一下 pytest' }) }), '跑一下 pytest');
  const post = parseMessageContent({ message_type: 'post', content: JSON.stringify({ post: { zh_cn: { content: [[{ tag: 'text', text: '你好' }], [{ tag: 'a', text: '链接', href: 'https://x.com' }]] } } }) });
  assert.ok(post.includes('你好'));
  assert.ok(post.includes('https://x.com'));
  assert.equal(parseMessageContent({ message_type: 'file', content: JSON.stringify({ file_name: 'a.txt' }) }), '[文件] a.txt');
});

test('事件 im.message.receive_v1 → ImMessage；出站文本/卡片/文件', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk });
  assert.ok(sdk.wsInstance, 'WSClient 已创建');
  assert.ok(sdk.wsInstance.started, 'start 已调用');
  assert.equal(im.channels.get('feishu').status.connected, true, 'onReady 后 connected');

  // 入站文本
  sdk.emitMessage({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  });
  await new Promise((r) => setTimeout(r, 20));
  const msg = im.inbound[0];
  assert.equal(msg.platform, 'feishu');
  assert.equal(msg.chatId, 'oc_1');
  assert.equal(msg.userId, 'ou_1');
  assert.equal(msg.text, 'hi');
  assert.equal(msg.chatType, 'private');

  // 出站文本
  await im.channels.get('feishu').send({ chatId: 'oc_1', text: '任务完成 ✅' });
  const textReq = sdk.sentMessages[0];
  assert.equal(textReq.data.msg_type, 'text');
  assert.equal(textReq.data.receive_id, 'oc_1');
  assert.equal(textReq.params.receive_id_type, 'chat_id');

  // 出站审批卡片
  sdk.sentMessages.length = 0;
  await im.channels.get('feishu').send({
    chatId: 'oc_1',
    text: '🔐 审批请求 #abc',
    buttons: [{ id: 'approve:abc:yes', label: '✅ 批准', style: 'primary' }, { id: 'approve:abc:no', label: '❌ 拒绝', style: 'danger' }],
  });
  const cardReq = sdk.sentMessages[0];
  assert.equal(cardReq.data.msg_type, 'interactive');
  const card = JSON.parse(cardReq.data.content);
  assert.equal(card.elements[1].tag, 'action');
  assert.equal(card.elements[1].actions[0].value.id, 'abc');
  assert.equal(card.elements[1].actions[0].value.answer, 'yes');
  assert.equal(card.elements[1].actions[1].type, 'danger');

  // 出站文件（/log）
  await im.channels.get('feishu').sendFile('oc_1', 'log.md', 'full text');
  assert.equal(sdk.fileUploads[0].data.file_name, 'log.md');
  const fileMsg = sdk.sentMessages.at(-1);
  assert.equal(fileMsg.data.msg_type, 'file');
  assert.equal(JSON.parse(fileMsg.data.content).file_key, 'file_key_1');

  dispose();
});

test('卡片按钮回调 card.action.trigger → handleCallback（含身份校验所需字段）', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk });
  sdk.emitCard({
    context: { open_message_id: 'om_9', open_chat_id: 'oc_9' },
    operator: { open_id: 'ou_9', name: 'Bob' },
    action: { value: { action: 'approve', id: 'a1b2', answer: 'yes' }, tag: 'button' },
  });
  await new Promise((r) => setTimeout(r, 20));
  const cb = im.callbacks[0];
  assert.equal(cb.data, 'approve:a1b2:yes');
  assert.equal(cb.userId, 'ou_9');
  assert.equal(cb.chatId, 'oc_9');
  assert.equal(cb.userName, 'Bob');
  dispose();
});

test('缺少凭据：不崩启动，渠道断开并给出缺口提示（FR-9.3）', () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  // apply 不应抛错（真实 SDK 会在缺 secret 时抛 ClientAssertionError）
  let dispose;
  assert.doesNotThrow(() => {
    dispose = apply(ctx(im), { appId: '', appSecret: '' }, { sdk: sdk.fakeSdk });
  });
  assert.equal(im.channels.get('feishu').status.connected, false);
  assert.match(im.channels.get('feishu').status.detail, /missing/);
  dispose();
});

test('缺少凭据时不创建 SDK Client（不触发 ClientAssertionError）', () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: '' }, { sdk: sdk.fakeSdk });
  assert.equal(im.channels.get('feishu').status.connected, false);
  dispose();
  // 有凭据时正常创建并连接
  const sdk2 = fakeSdk();
  const im2 = fakeIm();
  const dispose2 = apply(ctx(im2), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk2.fakeSdk });
  assert.equal(im2.channels.get('feishu').status.connected, true);
  dispose2();
});
