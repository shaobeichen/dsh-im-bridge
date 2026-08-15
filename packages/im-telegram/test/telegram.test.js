// dsh-im-telegram 适配器测试（假 Telegram Bot API 服务器，无需真实 token）
//
// 验证协议 ⇄ 统一模型转换：
//   - 入站 message/callback_query → ImMessage / handleCallback 载荷
//   - 出站 sendMessage（含审批按钮 reply_markup）/ sendDocument
//   - 断线重连（指数退避）与致命错误（401）停止
//   - env: 密钥引用

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { apply, resolveSecret } from '../lib/index.js';

/** 假 Telegram Bot API 服务器。 */
function createFakeApi({ token = 'TESTTOKEN' } = {}) {
  const sentMessages = [];
  const sentDocuments = [];
  const callbacks = [];
  const updatesQueue = [];
  let getUpdatesCount = 0;
  let failNextGetUpdates = false;
  let fatalNextGetUpdates = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const body = await readBody(req);
    let parsedBody;
    try {
      parsedBody = body ? JSON.parse(body) : undefined;
    } catch {
      parsedBody = body || undefined;
    }
    callbacks.push({ method: path.split('/').pop(), query: Object.fromEntries(url.searchParams), body: parsedBody });

    const respond = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (path === `/bot${token}/getMe`) return respond({ ok: true, result: { id: 1, username: 'testbot' } });
    if (path === `/bot${token}/getUpdates`) {
      getUpdatesCount++;
      if (fatalNextGetUpdates) {
        fatalNextGetUpdates = false;
        return respond({ ok: false, error_code: 401, description: 'Unauthorized' });
      }
      if (failNextGetUpdates) {
        failNextGetUpdates = false;
        res.writeHead(500);
        return res.end('boom');
      }
      if (updatesQueue.length) return respond({ ok: true, result: [updatesQueue.shift()] });
      return respond({ ok: true, result: [] });
    }
    if (path === `/bot${token}/getFile`) {
      return respond({ ok: true, result: { file_id: 'FILE1', file_path: 'docs/notes.txt' } });
    }
    if (path.startsWith(`/file/bot${token}/`)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('file-content');
    }
    if (path === `/bot${token}/sendMessage`) {
      const parsed = JSON.parse(body);
      sentMessages.push(parsed);
      return respond({ ok: true, result: { message_id: sentMessages.length } });
    }
    if (path === `/bot${token}/sendDocument`) {
      sentDocuments.push({ headers: req.headers['content-type'] });
      return respond({ ok: true, result: { message_id: sentDocuments.length } });
    }
    if (path === `/bot${token}/answerCallbackQuery`) return respond({ ok: true });
    respond({ ok: false, error_code: 404, description: `unknown ${path}` });
  });

  const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  return {
    server,
    listen,
    sentMessages,
    sentDocuments,
    callbacks,
    updatesQueue,
    getUpdatesCount: () => getUpdatesCount,
    failNext() { failNextGetUpdates = true; },
    fatalNext() { fatalNextGetUpdates = true; },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

/** 假 ctx.im（记录入站调用 + 保留注册的渠道以测出站）。 */
function fakeIm() {
  const inbound = [];
  const callbacks = [];
  const channels = new Map();
  return {
    inbound,
    callbacks,
    channels,
    registerChannel(channel) {
      channels.set(channel.platform, channel);
      channel.attach?.(this);
    },
    async dispatchInbound(msg) { inbound.push(msg); },
    async handleCallback(payload) { callbacks.push(payload); },
  };
}

function fakeCtx(im) {
  return {
    get: () => im,
    logger: () => ({
      info() {},
      warn(...args) { console.error('[tg:warn]', ...args); },
      error(...args) { console.error('[tg:error]', ...args); },
      debug() {},
    }),
  };
}

function messageUpdate(overrides = {}) {
  return {
    update_id: 1001,
    message: {
      message_id: 7,
      from: { id: 123456, first_name: 'Alice', last_name: 'W' },
      chat: { id: 123456, type: 'private' },
      text: '/status',
      date: Math.floor(Date.now() / 1000),
      ...overrides,
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await wait(40);
  }
  throw new Error('timeout');
};

test('env: 密钥引用', () => {
  process.env.TG_TEST_TOKEN = 'abc';
  assert.equal(resolveSecret('env:TG_TEST_TOKEN'), 'abc');
  assert.equal(resolveSecret('plain-token'), 'plain-token');
  delete process.env.TG_TEST_TOKEN;
});


/** 每个测试独立起一个假 API（避免跨测试的 poller 竞态）。 */
async function withFakeApi(fn) {
  const fake = createFakeApi();
  const port = await fake.listen();
  try {
    await fn(fake, `http://127.0.0.1:${port}`);
  } finally {
    await fake.close();
  }
}

test('入站：message → ImMessage 统一模型', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  fakeApi.updatesQueue.push(messageUpdate({ text: '跑一下 pytest' }));
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 50 });
  try {
    const msg = await waitFor(() => im.inbound[0]);
    assert.equal(msg.platform, 'telegram');
    assert.equal(msg.chatId, '123456');
    assert.equal(msg.userId, '123456');
    assert.equal(msg.userName, 'Alice W');
    assert.equal(msg.text, '跑一下 pytest');
    assert.equal(msg.msgId, '7');
    assert.equal(msg.chatType, 'private');
  } finally {
    dispose();
  }
  });
});

