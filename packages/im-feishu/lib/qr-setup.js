// 飞书扫码接入（官方 @larksuiteoapi/node-sdk 的 registerApp 流程）
//
// 用途：不用手动在开放平台建应用/勾权限/配订阅——扫码后在飞书里点确认，
// SDK 直接返回 App ID / App Secret，写入 $DSH_HOME/dsh-im/feishu-credentials.json
// （0600），适配器 resolveSecret 在 env 为空时自动回退读取。
//
// 预填项（addons）对齐 feishu-setup.md 的手动清单：
//   - 权限：im:message:send_as_bot（发消息）、im:message.p2p_msg:readonly（收私聊消息）
//   - 事件：im.message.receive_v1（长连接接收）
//   - 回调：card.action.trigger（审批卡片按钮）
// 注：addons 走官方灰度（平台支持才生效，否则回退默认创建页，用户可自行勾选）。

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { QR_CREDENTIALS_REL } from './index.js';

/** 预填：与手动配置完全一致的最小权限集。 */
export const QR_ADDONS = {
  preset: false,
  scopes: {
    tenant: ['im:message:send_as_bot', 'im:message.p2p_msg:readonly'],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1'],
    },
  },
  callbacks: {
    items: ['card.action.trigger'],
  },
};

/**
 * 跑一遍扫码注册流程，成功后把凭据原子写入 credentials 文件。
 *
 * @param {object} opts
 * @param {object} opts.lark         官方 SDK（测试注入 stub）
 * @param {string} [opts.home]       $DSH_HOME（默认 process.env.DSH_HOME 或 ~/.dsh）
 * @param {Function} [opts.log]      进度输出（默认 console.log）
 * @param {Function} [opts.renderQr] 渲染二维码（CLI 用 qrcode-terminal；测试用 spy）
 * @param {Function} [opts.write]    写文件（测试注入）
 * @param {Function} [opts.mkdirFn]  建目录（测试注入）
 * @param {AbortSignal} [opts.signal] 取消（Ctrl+C）
 * @returns {Promise<{appId: string, appSecret: string, credFile: string, userInfo: object}>}
 */
export async function runQrSetup({
  lark,
  home,
  log = console.log,
  renderQr = () => {},
  write = writeFile,
  mkdirFn = mkdir,
  signal,
}) {
  if (!lark?.registerApp) throw new TypeError('runQrSetup requires lark.registerApp (官方 @larksuiteoapi/node-sdk)');

  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const credFile = join(dshHome, QR_CREDENTIALS_REL);

  log('🔗 正在向飞书开放平台申请二维码… | requesting QR code from Feishu Open Platform');
  const result = await lark.registerApp({
    appPreset: {
      name: 'DSH 智能体（{user}）',
      desc: 'DeepSeek Harness IM 桥：远程派活 / 结果通知 / 危险操作审批（dsh-im-bridge）',
    },
    addons: QR_ADDONS,
    onQRCodeReady: ({ url, expireIn }) => {
      log(`📱 请用飞书扫码（${Math.round(expireIn / 60)} 分钟内有效）：| scan with Feishu within ${Math.round(expireIn / 60)} min`);
      renderQr(url);
      log(`   打不开二维码？直接访问：${url}`);
    },
    onStatusChange: ({ status, interval }) => {
      if (status === 'slow_down') log(`⏳ 轮询被限速（${interval}s），继续等待… | polling throttled, waiting`);
      else log(`⏳ 状态：${status}`);
    },
    signal,
  });

  const clientId = result?.client_id;
  const clientSecret = result?.client_secret;
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
    throw new Error('扫码注册未返回有效凭据（client_id/client_secret）| registration returned no credentials');
  }

  await mkdirFn(dirname(credFile), { recursive: true });
  await write(credFile, JSON.stringify({
    appId: clientId,
    appSecret: clientSecret,
    scannedBy: result.user_info?.open_id ?? '',
    tenantBrand: result.user_info?.tenant_brand ?? '',
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });

  log(`✅ 凭据已安全写入 ${credFile}（仅本机可读）`);
  return { appId: clientId, appSecret: clientSecret, credFile, userInfo: result.user_info ?? {} };
}
