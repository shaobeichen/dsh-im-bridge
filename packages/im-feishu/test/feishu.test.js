// dsh-im-feishu 适配器测试（stub 官方 SDK，无需真实凭据/网络）
//
// 验证：事件 → ImMessage / 审批回调 → 出站文本/卡片/文件上传。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';

import { apply, parseMessageContent, cleanMentions, isBotMentioned, plugin as feishuPlugin } from '../lib/index.js';

/** Stub 官方 SDK：记录调用，可触发事件 handler；failCreateWith/failPatchWith 注入业务失败。 */
function fakeSdk({ failCreateWith = null, failPatchWith = null } = {}) {
  const sentMessages = [];
  const patchedMessages = [];
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
          create: async (payload) => {
            sentMessages.push(payload);
            if (failCreateWith) return { code: failCreateWith.code ?? 99991663, msg: failCreateWith.msg ?? 'no permission' };
            return { code: 0, data: { message_id: `om_${sentMessages.length}` } };
          },
          patch: async (payload) => {
            patchedMessages.push(payload);
            if (failPatchWith) return { code: failPatchWith.code ?? 99991663, msg: failPatchWith.msg ?? 'no permission' };
            return { code: 0 };
          },
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
    get patchedMessages() { return patchedMessages; },
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

/** 假机器人身份查询（fetch 注入）：记录调用并按需返回 token / bot info。 */
function fakeFetch({ tokenResult, infoResult } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, init = {}) => {
      calls.push({ url, init });
      if (String(url).includes('tenant_access_token')) {
        return { json: async () => (tokenResult ?? { tenant_access_token: 't-tok-1' }) };
      }
      return { json: async () => (infoResult ?? { code: 0, bot: { open_id: 'ou_bot', app_name: '空目' } }) };
    },
  };
}

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
  assert.equal(card.header.title.content, '🔐 审批请求', '未指定 title 时用默认审批标题');
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

test('流式卡片：send(stream) 发 interactive 卡片并返回 messageId；edit 走 message.patch', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk });
  const channel = im.channels.get('feishu');

  const res = await channel.send({ chatId: 'oc_1', text: '第一帧输出', stream: true, title: 'DeepSeek Harness ⏳ 执行中' });
  assert.equal(res.messageId, 'om_1', 'send 返回 messageId（供 edit 使用）');
  const cardMsg = sdk.sentMessages.at(-1);
  assert.equal(cardMsg.data.msg_type, 'interactive', '流式帧渲染为交互卡片');
  const card = JSON.parse(cardMsg.data.content);
  assert.equal(card.header.title.content, 'DeepSeek Harness ⏳ 执行中');
  assert.ok(card.elements[0].text.content.includes('第一帧输出'));
  assert.equal(card.elements[1].tag, 'note', '带实时输出脚注');

  await channel.edit('om_1', { text: '第二帧（含增量）', stream: true, title: 'DeepSeek Harness ⏳ 执行中' });
  assert.equal(sdk.patchedMessages.length, 1, 'edit 调用 message.patch');
  assert.equal(sdk.patchedMessages[0].path.message_id, 'om_1');
  const patched = JSON.parse(sdk.patchedMessages[0].data.content);
  assert.ok(patched.elements[0].text.content.includes('第二帧'));
  assert.equal(sdk.sentMessages.length, 1, 'edit 不产生新消息');
  dispose();
});

test('超长流式帧：适配器兜底截断到卡片字段限制内', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk });
  const channel = im.channels.get('feishu');
  await channel.send({ chatId: 'oc_1', text: 'x'.repeat(6000), stream: true });
  const card = JSON.parse(sdk.sentMessages.at(-1).data.content);
  assert.ok(card.elements[0].text.content.length <= 2800, '卡片正文截断到限制内');
  dispose();
});

test('业务失败（code != 0）：send/edit 抛错并带平台错误码（不静默吞掉）', async () => {
  const sdk = fakeSdk({
    failCreateWith: { code: 99991663, msg: 'no permission' },
    failPatchWith: { code: 99991664, msg: 'card expired' },
  });
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk });
  const channel = im.channels.get('feishu');
  await assert.rejects(
    () => channel.send({ chatId: 'oc_1', text: 'hi' }),
    (err) => err.code === 99991663 && /no permission/.test(err.msg),
    '文本发送的业务失败必须抛出'
  );
  await assert.rejects(
    () => channel.edit('om_1', { text: 'x', stream: true }),
    (err) => err.code === 99991664 && /card expired/.test(err.msg),
    'edit 的业务失败必须抛出（核心据此回退发新消息）'
  );
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

test('无 Connection 服务：插件仍激活（回归：inject 不得硬依赖 connection）', async () => {
  // 历史缺陷：inject: ['im','connection'] 使 demo/feishu-real.mjs 的裸 Context
  // （无 Connection 服务）里插件永远 waiting、apply 不执行、进程空转退出。
  // web 设置页签本来就优雅降级，connection 必须是可选依赖。
  const im = fakeIm();
  const ctx = new Context();
  ctx.provide('im', im);
  const handle = ctx.plugin(feishuPlugin, { appId: 'app1', appSecret: 'sec1' });
  await handle.await();
  assert.ok(im.channels.has('feishu'), 'apply 已执行：渠道已注册');
  await handle.dispose();
});

// ── 群聊 @ 过滤（群聊仅回复手动 @ 机器人的消息） ──────────────────────────────

/** 构造一条群聊消息事件（mentions 下标 N-1 对应文本里的 @_user_N）。 */
function groupMessage({ text = '你好', mentions = [] } = {}) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_g1',
      chat_id: 'oc_g1',
      chat_type: 'group',
      message_type: 'text',
      mentions,
      content: JSON.stringify({ text }),
    },
  };
}

