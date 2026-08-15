// dsh-im-weixin 网页设置页签（设置 → 插件 → 微信）
//
// 能力：显示连接状态 + 一键「扫码绑定」——二维码在网页里显示，手机微信扫码，
// 若手机显示配对数字则在网页输入框填入。绑定成功后凭据写入 Host，重启生效。

import { createElement as h, useEffect, useRef, useState } from 'react';

import { WEIXIN_RPC_CHANNEL, WEIXIN_ENDPOINTS, redactBinding } from './api.js';

const name = 'dsh-im-weixin';
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
  input: { font: 'inherit', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, padding: '6px 10px', fontSize: 13, width: 160 },
  warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, margin: '8px 0' },
};

function WeixinSettingsTab({ rpcCall }) {
  const [status, setStatus] = useState(null);
  const [provision, setProvision] = useState(null);
  const [busy, setBusy] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const timerRef = useRef(null);

  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  const loadStatus = async () => {
    try { setStatus(await call(WEIXIN_ENDPOINTS.status, {})); } catch { /* 忽略 */ }
  };

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000);
    return () => clearInterval(t);
  }, []);

  const stopPolling = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  const pollBinding = async () => {
    let s;
    try { s = await call(WEIXIN_ENDPOINTS.pollBinding, {}); } catch { return; }
    setProvision(s);
    if (['succeeded', 'error', 'expired', 'cancelled'].includes(s.phase)) {
      stopPolling();
      loadStatus();
    }
  };

  const begin = async () => {
    setBusy(true);
    try {
      await call(WEIXIN_ENDPOINTS.beginBinding, {});
      setProvision(redactBinding({ phase: 'starting' }));
      stopPolling();
      timerRef.current = setInterval(pollBinding, 1500);
      pollBinding();
    } catch (err) {
      setProvision({ phase: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    stopPolling();
    try { await call(WEIXIN_ENDPOINTS.cancelBinding, {}); } catch { /* 忽略 */ }
    setProvision({ phase: 'cancelled' });
  };

  const submitCode = async () => {
    try {
      await call(WEIXIN_ENDPOINTS.submitVerifyCode, { code: verifyCode });
      setVerifyCode('');
    } catch (err) {
      setProvision({ phase: 'error', message: err.message });
    }
  };

  const connected = status?.connected === true;
  const phase = provision?.phase ?? 'idle';

  return h('div', { style: styles.card },
    h('div', { style: styles.row },
      h('strong', null, '微信 | WeChat'),
      h('span', { style: { ...styles.pill, ...(connected
        ? { color: 'var(--dsw-alias-state-success-primary,#16a34a)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)' }
        : { color: 'var(--dsw-alias-label-secondary,#6b7280)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)' }) } },
        connected ? '已连接' : '未连接'),
    ),
    h('div', { style: styles.muted }, status?.detail ?? '—'),

    phase === 'succeeded'
      ? h('div', { style: styles.ok }, `🎉 绑定成功（${provision.accountId ?? ''}）——重启 DeepSeek Harness 后生效 | bound — restart dsh web to apply`)
      : phase === 'error' || phase === 'expired' || phase === 'cancelled'
        ? h('div', { style: styles.err }, provision.message ?? '已取消 | cancelled')
        : phase === 'qr' || phase === 'starting' || phase === 'scanned' || phase === 'need_verifycode'
          ? h('div', {},
            h('div', { style: styles.muted }, '用手机微信扫一扫：| scan with WeChat'),
            phase === 'qr'
              ? h('img', { src: provision.qrDataUrl, alt: 'QR', style: styles.qr })
              : phase === 'starting'
                ? h('div', { style: styles.muted }, '等待二维码… | requesting QR…')
                : h('img', { src: provision.qrDataUrl, alt: 'QR', style: styles.qr }),
            h('div', { style: styles.muted }, `状态：${provision.pollMessage ?? '…'}`),
            phase === 'need_verifycode'
              ? h('div', { style: styles.row },
                h('input', {
                  style: styles.input,
                  value: verifyCode,
                  placeholder: '配对数字',
                  onChange: (e) => setVerifyCode(e.target.value),
                }),
                h('button', { style: styles.primary, onClick: submitCode, disabled: !verifyCode }, '提交 | Submit'),
              )
              : null,
            h('button', { style: styles.btn, onClick: cancel, ...(phase === 'need_verifycode' ? { style: { ...styles.btn, marginTop: 8 } } : {}) }, '取消 | Cancel'),
          )
          : h('div', {},
            h('div', { style: styles.warn }, '⚠️ 前提：手机微信需已获「微信机器人」功能（我 → 设置 → 插件），否则无法绑定 | prerequisite: WeChat bot entry under Me → Settings → Plugins'),
            connected
              ? h('div', { style: styles.muted }, '机器人已连接。想换一个？取消后重新扫码。| connected; re-scan to replace')
              : h('button', { style: styles.primary, onClick: begin, disabled: busy }, busy ? '申请中…' : '📱 扫码绑定 | Scan to bind'),
          ),
  );
}

export function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(WEIXIN_RPC_CHANNEL, endpoint, payload, signal);

  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'weixin',
        order: 35,
        label: '微信',
        inject: () => ({ rpcCall }),
      },
      WeixinSettingsTab,
    ),
  );
}

export { name, inject };
