// 接线测试（AGENTS.md 规则 #3/#9）：stub 官方 SDK，CI 不碰真实凭据
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, parseContent, stripAt, normalizeRobotMessage, parseCardCallback, buttonsAsCommands } from '../lib/index.js';
import { TOPIC_ROBOT, TOPIC_CARD } from '../lib/index.js';

/** 构造一个假 ctx：捕获 registerChannel / dispatchInbound / handleCallback。 */
function makeCtx() {
  const captured = { channel: null, inbound: [], callbacks: [] };
  const im = {
    registerChannel(ch) {
      captured.channel = ch;
      return () => {};
    },
    async dispatchInbound(msg) {
      captured.inbound.push(msg);
    },
    async handleCallback(cb) {
      captured.callbacks.push(cb);
    },
  };
  const ctx = {
    get: (k) => (k === 'im' ? im : undefined),
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  };
  return { ctx, captured };
}

/**
 * stub dingtalk-stream：记录订阅与连接，暴露触发下行事件的入口。
 * 关键：区分 registerCallbackListener（CALLBACK）与 registerAllEventListener（EVENT），
 * 这样"只订 EVENT 导致收不到机器人消息"这类回归会在测试里直接暴露。
 */
function makeSdkStub() {
  const state = {
    connected: false,
    listener: null,
    callbackTopics: [], // registerCallbackListener 注册的 topic
    allEventRegistered: false,
    subscriptions: [],
    acked: [],
    responses: [],
  };
  class DWClient {
    constructor(opts) {
      state.opts = opts;
      state.instance = this;
    }
    /** 复刻真实 SDK：CALLBACK 订阅会被 push 进 subscriptions。 */
    registerCallbackListener(topic, fn) {
      state.callbackTopics.push(topic);
      if (!state.subscriptions.some((s) => s.topic === topic && s.type === 'CALLBACK')) {
        state.subscriptions.push({ type: 'CALLBACK', topic });
      }
      state.listener = fn;
      return this;
    }
    /** 复刻真实 SDK：registerAllEventListener 只订阅 EVENT/*。 */
    registerAllEventListener(fn) {
      state.allEventRegistered = true;
      if (!state.subscriptions.some((s) => s.topic === '*' && s.type === 'EVENT')) {
        state.subscriptions.push({ type: 'EVENT', topic: '*' });
      }
      state.listener = fn;
      return this;
    }
    getConfig() {
      return { subscriptions: state.subscriptions };
    }
    async connect() {
      state.connected = true;
    }
    disconnect() {
      state.connected = false;
    }
    socketCallBackResponse(messageId, result) {
      state.responses.push({ messageId, result });
    }
  }
  return { sdk: { DWClient, TOPIC_ROBOT }, state };
}

const CREDS = { clientId: 'test-client-id', clientSecret: 'test-secret', robotCode: '' };

// ── 回归测试：机器人消息必须用 CALLBACK 订阅（真实环境踩过的坑） ──────────
//
// 症状：连接成功、status.connected=true，但永远收不到任何机器人消息。
// 根因：机器人消息与卡片回调都是 type=CALLBACK；registerAllEventListener 只订阅
//        EVENT/*（topic:'*' 不含 CALLBACK）。必须显式 registerCallbackListener。
// 依据：官方 Python SDK 对每个 callback handler 都 push {type:'CALLBACK', topic}。
// 这组测试锁死该行为——改回只订 EVENT 即变红。

test('回归：必须用 registerCallbackListener 订阅机器人消息 topic（CALLBACK）', async () => {
  const { ctx } = makeCtx();
  const { sdk, state } = makeSdkStub();
  apply(ctx, CREDS, { sdk });
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(
    state.callbackTopics.includes(TOPIC_ROBOT),
    `未订阅 CALLBACK ${TOPIC_ROBOT} —— 机器人消息永远收不到（本回归的由来）`,
  );
  const subs = state.subscriptions;
  assert.ok(
    subs.some((s) => s.type === 'CALLBACK' && s.topic === TOPIC_ROBOT),
    'CALLBACK 订阅必须真的进入 subscriptions（会被发给网关）',
  );
});

