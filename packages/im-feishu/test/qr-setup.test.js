// 飞书扫码接入测试（stub 官方 registerApp，无需真实凭据/网络）
//
// 验证：
//   1. resolveSecret 的扫码凭据回退（env 空 → credentials 文件）
//   2. env 优先于扫码文件
//   3. runQrSetup：registerApp 调用参数（addons 预填）、二维码回调、凭据落盘 0600
//   4. 注册失败（无 client_id/client_secret）→ 抛错

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSecret } from '../lib/index.js';
import { runQrSetup, QR_ADDONS } from '../lib/qr-setup.js';

/** 建好目录再写凭据文件（对齐 runQrSetup 的落盘路径）。 */
async function writeCreds(home, creds) {
  await mkdir(join(home, 'dsh-im'), { recursive: true });
  await writeFile(join(home, 'dsh-im', 'feishu-credentials.json'), JSON.stringify(creds));
}

/** Stub 官方 SDK 的 registerApp。 */
function fakeLark({ result = null } = {}) {
  const calls = [];
  const registerApp = async (options) => {
    calls.push(options);
    options.onQRCodeReady?.({ url: 'https://open.feishu.cn/qr/abc', expireIn: 600 });
    options.onStatusChange?.({ status: 'polling', interval: 2 });
    if (result) return result;
    return { client_id: 'cli_test', client_secret: 'sec_test', user_info: { open_id: 'ou_scan', tenant_brand: 'feishu' } };
  };
  return { lark: { registerApp }, calls };
}

test('QR_ADDONS 预填清单与手动配置一致（权限/事件/回调）', () => {
  assert.deepEqual(QR_ADDONS.scopes.tenant, ['im:message:send_as_bot', 'im:message.p2p_msg:readonly']);
  assert.deepEqual(QR_ADDONS.events.items.tenant, ['im.message.receive_v1']);
  assert.deepEqual(QR_ADDONS.callbacks.items, ['card.action.trigger']);
});

test('resolveSecret：env 为空时回退扫码凭据文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qr-home-'));
  await writeCreds(home, { appId: 'cli_file', appSecret: 'sec_file' });
  assert.equal(resolveSecret('env:FEISHU_APP_ID', { home, env: {} }), 'cli_file');
  assert.equal(resolveSecret('env:FEISHU_APP_SECRET', { home, env: {} }), 'sec_file');
});

test('resolveSecret：env 优先于扫码文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qr-home-'));
  await writeCreds(home, { appId: 'cli_file', appSecret: 'sec_file' });
  assert.equal(resolveSecret('env:FEISHU_APP_ID', { home, env: { FEISHU_APP_ID: 'cli_env' } }), 'cli_env');
});

test('resolveSecret：无文件且 env 空 → 空串（优雅断开路径）', () => {
  assert.equal(resolveSecret('env:FEISHU_APP_ID', { home: '/nonexistent/home', env: {} }), '');
});

test('runQrSetup：扫码成功 → 二维码回调 + 凭据落盘（0600）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qr-home-'));
  const { lark, calls } = fakeLark();
  const rendered = [];
  const logs = [];
  const res = await runQrSetup({
    lark,
    home,
    renderQr: (url) => rendered.push(url),
    log: (line) => logs.push(line),
  });

  assert.equal(rendered[0], 'https://open.feishu.cn/qr/abc', 'onQRCodeReady 触发渲染');
  assert.deepEqual(calls[0].addons, QR_ADDONS, 'addons 预填透传');
  assert.equal(calls[0].appPreset.name, 'DSH 智能体（{user}）');
  assert.equal(res.appId, 'cli_test');

  const raw = JSON.parse(await readFile(res.credFile, 'utf8'));
  assert.equal(raw.appId, 'cli_test');
  assert.equal(raw.appSecret, 'sec_test');
  assert.equal(raw.scannedBy, 'ou_scan');
  const mode = (await stat(res.credFile)).mode & 0o777;
  assert.equal(mode, 0o600, '凭据文件仅本机可读');
  assert.ok(logs.some((l) => l.includes('✅')), '成功日志');
});

test('runQrSetup：注册未返回凭据 → 抛错，不写文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qr-home-'));
  const { lark } = fakeLark({ result: { client_id: '', client_secret: '' } });
  await assert.rejects(
    () => runQrSetup({ lark, home }),
    /no credentials/
  );
  await assert.rejects(readFile(join(home, 'dsh-im', 'feishu-credentials.json')), /ENOENT/);
});
