// 飞书 Web RPC 测试（stub connection.rpc + stub registerApp，无网络/无凭据）
//
// 验证：status / qr.begin / qr.poll / qr.cancel 端点；凭据落盘；
//       App Secret 不出现在任何返回给浏览器的数据里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFeishuWebRpc } from '../lib/web-rpc.js';
import { createFeishuProvisionSession } from '../lib/provision.js';
import { FEISHU_RPC_CHANNEL, FEISHU_ENDPOINTS } from '../client/api.js';

/** 捕获 handler 的假 connection.rpc。 */
function fakeCtxConnection() {
  let handler = null;
  const handle = (channel, fn, opts) => {
    assert.equal(channel, FEISHU_RPC_CHANNEL);
    assert.deepEqual(opts, { authority: 'loopback' });
    handler = fn;
    return () => { handler = null; };
  };
  return { rpc: { handle }, get handler() { return handler; } };
}

function fakeLark({ fail = false } = {}) {
  return {
    registerApp: async ({ onQRCodeReady, onStatusChange }) => {
      onQRCodeReady({ url: 'https://open.feishu.cn/qr/abc', expireIn: 600 });
      onStatusChange?.({ status: 'polling', interval: 2 });
      if (fail) throw new Error('boom');
      return { client_id: 'cli_web', client_secret: 'sec_web', user_info: { open_id: 'ou_scan' } };
    },
  };
}

test('RPC：status 返回连接状态（含心跳）', async () => {
  const conn = fakeCtxConnection();
  const status = { connected: true, detail: 'long connection ready', lastEventAt: 123 };
  installFeishuWebRpc({ connection: conn }, {
    session: createFeishuProvisionSession({ lark: fakeLark(), home: '/tmp/x' }),
    getStatus: () => status,
    log: { error() {}, warn() {} },
  });
  const res = await conn.handler(FEISHU_ENDPOINTS.status, {});
  assert.equal(res.ok, true);
  assert.equal(res.value.connected, true);
  assert.equal(res.value.lastEventAt, 123);
});

test('RPC：qr.begin → qr.poll → 凭据落盘且无 Secret 泄漏', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fx-web-'));
  const conn = fakeCtxConnection();
  installFeishuWebRpc({ connection: conn }, {
    session: createFeishuProvisionSession({ lark: fakeLark(), home }),
    getStatus: () => ({ connected: false, detail: 'starting', lastEventAt: null }),
    log: { error() {}, warn() {} },
  });

  const began = await conn.handler(FEISHU_ENDPOINTS.beginProvisioning, {});
  assert.equal(began.ok, true);
  const raw = JSON.stringify(began);
  assert.ok(!raw.includes('sec_web'), 'App Secret 不得出现在 RPC 响应');

  // qr 阶段
  const qr = await conn.handler(FEISHU_ENDPOINTS.pollProvisioning, {});
  assert.equal(qr.ok, true);
  const rawQr = JSON.stringify(qr);
  assert.ok(!rawQr.includes('sec_web'), 'qr 阶段也不得含 Secret');
  assert.ok(rawQr.includes('qrDataUrl') || qr.value.phase === 'succeeded', '二维码或已成功');

  // 等 registerApp 完成 → succeeded + 凭据落盘
  let phase = qr.value.phase;
  for (let i = 0; i < 50 && phase !== 'succeeded'; i++) {
    await new Promise((r) => setTimeout(r, 20));
    phase = (await conn.handler(FEISHU_ENDPOINTS.pollProvisioning, {})).value.phase;
  }
  assert.equal(phase, 'succeeded');
  const creds = JSON.parse(await readFile(join(home, 'dsh-im', 'feishu-credentials.json'), 'utf8'));
  assert.equal(creds.appId, 'cli_web');
  assert.equal(creds.appSecret, 'sec_web');
  const finalRaw = JSON.stringify(await conn.handler(FEISHU_ENDPOINTS.pollProvisioning, {}));
  assert.ok(!finalRaw.includes('sec_web'), '成功态也不得含 Secret');
});

test('RPC：注册失败 → error 状态；cancel → cancelled；未知端点 → bad-request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fx-web-'));
  const conn = fakeCtxConnection();
  installFeishuWebRpc({ connection: conn }, {
    session: createFeishuProvisionSession({ lark: fakeLark({ fail: true }), home }),
    getStatus: () => ({ connected: false, detail: '', lastEventAt: null }),
    log: { error() {}, warn() {} },
  });
  await conn.handler(FEISHU_ENDPOINTS.beginProvisioning, {});
  let phase = '';
  for (let i = 0; i < 50 && phase !== 'error'; i++) {
    await new Promise((r) => setTimeout(r, 20));
    phase = (await conn.handler(FEISHU_ENDPOINTS.pollProvisioning, {})).value.phase;
  }
  assert.equal(phase, 'error');

  const cancelled = await conn.handler(FEISHU_ENDPOINTS.cancelProvisioning, {});
  assert.equal(cancelled.value.phase, 'cancelled');

  const unknown = await conn.handler('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-request');
});