test('回归：卡片回调 topic 也必须是 CALLBACK 订阅', async () => {
  const { ctx } = makeCtx();
  const { sdk, state } = makeSdkStub();
  apply(ctx, CREDS, { sdk });
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(
    state.callbackTopics.includes(TOPIC_CARD),
    `未订阅 CALLBACK ${TOPIC_CARD} —— 审批卡片按钮收不到回调`,
  );
  assert.ok(
    state.subscriptions.some((s) => s.type === 'CALLBACK' && s.topic === TOPIC_CARD),
    '卡片 CALLBACK 订阅必须进入 subscriptions',
  );
});

test('回归：CALLBACK 与 EVENT 订阅并存（EVENT/* 不能替代 CALLBACK）', async () => {
  const { ctx } = makeCtx();
  const { sdk, state } = makeSdkStub();
  apply(ctx, CREDS, { sdk });
  await new Promise((r) => setTimeout(r, 10));

  // 两者都要有：EVENT/* 用于系统事件，CALLBACK 用于机器人消息
  assert.ok(state.allEventRegistered, 'registerAllEventListener 仍应保留');
  assert.equal(
    state.subscriptions.find((s) => s.topic === '*')?.type,
    'EVENT',
    "topic:'*' 只能是 EVENT 类型——它不是 CALLBACK 的替代品",
  );
  assert.ok(
    state.subscriptions.filter((s) => s.type === 'CALLBACK').length >= 2,
    '机器人与卡片两个 CALLBACK 订阅都应存在',
  );
});

test('stub SDK：注册渠道、连接成功、status 带 lastEventAt 心跳', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const dispose = apply(ctx, CREDS, { sdk });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(captured.channel.platform, 'dingtalk');
  assert.equal(typeof captured.channel.send, 'function');
  assert.equal(typeof captured.channel.sendFile, 'function');
  assert.equal(typeof captured.channel.dispose, 'function');
  assert.equal(state.connected, true);
  assert.equal(captured.channel.status.connected, true);
  // 可观测三件套：心跳字段必须存在
  assert.ok('lastEventAt' in captured.channel.status);
  await dispose();
  assert.equal(state.connected, false);
});

test('stub SDK：机器人消息 → ImMessage → dispatchInbound（含入站心跳）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  apply(ctx, CREDS, { sdk });
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(state.listener, 'CALLBACK listener 必须已注册（机器人消息走 CALLBACK）');
  const ack = state.listener({
    headers: { topic: TOPIC_ROBOT, messageId: 'm1' },
    data: JSON.stringify({
      msgtype: 'text',
      text: { content: ' 列出当前目录 ' },
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-9',
      senderNick: '张三',
      msgId: 'msg-1',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
      sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(ack.status, 'SUCCESS', '必须立即 ACK 避免服务端重推');
  assert.equal(captured.inbound.length, 1);
  const m = captured.inbound[0];
  assert.equal(m.platform, 'dingtalk');
  assert.equal(m.chatId, 'cid-1');
  assert.equal(m.userId, 'staff-9');
  assert.equal(m.userName, '张三');
  assert.equal(m.text, '列出当前目录');
  assert.equal(m.chatType, 'private');
  assert.equal(m.msgId, 'msg-1');
  assert.ok(captured.channel.status.lastEventAt > 0, '收到事件必须更新心跳');
});

test('stub SDK：卡片回调 → handleCallback（中性 approve 载荷）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  apply(ctx, CREDS, { sdk });
  await new Promise((r) => setTimeout(r, 10));

  state.listener({
    headers: { topic: TOPIC_CARD, messageId: 'card-1' },
    data: JSON.stringify({
      userId: 'staff-9',
      userName: '张三',
      conversationId: 'cid-1',
      content: JSON.stringify({ action: 'approve:ab12cd:yes' }),
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(captured.callbacks.length, 1);
  assert.deepEqual(captured.callbacks[0], {
    platform: 'dingtalk',
    chatId: 'cid-1',
    userId: 'staff-9',
    userName: '张三',
    data: 'approve:ab12cd:yes',
  });
  // 卡片必须回执，否则客户端转圈
  assert.equal(state.responses.length, 1);
  assert.equal(state.responses[0].messageId, 'card-1');
});

test('出站：sessionWebhook 优先，发送 markdown 载荷', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ errcode: 0 }) }  ;
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));

  // 先经入站学习 sessionWebhook
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' },
      conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 'staff-9', msgId: 'm1',
      sessionWebhook: 'https://hook.example/session', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  await captured.channel.send({ chatId: 'cid-1', text: '任务完成' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://hook.example/session');
  assert.equal(sent[0].body.msgtype, 'markdown');
  assert.equal(sent[0].body.markdown.text, '任务完成');
});

test('回归：机器人回推必须用 userId，不能用 conversationId（staffId.notExisted）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ processQueryKey: 'pq', invalidStaffIdList: [], filteredStaffIdList: [] }) };
  };
  apply(ctx, { clientId: 'ding-x', clientSecret: 's' }, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));

  // 入站：私聊场景，conversationId ≠ userId（钉钉真实形态）
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text',
      text: { content: 'hi' },
      conversationId: 'cidyOPAQUE+/==', // 会话级不透明串
      conversationType: '1',
      senderStaffId: '10001', // 真正的 userId（示例值）
      senderNick: '张三',
      msgId: 'm1',
      sessionWebhookExpiredTime: 0, // 无可用 webhook → 走机器人 API
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  await captured.channel.send({ chatId: 'cidyOPAQUE+/==', text: '回复' });
  assert.equal(calls.length, 1, '应走机器人推送');
  assert.deepEqual(
    calls[0].body.userIds,
    ['10001'],
    'userIds 必须是 senderStaffId（userId），传 conversationId 会 staffId.notExisted',
  );
});

