// 飞书 Web RPC（loopback-only）：设置页签 ⇄ Host 的扫码接入通道
//
// 端点见 client/api.js；凭据只落 Host 本机文件，App Secret 绝不返回浏览器。

import { FEISHU_RPC_CHANNEL, FEISHU_ENDPOINTS, redactProvisioning } from '../client/api.js';

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/** 注册 /im-feishu 逻辑通道（仅本机 loopback 可调）。 */
export function installFeishuWebRpc(ctx, { session, getStatus, log = console }) {
  if (!ctx?.connection?.rpc?.handle) {
    log.warn?.('dsh-im-feishu: DSH Host Connection RPC unavailable — web settings tab disabled | 无 Connection RPC，网页设置页签不可用');
    return () => {};
  }
  return ctx.connection.rpc.handle(FEISHU_RPC_CHANNEL, async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'The request was cancelled.');

    try {
      if (endpoint === FEISHU_ENDPOINTS.status) {
        const status = getStatus?.() ?? { connected: false, detail: 'unknown', lastEventAt: null };
        return ok({
          connected: status.connected === true,
          detail: status.detail ?? '',
          lastEventAt: status.lastEventAt ?? null,
        });
      }
      if (endpoint === FEISHU_ENDPOINTS.beginProvisioning) {
        await session.begin();
        return ok(redactProvisioning(session.getState()));
      }
      if (endpoint === FEISHU_ENDPOINTS.pollProvisioning) {
        return ok(redactProvisioning(session.getState()));
      }
      if (endpoint === FEISHU_ENDPOINTS.cancelProvisioning) {
        session.cancel();
        return ok(redactProvisioning(session.getState()));
      }
      return fail('bad-request', `Unknown endpoint: ${endpoint}`);
    } catch (err) {
      log.error?.('dsh-im-feishu: rpc %s failed | RPC 失败: %s', endpoint, err?.message ?? err);
      return fail('internal', err?.message ?? String(err));
    }
  }, { authority: 'loopback' });
}
