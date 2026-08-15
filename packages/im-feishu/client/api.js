// 飞书 Web 设置页签的 RPC 契约（client 与 host 共享）
//
// 浏览器 ⇄ Host 之间只走 loopback RPC（ctx.connection.rpc），
// 任何端点都不回传 App Secret 等敏感字段（凭据只写入 Host 本机文件）。

export const FEISHU_RPC_CHANNEL = '/im-feishu';

export const FEISHU_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  beginProvisioning: 'qr.begin',
  pollProvisioning: 'qr.poll',
  cancelProvisioning: 'qr.cancel',
});

/** 红名单：浏览器可见的会话状态字段。 */
export function redactProvisioning(state) {
  const base = { phase: state?.phase ?? 'idle' };
  if (typeof state?.qrDataUrl === 'string') base.qrDataUrl = state.qrDataUrl;
  if (typeof state?.expiresIn === 'number') base.expiresIn = state.expiresIn;
  if (typeof state?.pollMessage === 'string') base.pollMessage = state.pollMessage;
  if (typeof state?.appId === 'string') base.appId = state.appId;
  if (typeof state?.message === 'string') base.message = state.message;
  return base;
}