test('回归：batchSend 返回 invalidStaffIdList 必须报错（HTTP 200 也会静默失败）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const fetchImpl = async (url) => {
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    // HTTP 200 但目标被拒 —— 这是钉钉的真实行为
    return { ok: true, json: async () => ({ processQueryKey: 'pq', invalidStaffIdList: ['bad-id'] }) };
  };
  apply(ctx, { clientId: 'ding-x', clientSecret: 's' }, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' },
      conversationId: 'c1', conversationType: '1', senderStaffId: 'bad-id',
      msgId: 'm1', sessionWebhookExpiredTime: 0,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  // 不得伪造成功：必须**上报失败**，核心据此 fail-closed。
  // （此前返回 {} 是静默失败，导致提问/审批记录永远停在 waiting。）
  const r = await captured.channel.send({ chatId: 'c1', text: 'x' });
  assert.equal(r.failed, true, 'invalidStaffIdList 非空时必须上报失败');
  assert.equal(r.reason, 'staffId.notExisted', '必须带平台错误码');
  assert.equal(r.messageId, undefined, '不得报告 messageId');
});

test('出站：核心下传 userId 时走机器人推送（robotCode 回退 clientId）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk } = makeSdkStub();
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ processQueryKey: 'pq-x', invalidStaffIdList: [] }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  // 核心层从持久化会话映射取到 userId 后下传（out.userId）
  const r = await captured.channel.send({ chatId: 'cidyOPAQUE+/==', userId: '10001', text: 'x' });
  assert.equal(r.messageId, 'pq-x');
  assert.deepEqual(calls[0].userIds, ['10001'], '必须用下传的 userId，而不是 conversationId');
});

test('回归：无 userId 且 chatId 是 conversationId 时，必须报错而不是发注定失败的请求', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk } = makeSdkStub();
  let pushed = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    pushed = true; // 不该走到这里
    return { ok: true, json: async () => ({ processQueryKey: 'pq' }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));

  // sessionWebhook 过期、且核心没给 userId → 必须放弃并上报失败
  const r = await captured.channel.send({ chatId: 'cidyOPAQUE+/==', text: 'x' });
  assert.equal(r.failed, true, '不应伪造成成功，必须上报失败');
  assert.equal(r.reason, 'no-userId');
  assert.equal(pushed, false, '不得把 conversationId 当 userId 发出去（会 staffId.notExisted）');
});

test('出站：机器人 API 报错必须带平台错误码（规则 #5 边界日志）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk } = makeSdkStub();
  const fetchImpl = async (url) => {
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    return { ok: false, status: 400, json: async () => ({ code: 'invalidParameter.robotCode.notExsit', message: 'robotCode 不存在' }) };
  };
  apply(ctx, { clientId: 'ding-x', clientSecret: 's' }, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  // 机器人 API 报错时必须上报失败（含平台错误码），不得伪造成功结果
  const r = await captured.channel.send({ chatId: 'u1', text: 'x' });
  assert.equal(r.failed, true, '失败时不得伪造成功结果');
  assert.ok(String(r.reason).length > 0, '必须带平台错误码/原因');
});