test('群聊 @ 机器人 → 派发；@ 占位符清洗（机器人自身移除、他人替换为 @昵称）', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk, botOpenId: 'ou_bot' });
  sdk.emitMessage(groupMessage({
    text: '@_user_1 @_user_2 帮我看看这个报错',
    mentions: [
      { key: 'ou_bot', id: { open_id: 'ou_bot' }, name: '空目' },
      { key: 'ou_1', id: { open_id: 'ou_1' }, name: '小明' },
    ],
  }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 1, '被 @ 的群消息应派发');
  assert.equal(im.inbound[0].chatType, 'group');
  assert.equal(im.inbound[0].text, '@小明 帮我看看这个报错', '机器人自身 @ 移除，他人 @ 替换为昵称');
  dispose();
});

test('群聊未 @ 机器人 → 不派发（不刷屏）', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk, botOpenId: 'ou_bot' });
  sdk.emitMessage(groupMessage({
    text: '大家早上好',
    mentions: [{ key: 'ou_1', id: { open_id: 'ou_1' }, name: '小明' }],
  }));
  sdk.emitMessage(groupMessage({ text: '没有任何 @ 的消息' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 0, '未 @ 机器人的群消息不派发');
  dispose();
});

test('私聊消息 → 总是派发（@ 过滤只作用于群聊）', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk, botOpenId: 'ou_bot' });
  sdk.emitMessage({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_p1', chat_id: 'oc_p1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 1);
  assert.equal(im.inbound[0].text, 'hi');
  dispose();
});

test('groupMentionOnly=false → 群聊未 @ 也派发', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1', groupMentionOnly: false }, { sdk: sdk.fakeSdk, botOpenId: 'ou_bot' });
  sdk.emitMessage(groupMessage({ text: '不用 @ 也会回复' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 1);
  dispose();
});

test('机器人身份直连查询（token + bot/v3/info）并缓存复用', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const ff = fakeFetch();
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk, fetchImpl: ff.impl });
  sdk.emitMessage(groupMessage({ text: '@_user_1 在吗', mentions: [{ key: 'ou_bot', id: { open_id: 'ou_bot' }, name: '空目' }] }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 1, '身份查询成功后 @ 判定通过并派发');
  const tokenCall = ff.calls.find((c) => String(c.url).includes('tenant_access_token'));
  const infoCall = ff.calls.find((c) => String(c.url).includes('bot/v3/info'));
  assert.ok(tokenCall, '调用租户 token 接口');
  assert.equal(JSON.parse(tokenCall.init.body).app_id, 'app1');
  assert.equal(tokenCall.init.method, 'POST');
  assert.ok(infoCall, '调用 bot/v3/info');
  assert.equal(infoCall.init.headers.authorization, 'Bearer t-tok-1');
  // 再次群消息：身份已缓存，不再发查询请求
  const callsBefore = ff.calls.length;
  sdk.emitMessage(groupMessage({ text: '@_user_1 第二次', mentions: [{ key: 'ou_bot', id: { open_id: 'ou_bot' }, name: '空目' }] }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ff.calls.length, callsBefore, '身份缓存后不再重复查询');
  dispose();
});

test('身份查询失败 → 群聊失败关闭（不派发），私聊不受影响', async () => {
  const sdk = fakeSdk();
  const im = fakeIm();
  const ff = fakeFetch({ tokenResult: { code: 99991663, msg: 'forbidden' } });
  const dispose = apply(ctx(im), { appId: 'app1', appSecret: 'sec1' }, { sdk: sdk.fakeSdk, fetchImpl: ff.impl });
  sdk.emitMessage(groupMessage({ text: '@_user_1 在吗', mentions: [{ key: 'ou_bot', id: { open_id: 'ou_bot' } }] }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 0, '身份未知无法校验 @ → 跳过（宁可漏回不刷屏）');
  sdk.emitMessage({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_p2', chat_id: 'oc_p2', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(im.inbound.length, 1, '私聊不受身份查询影响');
  dispose();
});

test('纯函数：isBotMentioned / cleanMentions 边界', () => {
  const botId = 'ou_bot';
  assert.equal(isBotMentioned({ mentions: [{ key: botId }] }, botId), true);
  assert.equal(isBotMentioned({ mentions: [{ id: { open_id: botId } }] }, botId), true);
  assert.equal(isBotMentioned({ mentions: [{ key: 'ou_other' }] }, botId), false);
  assert.equal(isBotMentioned({ mentions: [] }, botId), false);
  assert.equal(isBotMentioned({}, botId), false);
  assert.equal(isBotMentioned({ mentions: [{ key: botId }] }, null), false, '无机器人身份一律 false');
  // 清洗：机器人自身移除、他人替换昵称、无昵称移除、无身份时他人替换
  assert.equal(cleanMentions('@_user_1 你好', [{ key: 'ou_bot', name: '空目' }], 'ou_bot'), '你好');
  assert.equal(cleanMentions('@_user_1 在吗', [{ key: 'ou_1', name: '小明' }], 'ou_bot'), '@小明 在吗');
  assert.equal(cleanMentions('@_user_1 x', [{ key: 'ou_1' }], 'ou_bot'), 'x');
  assert.equal(cleanMentions('@_user_1 x', [{ key: 'ou_1', name: '小明' }], null), '@小明 x');
  assert.equal(cleanMentions('', [], 'ou_bot'), '');
  assert.equal(cleanMentions(null, [], 'ou_bot'), null);
});
