// 微信 Web RPC 测试（stub iLink api + stub connection.rpc，无网络/无凭据）
//
// 验证：status / bind.begin / bind.poll / verifycode.submit / bind.cancel 端点；
//       配对数字注入；凭据落盘；bot_token 不出现在任何浏览器可见数据里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installWeixinWebRpc } from '../lib/web-rpc.js';
import { createWeixinBindSession } from '../lib/provision.js';
import { WEIXIN_RPC_CHANNEL, WEIXIN_ENDPOINTS } from '../client/api.js';

function fakeCtxConnection() {
  let handler = null;
  const handle = (channel, fn, opts) => {
    assert.equal(channel, WEIXIN_RPC_CHANNEL);
    assert.deepEqual(opts, { authority: 'loopback' });
    handler = fn;
    return () => { handler = null; };
  };
  return { rpc: { handle }, get handler() { return handler; } };
}

/** 按脚本播放 pollLogin 状态；confirmed 返回完整凭据。 */
function scriptedApi(statuses) {
  let idx = 0;
  return {
    async beginLogin() {
      return { qrcode: 'qr_1', qrcodeUrl: 'https://weixin.qq.com/qr/1' };
    },
    async pollLogin({ verifyCode }) {
      const status = statuses[Math.min(idx++, statuses.length - 1)];
      if (status === 'confirmed') {
        return { status, bot_token: 'tok_web', ilink_bot_id: 'ilink_bot_web', ilink_user_id: 'wxid_web', baseurl: 'ilinkai.weixin.qq.com' };
      }
      return { status };
    },
  };
}

async function pollUntil(conn, endpoint, phase, maxWait = 2000) {
  const deadline = Date.now() + maxWait;
  let value;
  while (Date.now() < deadline) {
    const res = await conn.handler(endpoint, {});
    value = res.value;
    if (value.phase === phase) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  return value;
}

test('RPC：status 返回连接状态', async () => {
  const conn = fakeCtxConnection();
  installWeixinWebRpc({ connection: conn }, {
    session: createWeixinBindSession({ api: scriptedApi(['confirmed']), home: '/tmp/x' }),
    getStatus: () => ({ connected: true, detail: 'long-poll active', lastEventAt: 456 }),
    log: { error() {}, warn() {} },
  });
  const res = await conn.handler(WEIXIN_ENDPOINTS.status, {});
  assert.equal(res.ok, true);
  assert.equal(res.value.connected, true);
  assert.equal(res.value.lastEventAt, 456);
});

test('RPC：bind.begin → 二维码 → confirmed → 凭据落盘且无 token 泄漏', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-web-'));
  const conn = fakeCtxConnection();
  installWeixinWebRpc({ connection: conn }, {
    session: createWeixinBindSession({ api: scriptedApi(['wait', 'scaned', 'confirmed']), home }),
    getStatus: () => ({ connected: false, detail: 'starting', lastEventAt: null }),
    log: { error() {}, warn() {} },
  });

  const began = await conn.handler(WEIXIN_ENDPOINTS.beginBinding, {});
  assert.equal(began.ok, true);
  assert.ok(!JSON.stringify(began).includes('tok_web'), 'bot_token 不得出现在 RPC 响应');

  const done = await pollUntil(conn, WEIXIN_ENDPOINTS.pollBinding, 'succeeded');
  assert.equal(done.phase, 'succeeded');
  assert.equal(done.accountId, 'ilink_bot_web');
  const raw = JSON.stringify(done);
  assert.ok(!raw.includes('tok_web'), '成功态也不得含 bot_token');

  const creds = JSON.parse(await readFile(join(home, 'dsh-im', 'weixin-credentials.json'), 'utf8'));
  assert.equal(creds.botToken, 'tok_web');
  assert.equal(creds.accountId, 'ilink_bot_web');
});

test('RPC：need_verifycode → submitVerifyCode → confirmed（配对数字注入）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-web-'));
  const conn = fakeCtxConnection();
  installWeixinWebRpc({ connection: conn }, {
    session: createWeixinBindSession({ api: scriptedApi(['need_verifycode', 'confirmed']), home }),
    getStatus: () => ({ connected: false, detail: '', lastEventAt: null }),
    log: { error() {}, warn() {} },
  });

  await conn.handler(WEIXIN_ENDPOINTS.beginBinding, {});
  const pending = await pollUntil(conn, WEIXIN_ENDPOINTS.pollBinding, 'need_verifycode');
  assert.equal(pending.phase, 'need_verifycode');

  const bad = await conn.handler(WEIXIN_ENDPOINTS.submitVerifyCode, { code: '' });
  assert.equal(bad.ok, false);

  const sub = await conn.handler(WEIXIN_ENDPOINTS.submitVerifyCode, { code: '5678' });
  assert.equal(sub.ok, true);

  const done = await pollUntil(conn, WEIXIN_ENDPOINTS.pollBinding, 'succeeded');
  assert.equal(done.phase, 'succeeded');
});

test('RPC：expired / 未知端点 / cancel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-web-'));
  const conn = fakeCtxConnection();
  installWeixinWebRpc({ connection: conn }, {
    session: createWeixinBindSession({ api: scriptedApi(['expired']), home }),
    getStatus: () => ({ connected: false, detail: '', lastEventAt: null }),
    log: { error() {}, warn() {} },
  });
  await conn.handler(WEIXIN_ENDPOINTS.beginBinding, {});
  const expired = await pollUntil(conn, WEIXIN_ENDPOINTS.pollBinding, 'expired');
  assert.equal(expired.phase, 'expired');

  const unknown = await conn.handler('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-request');

  const cancelled = await conn.handler(WEIXIN_ENDPOINTS.cancelBinding, {});
  assert.equal(cancelled.value.phase, 'cancelled');
});
