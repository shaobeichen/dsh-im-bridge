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
  // connection 是可选服务：真实 Cordis 上下文必须用 ctx.get 读取（本 Cordis 变体对未注入的
  // ctx.connection 属性访问直接抛错）；测试假件可能直接给 connection 属性。两者都支持，
  // 无 Connection RPC 的组合（demo 裸 Context）优雅降级。
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection;
  if (!connection?.rpc?.handle) {
    log.warn?.('dsh-im-weixin: DSH Host Connection RPC unavailable — web settings tab disabled | 无 Connection RPC，网页设置页签不可用');
    return () => {};
  }
  return connection.rpc.handle(WEIXIN_RPC_CHANNEL, async (endpoint, payload = {}, signal) => {
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
