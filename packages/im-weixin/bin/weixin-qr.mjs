#!/usr/bin/env node
// dsh-im-weixin 扫码绑定 CLI
//
// 用法：npx -y dsh-im-weixin-qr
//  1. 终端显示二维码 → 手机微信扫码 → 手机上确认（如有配对数字，输入到终端）
//  2. 凭据自动写入 $DSH_HOME/dsh-im/weixin-credentials.json（0600）
//  3. 重启 dsh web 即生效（无需设置 WECHAT_BOT_TOKEN 环境变量）
//
// 前提：手机微信账号已获得「微信机器人」功能（我 → 设置 → 插件 有入口）。
// 取消：Ctrl+C。

import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { createWeixinApi } from '../lib/weixin-api.js';
import { runQrBind } from '../lib/qr-bind.js';

const require = createRequire(import.meta.url);

function renderQr(url) {
  const qrcodeTerminal = require('qrcode-terminal');
  qrcodeTerminal.generate(url, { small: true }, (qr) => console.log(qr));
}

const rl = createInterface({ input: stdin, output: stdout });
const controller = new AbortController();
const onSigint = () => {
  controller.abort();
  console.log('\n已取消。| cancelled.');
  rl.close();
  process.exit(130);
};
process.on('SIGINT', onSigint);

try {
  const result = await runQrBind({
    api: createWeixinApi(),
    renderQr,
    readLine: (prompt) => rl.question(prompt),
    signal: controller.signal,
  });
  console.log(`🎉 绑定成功：机器人 ${result.accountId}`);
  console.log(`   凭据已写入：${result.credFile}`);
  console.log('   重启 dsh web 后即可在微信里给机器人发消息：');
  console.log('     npx @deepseek-ai/dsh web');
} catch (err) {
  if (controller.signal.aborted) process.exit(130);
  console.error(`❌ 绑定失败：${err?.message ?? err} | Weixin QR bind failed`);
  process.exit(1);
} finally {
  rl.close();
}
