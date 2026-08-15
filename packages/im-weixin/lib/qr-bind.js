// 微信扫码绑定（腾讯 iLink 官方登录流程）
//
// 流程：获取二维码 → 终端渲染 → 手机微信扫码 → （可选）配对数字确认 →
// confirmed 拿到 bot_token / ilink_bot_id / ilink_user_id / baseurl →
// 凭据写入 $DSH_HOME/dsh-im/weixin-credentials.json（0600）。
//
// 前提：手机微信账号已获得「微信机器人」功能（我 → 设置 → 插件）。
// 绑定成功后重启 dsh web，适配器用文件里的凭据直接连。

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { QR_CREDENTIALS_REL } from './index.js';
import { normalizeWeixinApiBaseUrl } from './weixin-api.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 服务端可能返回重定向域（scaned_but_redirect），拼成受信 baseUrl。 */
function apiBaseFromServer(host, currentBase) {
  const h = nonEmptyString(host);
  if (!h) return currentBase;
  return normalizeWeixinApiBaseUrl(`https://${h}/`);
}

/**
 * 跑一遍微信扫码绑定，成功后把凭据写入 credentials 文件。
 *
 * @param {object} opts
 * @param {object} opts.api         createWeixinApi() 的客户端（测试注入假实现）
 * @param {string} [opts.home]      $DSH_HOME
 * @param {Function} [opts.log]     进度输出
 * @param {Function} [opts.renderQr] 渲染二维码
 * @param {Function} [opts.readLine] 读取配对数字（返回 Promise<string>）
 * @param {Function} [opts.write]    写文件（测试注入）
 * @param {Function} [opts.mkdirFn]  建目录（测试注入）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{botToken: string, accountId: string, ownerUserId: string, baseUrl: string, credFile: string}>}
 */
export async function runQrBind({
  api,
  home,
  log = console.log,
  renderQr = () => {},
  readLine = async () => '',
  write = writeFile,
  mkdirFn = mkdir,
  signal,
}) {
  if (!api?.beginLogin || !api?.pollLogin) throw new TypeError('runQrBind requires an iLink api client');

  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const credFile = join(dshHome, QR_CREDENTIALS_REL);

  log('🔗 正在向微信申请登录二维码… | requesting Weixin login QR');
  const { qrcode, qrcodeUrl } = await api.beginLogin({ signal });
  renderQr(qrcodeUrl);
  log(`   打不开二维码？直接访问：${qrcodeUrl}`);

  let baseUrl = null; // confirmed 前用二维码地址同域，之后用服务端 baseurl
  let verifyCode = '';
  let expired = false;

  while (!signal?.aborted) {
    const response = await api.pollLogin({ qrcode, baseUrl: baseUrl ?? undefined, verifyCode, signal });
    const status = response.status;

    if (status === 'wait') {
      log('⏳ 等待扫码… | waiting for scan');
    } else if (status === 'scaned') {
      verifyCode = '';
      log('📱 已扫码，请在手机上确认 | scanned, confirm on your phone');
    } else if (status === 'scaned_but_redirect') {
      baseUrl = apiBaseFromServer(response.redirect_host, baseUrl);
      log('📱 已扫码，确认页已重定向 | scanned, confirm on your phone');
    } else if (status === 'need_verifycode') {
      verifyCode = '';
      const code = (await readLine('🔢 手机显示配对数字，请输入：| enter the pairing digits shown on your phone: ')).trim();
      if (!code) {
        log('❌ 未输入配对数字，取消绑定 | no pairing digits entered, cancelled');
        throw new Error('配对数字为空 | empty pairing digits');
      }
      verifyCode = code;
    } else if (status === 'verify_code_blocked') {
      throw new Error('配对数字多次错误，请重新生成二维码 | verification blocked, please re-scan');
    } else if (status === 'expired') {
      expired = true;
      break;
    } else if (status === 'binded_redirect') {
      throw new Error('该微信账号已绑定过机器人 | this Weixin account is already bound');
    } else if (status === 'confirmed') {
      const botToken = nonEmptyString(response.bot_token);
      const accountId = nonEmptyString(response.ilink_bot_id);
      const ownerUserId = nonEmptyString(response.ilink_user_id);
      if (!botToken || !accountId || !ownerUserId) {
        throw new Error('微信授权成功但返回的凭据不完整 | incomplete credentials from Weixin');
      }
      baseUrl = apiBaseFromServer(response.baseurl, baseUrl ?? 'https://ilinkai.weixin.qq.com/');
      await mkdirFn(dirname(credFile), { recursive: true });
      await write(credFile, JSON.stringify({
        botToken,
        accountId,
        ownerUserId,
        baseUrl,
        createdAt: new Date().toISOString(),
      }, null, 2) + '\n', { mode: 0o600 });
      log(`✅ 绑定成功：机器人 ${accountId}，凭据已写入 ${credFile}（仅本机可读）`);
      return { botToken, accountId, ownerUserId, baseUrl, credFile };
    }
  }

  if (expired) throw new Error('二维码已过期，请重新生成 | QR code expired, please re-run');
  throw new Error('绑定已取消 | cancelled');
}
