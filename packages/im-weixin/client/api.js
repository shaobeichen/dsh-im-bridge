// 微信 Web 设置页签的 RPC 契约（client 与 host 共享）

export const WEIXIN_RPC_CHANNEL = '/im-weixin';

export const WEIXIN_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  beginBinding: 'bind.begin',
  pollBinding: 'bind.poll',
  cancelBinding: 'bind.cancel',
  submitVerifyCode: 'verifycode.submit',
});

/** 红名单：浏览器可见的绑定会话状态字段。 */
export function redactBinding(state) {
  const base = { phase: state?.phase ?? 'idle' };
  if (typeof state?.qrDataUrl === 'string') base.qrDataUrl = state.qrDataUrl;
  if (typeof state?.pollMessage === 'string') base.pollMessage = state.pollMessage;
  if (typeof state?.accountId === 'string') base.accountId = state.accountId;
  if (typeof state?.message === 'string') base.message = state.message;
  return base;
}