test('出站：robotCode 未配置时回退为 clientId（实测 Stream 机器人 robotCode == Client ID）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk } = makeSdkStub();
  const calls = [];
  const fetchImpl = async (url, init) => {
    // token 端点
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ processQueryKey: 'pq-1' }) };
  };
  // 不配 robotCode → 应回退为 clientId
  apply(ctx, { clientId: 'ding-abc', clientSecret: 'sec' }, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));

  // 无任何 sessionWebhook → 走机器人 API 分支（核心下传 userId）
  const r = await captured.channel.send({ chatId: 'staff-1', userId: '10001', text: '主动通知' });
  assert.equal(calls.length, 1, '应调用机器人推送 API');
  assert.equal(calls[0].body.robotCode, 'ding-abc', 'robotCode 必须回退为 clientId');
  assert.deepEqual(calls[0].body.userIds, ['10001']);
  assert.equal(r.messageId, 'pq-1');
});

test('回归：核心已把按钮渲染进正文时，适配器不得二次追加（单一真源）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  // 核心的约定：文本型渠道由核心拼好最终文本并清掉 buttons
  const text = '需要审批\n\n• 批准 → /approve ab12cd yes';
  await captured.channel.send({ chatId: 'cid-1', text });
  const out = sent[0].markdown.text;
  const occurrences = out.split('/approve ab12cd yes').length - 1;
  assert.equal(occurrences, 1, `命令不得重复出现（实际 ${occurrences} 次）`);
  assert.equal(out, text, '适配器必须原样发送核心给的最终文本');
});

test('回归：/log 不得改写正文（含 ``` 也逐字保留）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  const original = 'line one\n```js\nconsole.log(1)\n```\nline two';
  const r = await captured.channel.sendFile('cid-1', 'log.md', original, 'text/markdown');
  assert.notEqual(r.failed, true, '有 webhook 时应投递成功');
  const body = sent[sent.length - 1];
  // 必须用纯 text：markdown 会解析正文里的 ```，且可能被正文自身闭合 → 渲染乱套
  assert.equal(body.msgtype, 'text', '全文交付必须用纯 text 消息类型（不做 markdown 解析）');
  const delivered = body.text.content;
  assert.ok(delivered.includes(original), '交付内容必须逐字保留原文（不得改写 ``` / 加围栏）');
});

test('回归：/log 10 段以上时每段仍不超字节上限（序号预留随段数增长）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  // 造出 >10 段：`(10/12)` 比 `(1/2)` 多 5 字节，旧的固定 8 字节预留会失守
  const big = '中'.repeat(14000);   // 42000 字节 → 约 15 段
  const r = await captured.channel.sendFile('cid-1', 'big.log', big, 'text/markdown');
  assert.notEqual(r.failed, true, '应投递成功');
  assert.ok(sent.length >= 10, `应产生 10 段以上（实际 ${sent.length}）`);
  for (const b of sent) {
    assert.equal(b.msgtype, 'text');
    const n = Buffer.byteLength(b.text.content, 'utf8');
    assert.ok(n <= 3000, `每段必须 ≤3000 字节（实际 ${n}，共 ${sent.length} 段）`);
  }
  // 无损：按序去掉 header 与序号后拼回应等于原文
  const rejoined = sent.map((b) => b.text.content.replace(/^📎 [^\n]*\n\n/, '')).join('');
  assert.equal(rejoined, big, '分段必须无损');
});

test('回归：超长文件名（含 sessionId）不得让单条消息超限', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  // 文件名含超长 sessionId（真实形态：im-<sessionId>.md）
  const longName = `im-${'x'.repeat(4000)}.md`;
  const r = await captured.channel.sendFile('cid-1', longName, '正文内容', 'text/markdown');
  assert.notEqual(r.failed, true, '应投递成功');
  for (const b of sent) {
    const n = Buffer.byteLength(b.text.content, 'utf8');
    // round-5 发现 3：标题膨胀会吃光预算，导致最终仍超限
    assert.ok(n <= 3000, `超长文件名下单条仍须 ≤3000 字节（实际 ${n}）`);
  }
  assert.ok(sent[0].text.content.includes('正文内容'), '正文必须完整送达');
  assert.ok(sent[0].text.content.includes('…'), '超长文件名应被无损缩短显示');
});

