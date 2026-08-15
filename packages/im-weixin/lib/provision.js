// 微信扫码绑定的 Web 会话状态机（浏览器轮询读取，Host 后台跑 iLink 登录循环）
//
// 与 CLI（bin/weixin-qr.mjs）共用官方 iLink 协议 + 同一凭据文件：
//   $DSH_HOME/dsh-im/weixin-credentials.json（0600）。
// 配对数字（need_verifycode）由 submitVerifyCode 注入，浏览器输入即可。

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { QR_CREDENTIALS_REL } from './index.js';
import { normalizeWeixinApiBaseUrl } from './weixin-api.js';

const require = createRequire(import.meta.url);

/** 二维码 URL → data URL（浏览器 <img> 直接显示）。 */
export async function qrCodeDataUrl(url, { width = 280, margin = 1 } = {}) {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function apiBaseFromServer(host, currentBase) {
  const h = nonEmptyString(host);
  if (!h) return currentBase;
  return normalizeWeixinApiBaseUrl(`https://${h}/`);
}

/**
 * 创建一次扫码绑定会话。begin() 启动 iLink 登录循环；浏览器经 bind.poll 轮询状态；
 * 手机显示配对数字时 submitVerifyCode 注入数字；成功后凭据落盘。
 */
export function createWeixinBindSession({
  api,
  home,
  write = writeFile,
  mkdirFn = mkdir,
  encodeQr = qrCodeDataUrl,
}) {
  let state = { phase: 'idle' };
  let controller = null;
  let qrcode = '';
  let baseUrl = null;
  let verifyCode = '';

  return {
    getState: () => ({ ...state }),

    async begin() {
      if (!api?.beginLogin || !api?.pollLogin) throw new TypeError('dsh-im-weixin web: iLink api required');
      if (controller) controller.abort();
      controller = new AbortController();
      verifyCode = '';
      state = { phase: 'starting' };

      const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
      const credFile = join(dshHome, QR_CREDENTIALS_REL);

      try {
        const login = await api.beginLogin({ signal: controller.signal });
        qrcode = login.qrcode;
        state = { phase: 'qr', qrDataUrl: await encodeQr(login.qrcodeUrl) };
        void runLoop(credFile);
      } catch (err) {
        if (controller.signal.aborted) { state = { phase: 'cancelled' }; return; }
        state = { phase: 'error', message: err?.message ?? String(err) };
      }
    },

    submitVerifyCode(code) {
      const c = nonEmptyString(code);
      if (!c) return { ok: false, error: '配对数字为空 | empty pairing digits' };
      verifyCode = c;
      state = { ...state, pollMessage: '配对数字已提交，等待确认… | digits submitted' };
      return { ok: true };
    },

    cancel() {
      controller?.abort();
      state = { phase: 'cancelled' };
    },
  };

  async function runLoop(credFile) {
    while (!controller?.signal.aborted) {
      try {
        const r = await api.pollLogin({
          qrcode,
          baseUrl: baseUrl ?? undefined,
          verifyCode,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        if (r.status === 'wait') {
          state = { ...state, phase: 'qr', pollMessage: '等待扫码… | waiting for scan' };
        } else if (r.status === 'scaned') {
          verifyCode = '';
          state = { ...state, phase: 'scanned', pollMessage: '已扫码，请在手机上确认 | scanned, confirm on phone' };
        } else if (r.status === 'scaned_but_redirect') {
          baseUrl = apiBaseFromServer(r.redirect_host, baseUrl);
          state = { ...state, phase: 'scanned', pollMessage: '已扫码，请在手机上确认 | scanned, confirm on phone' };
        } else if (r.status === 'need_verifycode') {
          verifyCode = '';
          state = { ...state, phase: 'need_verifycode', pollMessage: '手机显示配对数字，请在下方输入 | enter the pairing digits' };
        } else if (r.status === 'verify_code_blocked') {
          state = { phase: 'error', message: '配对数字多次错误，请重新生成二维码 | verification blocked, re-scan' };
          return;
        } else if (r.status === 'expired') {
          state = { phase: 'expired', message: '二维码已过期，请重新绑定 | QR expired, retry' };
          return;
        } else if (r.status === 'binded_redirect') {
          state = { phase: 'error', message: '该微信账号已绑定过机器人 | account already bound' };
          return;
        } else if (r.status === 'confirmed') {
          const botToken = nonEmptyString(r.bot_token);
          const accountId = nonEmptyString(r.ilink_bot_id);
          const ownerUserId = nonEmptyString(r.ilink_user_id);
          if (!botToken || !accountId || !ownerUserId) {
            state = { phase: 'error', message: '微信授权成功但返回的凭据不完整 | incomplete credentials' };
            return;
          }
          baseUrl = apiBaseFromServer(r.baseurl, baseUrl ?? 'https://ilinkai.weixin.qq.com/');
          await mkdirFn(dirname(credFile), { recursive: true });
          await write(credFile, JSON.stringify({
            botToken,
            accountId,
            ownerUserId,
            baseUrl,
            createdAt: new Date().toISOString(),
          }, null, 2) + '\n', { mode: 0o600 });
          state = { phase: 'succeeded', accountId };
          return;
        }
      } catch (err) {
        if (controller?.signal.aborted) return;
        state = { phase: 'error', message: err?.message ?? String(err) };
        return;
      }
    }
  }
}
