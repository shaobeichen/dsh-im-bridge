// 微信扫码绑定状态机测试（stub api，无需网络）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runQrBind } from '../lib/qr-bind.js';

/** 按脚本播放 pollLogin 状态；confirmed 返回完整凭据。 */
function scriptedApi(statuses, { readLineImpl } = {}) {
  let idx = 0;
  return {
    async beginLogin() {
      return { qrcode: 'qr_1', qrcodeUrl: 'https://weixin.qq.com/qr/1' };
    },
    async pollLogin({ verifyCode }) {
      const status = statuses[Math.min(idx++, statuses.length - 1)];
      if (status === 'confirmed') {
        return { status, bot_token: 'tok_1', ilink_bot_id: 'ilink_bot_1', ilink_user_id: 'wxid_1', baseurl: 'ilinkai.weixin.qq.com' };
      }
      if (status === 'need_verifycode') {
        const code = readLineImpl ? readLineImpl() : '1234';
        return { status, ...(code ? {} : {}) };
      }
      return { status };
    },
  };
}

test('扫码 → 确认 → 凭据落盘（0600）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-bind-'));
  const rendered = [];
  const logs = [];
  const res = await runQrBind({
    api: scriptedApi(['wait', 'scaned', 'confirmed']),
    home,
    renderQr: (url) => rendered.push(url),
    log: (l) => logs.push(l),
  });
  assert.equal(rendered[0], 'https://weixin.qq.com/qr/1');
  assert.equal(res.botToken, 'tok_1');
  assert.equal(res.ownerUserId, 'wxid_1');
  assert.equal(res.baseUrl, 'https://ilinkai.weixin.qq.com/');
  const raw = JSON.parse(await readFile(res.credFile, 'utf8'));
  assert.equal(raw.botToken, 'tok_1');
  assert.equal(raw.accountId, 'ilink_bot_1');
  assert.equal((await stat(res.credFile)).mode & 0o777, 0o600);
});

test('配对数字流程：need_verifycode → 输入 → confirmed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-bind-'));
  let code = '';
  const res = await runQrBind({
    api: scriptedApi(['need_verifycode', 'confirmed'], {
      readLineImpl: () => { code = '5678'; return code; },
    }),
    home,
    readLine: async () => code || '9999',
    log: () => {},
  });
  assert.equal(res.botToken, 'tok_1');
  assert.equal(code, '5678', 'readLine 被调用取配对数字');
});

test('expired → 抛错；verify_code_blocked → 抛错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-bind-'));
  await assert.rejects(
    () => runQrBind({ api: scriptedApi(['expired']), home, log: () => {} }),
    /二维码已过期/
  );
  await assert.rejects(
    () => runQrBind({ api: scriptedApi(['verify_code_blocked']), home, log: () => {} }),
    /配对数字多次错误/
  );
  await assert.rejects(
    () => runQrBind({ api: scriptedApi(['binded_redirect']), home, log: () => {} }),
    /已绑定/
  );
});

test('confirmed 但凭据不完整 → 抛错，不写文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-bind-'));
  const badApi = {
    async beginLogin() { return { qrcode: 'q', qrcodeUrl: 'https://weixin.qq.com/qr/1' }; },
    async pollLogin() { return { status: 'confirmed', bot_token: '', ilink_bot_id: 'x', ilink_user_id: 'y' }; },
  };
  await assert.rejects(() => runQrBind({ api: badApi, home, log: () => {} }), /凭据不完整/);
  await assert.rejects(readFile(join(home, 'dsh-im', 'weixin-credentials.json')), /ENOENT/);
});