test('回归：sessionWebhook 已过期时 sendFile 必须上报失败（不得盲投旧 URL）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  let posted = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tok', expires_in: 7200 }) };
    }
    posted = true;
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1',
      sessionWebhook: 'https://hook.example/old',
      sessionWebhookExpiredTime: Date.now() - 60_000,   // 已过期
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  const r = await captured.channel.sendFile('cid-1', 'log.md', '全文内容', 'text/markdown');
  // round-6 P2：deliver() 会检查过期并回退，sendFile 此前不检查 → 盲投旧 URL
  assert.equal(r.failed, true, '过期 webhook 必须上报失败');
  assert.equal(r.reason, 'webhook-expired');
  assert.equal(posted, false, '不得向已过期的 URL 投递');
});

test('回归：无 sessionWebhook 时 sendFile 必须上报失败（不得静默成功）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk } = makeSdkStub();
  apply(ctx, CREDS, { sdk, fetchImpl: async () => ({ ok: true, json: async () => ({ errcode: 0 }) }) });
  await new Promise((r) => setTimeout(r, 10));
  // 从未收到入站消息 ⇒ 没有 sessionWebhook
  const r = await captured.channel.sendFile('nobody', 'log.md', 'content', 'text/markdown');
  assert.equal(r.failed, true, '无投递路径必须上报失败');
  assert.equal(r.reason, 'no-delivery-path');
});

test('回归：只有按钮没有正文时，仍把按钮命令作为正文送出（不得静默丢弃）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  await captured.channel.send({
    chatId: 'cid-1',
    buttons: [{ id: 'approve:ab:yes', label: '✅ 批准', command: '/approve ab yes' }],
  });
  const out = sent[sent.length - 1].markdown.text;
  assert.ok(out.includes('/approve ab yes'), '按钮命令必须出现在正文（此前被静默丢弃）');
});

test('出站：按钮降级为文本命令（钉钉 webhook 无内联按钮）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  await captured.channel.send({
    chatId: 'cid-1',
    text: '⚠️ 需要审批',
    buttons: [
      { id: 'approve:ab12cd:yes', label: '✅ 批准' },
      { id: 'approve:ab12cd:no', label: '❌ 拒绝' },
    ],
  });
  assert.equal(sent.length, 1);
  const text = sent[0].markdown.text;
  assert.ok(text.includes('approve:ab12cd:yes'), '按钮 id 必须出现在文本命令中');
  assert.ok(text.includes('✅ 批准'));
});

test('出站：有 command 时降级为友好命令，而非内部 callback 载荷', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  await captured.channel.send({
    chatId: 'cid-1',
    text: '⚠️ 需要审批',
    buttons: [
      { id: 'approve:ab12cd:yes', label: '✅ 批准', command: '/approve ab12cd yes' },
      { id: 'approve:ab12cd:no', label: '❌ 拒绝', command: '/approve ab12cd no' },
    ],
  });
  const text = sent[0].markdown.text;
  assert.ok(text.includes('/approve ab12cd yes'), '应展示可复制的友好命令');
  assert.ok(!text.includes('approve:ab12cd:yes'), '不应把内部 callback 载荷暴露给用户');
});