test('入站：群聊 + 附件 → chatType=group + attachments', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  fakeApi.updatesQueue.push(messageUpdate({
    text: undefined, // 带 caption 的消息没有 text
    chat: { id: -100999, type: 'supergroup', title: 'Dev Team' },
    document: { file_id: 'FILE1', file_name: 'notes.txt' },
    caption: '看这个文件',
  }));
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 50 });
  try {
    const msg = await waitFor(() => im.inbound[0]);
    assert.equal(msg.chatId, '-100999');
    assert.equal(msg.chatType, 'group');
    assert.equal(msg.text, '看这个文件');
    assert.equal(msg.attachments[0].kind, 'file');
    assert.equal(msg.attachments[0].name, 'notes.txt');
    assert.ok(msg.attachments[0].path, '文件已下载到本地');
  } finally {
    dispose();
  }
  });
});

test('入站：callback_query → handleCallback（审批按钮）', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  fakeApi.updatesQueue.push({
    update_id: 1002,
    callback_query: {
      id: 'cq1',
      from: { id: 555, first_name: 'Bob' },
      message: { message_id: 9, chat: { id: 555, type: 'private' } },
      data: 'approve:a1b2c3d4:yes',
    },
  });
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 50 });
  try {
    const cb = await waitFor(() => im.callbacks[0]);
    assert.equal(cb.data, 'approve:a1b2c3d4:yes');
    assert.equal(cb.platform, 'telegram');
    assert.equal(cb.userId, '555');
    assert.equal(cb.userName, 'Bob');
  } finally {
    dispose();
  }
  });
});

test('出站：sendMessage 文本 + 审批按钮 reply_markup', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 50 });
  try {
    await im.channels.get('telegram').send({
      chatId: '123456',
      text: '🔐 审批请求 #abc',
      buttons: [
        { id: 'approve:abc:yes', label: '✅ 批准' },
        { id: 'approve:abc:no', label: '❌ 拒绝' },
      ],
    });
    const sent = fakeApi.sentMessages[0];
    assert.equal(sent.chat_id, '123456');
    assert.equal(sent.text, '🔐 审批请求 #abc');
    assert.deepEqual(sent.reply_markup.inline_keyboard, [
      [{ text: '✅ 批准', callback_data: 'approve:abc:yes' }, { text: '❌ 拒绝', callback_data: 'approve:abc:no' }],
    ]);
  } finally {
    dispose();
  }
  });
});

test('出站：sendDocument（/log 全量交付）', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 50 });
  try {
    await im.channels.get('telegram').sendFile('123456', 'im-log.md', 'full output content', 'text/markdown');
    await waitFor(() => fakeApi.sentDocuments.length > 0);
    assert.equal(fakeApi.sentDocuments.length, 1);
  } finally {
    dispose();
  }
  });
});

test('断线重连：500 后指数退避恢复，连接状态可见（FR-1.5）', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  fakeApi.failNext();
  fakeApi.updatesQueue.push(messageUpdate({ text: 'hi' }));
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 50 });
  try {
    await waitFor(() => im.inbound[0]); // 失败后仍能恢复并收到消息
    const ch = im.channels.get('telegram');
    assert.equal(ch.status.connected, true);
  } finally {
    dispose();
  }
  });
});

test('致命错误（401 无效 token）：停止轮询并标记断开', async () => {
  await withFakeApi(async (fakeApi, apiBase) => {
  const im = fakeIm();
  fakeApi.fatalNext();
  const dispose = apply(fakeCtx(im), { token: 'TESTTOKEN', apiBase, pollIntervalMs: 30 });
  try {
    const ch = im.channels.get('telegram');
    // 等轮询遇 401 后 fatal 断开（getMe 成功后首次 getUpdates 即 401）
    await waitFor(() => /fatal|401/i.test(ch.status.detail), 3000);
    const count = fakeApi.getUpdatesCount();
    await wait(200);
    assert.equal(fakeApi.getUpdatesCount(), count, '401 后不应继续轮询');
  } finally {
    dispose();
  }
  });
});
