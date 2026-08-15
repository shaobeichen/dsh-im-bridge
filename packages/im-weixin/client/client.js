window.__ModuleLoader__.load({
  id: "dsh-im-weixin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/im-weixin/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// packages/im-weixin/client/api.js
var WEIXIN_RPC_CHANNEL = "/im-weixin";
var WEIXIN_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginBinding: "bind.begin",
  pollBinding: "bind.poll",
  cancelBinding: "bind.cancel",
  submitVerifyCode: "verifycode.submit"
});
function redactBinding(state) {
  const base = { phase: state?.phase ?? "idle" };
  if (typeof state?.qrDataUrl === "string") base.qrDataUrl = state.qrDataUrl;
  if (typeof state?.pollMessage === "string") base.pollMessage = state.pollMessage;
  if (typeof state?.accountId === "string") base.accountId = state.accountId;
  if (typeof state?.message === "string") base.message = state.message;
  return base;
}

// packages/im-weixin/client/index.jsx
var name = "dsh-im-weixin";
var inject = ["slots", "connection"];
var styles = {
  card: { background: "var(--dsw-alias-bg-layer-1,#fff)", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 12, padding: "14px 16px", maxWidth: 480 },
  row: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  pill: { padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600 },
  btn: { font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", background: "var(--dsw-alias-bg-layer-1,#fff)", borderRadius: 8, padding: "6px 14px", fontSize: 13 },
  primary: { font: "inherit", cursor: "pointer", border: "none", background: "var(--dsw-alias-brand-primary,#4f6ef7)", color: "#fff", borderRadius: 8, padding: "6px 14px", fontSize: 13 },
  qr: { width: 260, height: 260, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", margin: "10px 0" },
  muted: { color: "var(--dsw-alias-label-tertiary,#8b93a1)", fontSize: 12 },
  err: { color: "var(--dsw-alias-state-error-primary,#dc2626)", fontSize: 12, margin: "8px 0" },
  ok: { color: "var(--dsw-alias-state-success-primary,#16a34a)", fontSize: 13, fontWeight: 600 },
  input: { font: "inherit", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 8, padding: "6px 10px", fontSize: 13, width: 160 },
  warn: { color: "var(--dsw-alias-state-warn-primary,#b45309)", fontSize: 12, margin: "8px 0" }
};
function WeixinSettingsTab({ rpcCall }) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [provision, setProvision] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [verifyCode, setVerifyCode] = (0, import_react.useState)("");
  const timerRef = (0, import_react.useRef)(null);
  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? "RPC failed");
    return res.value;
  };
  const loadStatus = async () => {
    try {
      setStatus(await call(WEIXIN_ENDPOINTS.status, {}));
    } catch {
    }
  };
  (0, import_react.useEffect)(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5e3);
    return () => clearInterval(t);
  }, []);
  const stopPolling = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };
  const pollBinding = async () => {
    let s;
    try {
      s = await call(WEIXIN_ENDPOINTS.pollBinding, {});
    } catch {
      return;
    }
    setProvision(s);
    if (["succeeded", "error", "expired", "cancelled"].includes(s.phase)) {
      stopPolling();
      loadStatus();
    }
  };
  const begin = async () => {
    setBusy(true);
    try {
      await call(WEIXIN_ENDPOINTS.beginBinding, {});
      setProvision(redactBinding({ phase: "starting" }));
      stopPolling();
      timerRef.current = setInterval(pollBinding, 1500);
      pollBinding();
    } catch (err) {
      setProvision({ phase: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    stopPolling();
    try {
      await call(WEIXIN_ENDPOINTS.cancelBinding, {});
    } catch {
    }
    setProvision({ phase: "cancelled" });
  };
  const submitCode = async () => {
    try {
      await call(WEIXIN_ENDPOINTS.submitVerifyCode, { code: verifyCode });
      setVerifyCode("");
    } catch (err) {
      setProvision({ phase: "error", message: err.message });
    }
  };
  const connected = status?.connected === true;
  const phase = provision?.phase ?? "idle";
  return (0, import_react.createElement)(
    "div",
    { style: styles.card },
    (0, import_react.createElement)(
      "div",
      { style: styles.row },
      (0, import_react.createElement)("strong", null, "\u5FAE\u4FE1 | WeChat"),
      (0, import_react.createElement)(
        "span",
        { style: { ...styles.pill, ...connected ? { color: "var(--dsw-alias-state-success-primary,#16a34a)", background: "var(--dsw-alias-bg-layer-2,#f3f4f6)" } : { color: "var(--dsw-alias-label-secondary,#6b7280)", background: "var(--dsw-alias-bg-layer-2,#f3f4f6)" } } },
        connected ? "\u5DF2\u8FDE\u63A5" : "\u672A\u8FDE\u63A5"
      )
    ),
    (0, import_react.createElement)("div", { style: styles.muted }, status?.detail ?? "\u2014"),
    phase === "succeeded" ? (0, import_react.createElement)("div", { style: styles.ok }, `\u{1F389} \u7ED1\u5B9A\u6210\u529F\uFF08${provision.accountId ?? ""}\uFF09\u2014\u2014\u91CD\u542F DeepSeek Harness \u540E\u751F\u6548 | bound \u2014 restart dsh web to apply`) : phase === "error" || phase === "expired" || phase === "cancelled" ? (0, import_react.createElement)("div", { style: styles.err }, provision.message ?? "\u5DF2\u53D6\u6D88 | cancelled") : phase === "qr" || phase === "starting" || phase === "scanned" || phase === "need_verifycode" ? (0, import_react.createElement)(
      "div",
      {},
      (0, import_react.createElement)("div", { style: styles.muted }, "\u7528\u624B\u673A\u5FAE\u4FE1\u626B\u4E00\u626B\uFF1A| scan with WeChat"),
      phase === "qr" ? (0, import_react.createElement)("img", { src: provision.qrDataUrl, alt: "QR", style: styles.qr }) : phase === "starting" ? (0, import_react.createElement)("div", { style: styles.muted }, "\u7B49\u5F85\u4E8C\u7EF4\u7801\u2026 | requesting QR\u2026") : (0, import_react.createElement)("img", { src: provision.qrDataUrl, alt: "QR", style: styles.qr }),
      (0, import_react.createElement)("div", { style: styles.muted }, `\u72B6\u6001\uFF1A${provision.pollMessage ?? "\u2026"}`),
      phase === "need_verifycode" ? (0, import_react.createElement)(
        "div",
        { style: styles.row },
        (0, import_react.createElement)("input", {
          style: styles.input,
          value: verifyCode,
          placeholder: "\u914D\u5BF9\u6570\u5B57",
          onChange: (e) => setVerifyCode(e.target.value)
        }),
        (0, import_react.createElement)("button", { style: styles.primary, onClick: submitCode, disabled: !verifyCode }, "\u63D0\u4EA4 | Submit")
      ) : null,
      (0, import_react.createElement)("button", { style: styles.btn, onClick: cancel, ...phase === "need_verifycode" ? { style: { ...styles.btn, marginTop: 8 } } : {} }, "\u53D6\u6D88 | Cancel")
    ) : (0, import_react.createElement)(
      "div",
      {},
      (0, import_react.createElement)("div", { style: styles.warn }, "\u26A0\uFE0F \u524D\u63D0\uFF1A\u624B\u673A\u5FAE\u4FE1\u9700\u5DF2\u83B7\u300C\u5FAE\u4FE1\u673A\u5668\u4EBA\u300D\u529F\u80FD\uFF08\u6211 \u2192 \u8BBE\u7F6E \u2192 \u63D2\u4EF6\uFF09\uFF0C\u5426\u5219\u65E0\u6CD5\u7ED1\u5B9A | prerequisite: WeChat bot entry under Me \u2192 Settings \u2192 Plugins"),
      connected ? (0, import_react.createElement)("div", { style: styles.muted }, "\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5\u3002\u60F3\u6362\u4E00\u4E2A\uFF1F\u53D6\u6D88\u540E\u91CD\u65B0\u626B\u7801\u3002| connected; re-scan to replace") : (0, import_react.createElement)("button", { style: styles.primary, onClick: begin, disabled: busy }, busy ? "\u7533\u8BF7\u4E2D\u2026" : "\u{1F4F1} \u626B\u7801\u7ED1\u5B9A | Scan to bind")
    )
  );
}
function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(WEIXIN_RPC_CHANNEL, endpoint, payload, signal);
  ctx.slots.inject(
    "settings.plugins.tab",
    () => ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "weixin",
        order: 35,
        label: "\u5FAE\u4FE1",
        inject: () => ({ rpcCall })
      },
      WeixinSettingsTab
    )
  );
}

    return module.exports;
  }
});