test('出站：正文已含该命令时不重复追加（钉钉去噪）', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  apply(ctx, CREDS, { sdk, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  state.listener({
    headers: { topic: TOPIC_ROBOT },
    data: JSON.stringify({
      msgtype: 'text', text: { content: 'hi' }, conversationId: 'cid-1', conversationType: '1',
      senderStaffId: 's', msgId: 'm1', sessionWebhook: 'https://hook.example/s', sessionWebhookExpiredTime: Date.now() + 3600_000,
    }),
  });
  await new Promise((r) => setTimeout(r, 10));

  // 正文自带用法（核心的提问/审批卡片都是这样）
  await captured.channel.send({
    chatId: 'cid-1',
    text: '❓ 需要确认\n  1. A\n  2. B\n\n回复：`/answer 01 1` 或 `/answer 01 2`',
    buttons: [
      { id: 'q:01:0:0', label: '1. A', command: '/answer 01 1' },
      { id: 'q:01:0:1', label: '2. B', command: '/answer 01 2' },
    ],
  });
  const text = sent[0].markdown.text;
  const occurrences = text.split('/answer 01 1').length - 1;
  assert.equal(occurrences, 1, '正文已有的命令不应被追加第二遍');
  assert.ok(!text.includes('→'), '不应出现重复的按钮文案块');
});

test('缺凭据：status 断开并给出可操作提示，不抛错', async () => {
  const { ctx, captured } = makeCtx();
  const { sdk, state } = makeSdkStub();
  apply(ctx, { clientId: '', clientSecret: '' }, { sdk });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(captured.channel.status.connected, false);
  assert.match(captured.channel.status.detail, /missing clientId/);
  assert.equal(state.connected, false, '缺凭据不得尝试连接');
  // 仍必须满足契约
  assert.ok('lastEventAt' in captured.channel.status);
});

test('连接失败：status 记录错误、不崩溃', async () => {
  const { ctx, captured } = makeCtx();
  class FailingClient {
    registerAllEventListener() { return this; }
    registerCallbackListener() { return this; }
    async connect() { throw new Error('gateway refused'); }
    disconnect() {}
  }
  apply(ctx, CREDS, { sdk: { DWClient: FailingClient, TOPIC_ROBOT } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(captured.channel.status.connected, false);
  assert.match(captured.channel.status.detail, /gateway refused/);
});

// ── 纯函数单测（规则 #8：无网络） ──────────────────────────────────────────

test('parseContent：text/markdown/richText/picture/file + 未知降级', () => {
  assert.equal(parseContent('text', { text: { content: '  你好 ' } }), '你好');
  assert.equal(parseContent('markdown', { markdown: { text: '**粗体**' } }), '**粗体**');
  assert.equal(
    parseContent('richText', { content: { richText: [[{ text: '第一行' }], [{ text: '第二行' }, { type: 'picture' }]] } }),
    '第一行\n第二行[图片]',
  );
  assert.equal(parseContent('picture', {}), '[图片]');
  assert.equal(parseContent('file', { content: { fileName: 'a.txt' } }), '[文件] a.txt');
  assert.equal(parseContent('audio', {}), '');
  assert.equal(parseContent('', {}), '');
});

test('stripAt：去掉 @机器人 前导空白', () => {
  assert.equal(stripAt('  任务'), '任务');
  assert.equal(stripAt('\u2005任务'), '任务');
  assert.equal(stripAt(''), '');
  assert.equal(stripAt(null), '');
});

test('parseCardCallback：多种载荷形状 + 无效输入', () => {
  // 操作人在外层、按钮 value 内层 —— 两个层级都要能取到
  const outer = parseCardCallback({ content: JSON.stringify({ action: 'approve:a:yes' }), userId: 'u1', userName: '张三', conversationId: 'c1' });
  assert.equal(outer.data, 'approve:a:yes');
  assert.equal(outer.userId, 'u1');
  assert.equal(outer.userName, '张三', '操作人昵称在外层时必须保留');
  assert.equal(outer.chatId, 'c1');
  // 内层带身份时也能兜底
  const inner = parseCardCallback({ content: JSON.stringify({ data: 'trust:dingtalk:u1', userId: 'in1', nick: '李四' }) });
  assert.equal(inner.data, 'trust:dingtalk:u1');
  assert.equal(inner.userId, 'in1');
  assert.equal(inner.userName, '李四');
  assert.equal(parseCardCallback({ content: JSON.stringify({ value: { action: 'approve:b:no' } }) }).data, 'approve:b:no');
  assert.equal(parseCardCallback({}), null);
  assert.equal(parseCardCallback(null), null);
  assert.equal(parseCardCallback({ content: 'not-json' }).data, 'not-json');
});

test('normalizeRobotMessage：群聊/私聊判定与字段兜底', () => {
  const group = normalizeRobotMessage({ conversationType: '2', conversationId: 'g1', senderStaffId: 's1', senderNick: 'N', msgtype: 'text', text: { content: 'hi' } });
  assert.equal(group.chatType, 'group');
  const priv = normalizeRobotMessage({ conversationType: '1', conversationId: 'p1', senderStaffId: 's1', msgtype: 'text', text: { content: 'hi' } });
  assert.equal(priv.chatType, 'private');
  // chatId 兜底到 senderStaffId
  assert.equal(normalizeRobotMessage({ senderStaffId: 'only-staff', msgtype: 'text', text: { content: 'x' } }).chatId, 'only-staff');
});

test('buttonsAsCommands：按钮 → 可复制文本命令', () => {
  const s = buttonsAsCommands([{ id: 'approve:1:yes', label: '✅ 批准' }]);
  assert.ok(s.includes('approve:1:yes'));
  assert.ok(s.includes('✅ 批准'));
  assert.equal(buttonsAsCommands([]), '');
});