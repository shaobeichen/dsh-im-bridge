#!/usr/bin/env node
// dsh-im-feishu 扫码接入 CLI
//
// 用法：npx -y dsh-im-feishu-qr
//  1. 终端显示二维码 → 手机飞书扫码 → 确认创建应用（权限/事件/回调已预填）
//  2. 凭据自动写入 $DSH_HOME/dsh-im/feishu-credentials.json（0600）
//  3. 重启 dsh web 即生效（无需设置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量）
//
// 取消：Ctrl+C。

import { createRequire } from 'node:module';

import { runQrSetup } from '../lib/qr-setup.js';
import * as lark from '@larksuiteoapi/node-sdk';

const require = createRequire(import.meta.url);

function renderQr(url) {
  // qrcode-terminal 是 CJS 包，用 require 取（ESM 下 import 默认导出不可靠）
  const qrcodeTerminal = require('qrcode-terminal');
  qrcodeTerminal.generate(url, { small: true }, (qr) => console.log(qr));
}

const controller = new AbortController();
const onSigint = () => {
  controller.abort();
  console.log('\n已取消。| cancelled.');
  process.exit(130);
};
process.on('SIGINT', onSigint);

try {
  const { appId, appSecret, credFile, userInfo } = await runQrSetup({ lark, renderQr, signal: controller.signal });
  const name = userInfo?.name ? `（${userInfo.name}）` : '';
  console.log(`🎉 接入成功${name}：App ID ${appId}`);
  console.log(`   凭据已写入：${credFile}`);
  console.log('   重启 dsh web 后即可在飞书里私聊机器人开始使用：');
  console.log('     npx @deepseek-ai/dsh web');
} catch (err) {
  if (controller.signal.aborted) process.exit(130);
  console.error(`❌ 扫码接入失败：${err?.message ?? err} | QR setup failed`);
  process.exit(1);
}
