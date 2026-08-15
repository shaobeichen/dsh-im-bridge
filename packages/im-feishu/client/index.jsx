// dsh-im-feishu 网页设置页签（设置 → 插件 → 飞书）
//
// 能力：显示连接状态 + 一键「扫码绑定」——二维码直接在网页里显示，
// 手机飞书扫码确认后凭据写入 Host，重启 dsh web 生效。全程不碰终端。
//
// 浏览器端只用 loopback RPC（ctx.connection.rpc.call），App Secret 不出 Host。

import { createElement as h, useEffect, useRef, useState } from 'react';

import { FEISHU_RPC_CHANNEL, FEISHU_ENDPOINTS, redactProvisioning } from './api.js';

const NS = 'dsh-im-feishu';
const name = 'dsh-im-feishu';
const inject = ['slots', 'connection'];

const styles = {
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '14px 16px', maxWidth: 480 },
  row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  pill: { padding: '2px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600 },
  btn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 8, padding: '6px 14px', fontSize: 13 },
  primary: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-brand-primary,#4f6ef7)', color: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 13 },
  qr: { width: 260, height: 260, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', margin: '10px 0' },
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12 },
  err: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, margin: '8px 0' },
  ok: { color: 'var(--dsw-alias-state-success-primary,#16a34a)', fontSize: 13, fontWeight: 600 },
  input: { font: 'inherit', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, padding: '6px 10px', fontSize: 13, width: 140 },
};

function FeishuSettingsTab({ rpcCall }) {
  const [status, setStatus] = useState(null);
  const [provision, setProvision] = useState(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef(null);

  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  const loadStatus = async () => {
    try { setStatus(await call(FEISHU_ENDPOINTS.status, {})); } catch { /* 忽略瞬时失败 */ }
  };

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000);
    return () => clearInterval(t);
  }, []);

  const stopPolling = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  const pollProvision = async () => {
    let s;
    try { s = await call(FEISHU_ENDPOINTS.pollProvisioning, {}); } catch { return; }
    setProvision(s);
    if (['succeeded', 'error', 'expired', 'cancelled'].includes(s.phase)) {
      stopPolling();
      loadStatus();
    }
  };

  const begin = async () => {
    setBusy(true);
    try {
      await call(FEISHU_ENDPOINTS.beginProvisioning, {});
      setProvision(redactProvisioning({ phase: 'starting' }));
      stopPolling();
      timerRef.current = setInterval(pollProvision, 1500);
      pollProvision();
    } catch (err) {
      setProvision({ phase: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    stopPolling();
    try { await call(FEISHU_ENDPOINTS.cancelProvisioning, {}); } catch { /* 忽略 */ }
    setProvision({ phase: 'cancelled' });
  };

  const connected = status?.connected === true;
  const phase = provision?.phase ?? 'idle';

  return h('div', { style: styles.card },
    h('div', { style: styles.row },
      h('strong', null, '飞书 | Feishu'),
      h('span', { style: { ...styles.pill, ...(connected
        ? { color: 'var(--dsw-alias-state-success-primary,#16a34a)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)' }
        : { color: 'var(--dsw-alias-label-secondary,#6b7280)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)' }) } },
        connected ? '已连接' : '未连接'),
    ),
    h('div', { style: styles.muted }, status?.detail ?? '—'),

    phase === 'succeeded'
      ? h('div', { style: styles.ok }, `🎉 绑定成功（${provision.appId ?? ''}）——重启 DeepSeek Harness 后生效 | bound — restart dsh web to apply`)
      : phase === 'error' || phase === 'expired' || phase === 'cancelled'
        ? h('div', { style: styles.err }, provision.message ?? '已取消 | cancelled')
        : phase === 'qr' || phase === 'starting' || phase === 'scanned'
          ? h('div', {},
            h('div', { style: styles.muted }, '用手机飞书扫一扫（或点击下方链接在手机打开）：| scan with Feishu'),
            phase === 'qr'
              ? h('img', { src: provision.qrDataUrl, alt: 'QR', style: styles.qr })
              : h('div', { style: styles.muted }, '等待二维码… | requesting QR…'),
            h('div', { style: styles.muted }, `状态：${provision.pollMessage ?? '…'}`),
            h('button', { style: styles.btn, onClick: cancel }, '取消 | Cancel'),
          )
          : h('div', {},
            connected
              ? h('div', { style: styles.muted }, '机器人已连接。想换一个？取消后重新扫码。| connected; re-scan to replace')
              : h('button', { style: styles.primary, onClick: begin, disabled: busy }, busy ? '申请中…' : '📱 扫码绑定 | Scan to connect'),
          ),
  );
}

export function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(FEISHU_RPC_CHANNEL, endpoint, payload, signal);

  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'feishu',
        order: 30,
        label: '飞书',
        inject: () => ({ rpcCall }),
      },
      FeishuSettingsTab,
    ),
  );
}

export { name, inject };
