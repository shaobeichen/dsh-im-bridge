// 微信 Web RPC（loopback-only）：设置页签 ⇄ Host 的扫码绑定通道

import { WEIXIN_RPC_CHANNEL, WEIXIN_ENDPOINTS, redactBinding } from '../client/api.js';

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/** 注册 /im-weixin 逻辑通道（仅本机 loopback 可调）。 */
export function installWeixinWebRpc(ctx, { session, getStatus, log = console }) {
  if (!ctx?.connection?.rpc?.handle) {
    log.warn?.('dsh-im-weixin: DSH Host Connection RPC unavailable — web settings tab disabled | 无 Connection RPC，网页设置页签不可用');
    return () => {};
  }
  return ctx.connection.rpc.handle(WEIXIN_RPC_CHANNEL, async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'The request was cancelled.');

    try {
      if (endpoint === WEIXIN_ENDPOINTS.status) {
        const status = getStatus?.() ?? { connected: false, detail: 'unknown', lastEventAt: null };
        return ok({
          connected: status.connected === true,
          detail: status.detail ?? '',
          lastEventAt: status.lastEventAt ?? null,
        });
      }
      if (endpoint === WEIXIN_ENDPOINTS.beginBinding) {
        await session.begin();
        return ok(redactBinding(session.getState()));
      }
      if (endpoint === WEIXIN_ENDPOINTS.pollBinding) {
        return ok(redactBinding(session.getState()));
      }
      if (endpoint === WEIXIN_ENDPOINTS.submitVerifyCode) {
        const result = session.submitVerifyCode(payload?.code);
        if (!result.ok) return fail('bad-request', result.error);
        return ok(redactBinding(session.getState()));
      }
      if (endpoint === WEIXIN_ENDPOINTS.cancelBinding) {
        session.cancel();
        return ok(redactBinding(session.getState()));
      }
      return fail('bad-request', `Unknown endpoint: ${endpoint}`);
    } catch (err) {
      log.error?.('dsh-im-weixin: rpc %s failed | RPC 失败: %s', endpoint, err?.message ?? err);
      return fail('internal', err?.message ?? String(err));
    }
  }, { authority: 'loopback' });
}
