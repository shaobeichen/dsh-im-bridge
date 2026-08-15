// 飞书扫码接入的 Web 会话状态机（浏览器轮询读取，Host 后台跑 registerApp）
//
// 与 CLI（bin/feishu-qr.mjs）共用官方 registerApp + 同一凭据文件路径：
//   $DSH_HOME/dsh-im/feishu-credentials.json（0600）。
// 浏览器只看到 redactProvisioning 之后的字段，App Secret 不进浏览器。

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { QR_CREDENTIALS_REL } from './index.js';
import { QR_ADDONS } from './qr-setup.js';

const require = createRequire(import.meta.url);

/** 二维码 URL → data URL（浏览器 <img> 直接显示，不走外部服务）。 */
export async function qrCodeDataUrl(url, { width = 280, margin = 1 } = {}) {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

/**
 * 创建一次扫码会话。begin() 启动官方 registerApp 流程，状态写入 state，
 * 浏览器通过 getState()（经 RPC qr.poll）轮询；成功后凭据落盘。
 */
export function createFeishuProvisionSession({
  lark,
  home,
  write = writeFile,
  mkdirFn = mkdir,
  encodeQr = qrCodeDataUrl,
}) {
  let state = { phase: 'idle' };
  let controller = null;

  return {
    getState: () => ({ ...state }),

    async begin() {
      if (!lark?.registerApp) throw new TypeError('dsh-im-feishu web: lark.registerApp required');
      if (controller) controller.abort();
      controller = new AbortController();
      state = { phase: 'starting' };
      const TERMINAL = new Set(['succeeded', 'error', 'expired', 'cancelled']);

      const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
      const credFile = join(dshHome, QR_CREDENTIALS_REL);

      try {
        const result = await lark.registerApp({
          appPreset: {
            name: 'DSH 智能体（{user}）',
            desc: 'DeepSeek Harness IM 桥：远程派活 / 结果通知 / 危险操作审批（dsh-im-bridge）',
          },
          addons: QR_ADDONS,
          onQRCodeReady: async ({ url, expireIn }) => {
            // SDK 回调可能先于结果/错误完成（async 生成二维码）；await 前后都要查终态
            if (controller.signal.aborted || TERMINAL.has(state.phase)) return;
            const qrDataUrl = await encodeQr(url);
            if (controller.signal.aborted || TERMINAL.has(state.phase)) return;
            state = { phase: 'qr', qrDataUrl, expiresIn: expireIn };
          },
          onStatusChange: ({ status, interval }) => {
            if (controller.signal.aborted || TERMINAL.has(state.phase)) return;
            if (status === 'slow_down') {
              state = { ...state, pollMessage: `轮询限速（${interval}s）| throttled` };
            } else {
              state = { ...state, pollMessage: status };
            }
          },
          signal: controller.signal,
        });

        const clientId = result?.client_id;
        const clientSecret = result?.client_secret;
        if (!clientId || !clientSecret) {
          state = { phase: 'error', message: '扫码注册未返回有效凭据 | registration returned no credentials' };
          return;
        }
        await mkdirFn(dirname(credFile), { recursive: true });
        await write(credFile, JSON.stringify({
          appId: clientId,
          appSecret: clientSecret,
          scannedBy: result.user_info?.open_id ?? '',
          tenantBrand: result.user_info?.tenant_brand ?? '',
          createdAt: new Date().toISOString(),
        }, null, 2) + '\n', { mode: 0o600 });
        state = { phase: 'succeeded', appId: clientId };
      } catch (err) {
        if (controller.signal.aborted) {
          state = { phase: 'cancelled' };
          return;
        }
        state = { phase: 'error', message: err?.message ?? String(err) };
      }
    },

    cancel() {
      controller?.abort();
      state = { phase: 'cancelled' };
    },
  };
}
