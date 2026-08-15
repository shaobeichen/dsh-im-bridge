window.__ModuleLoader__.load({
  id: "dsh-im-feishu",
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

// packages/im-feishu/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// packages/im-feishu/client/api.js
var FEISHU_RPC_CHANNEL = "/im-feishu";
var FEISHU_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "qr.begin",
  pollProvisioning: "qr.poll",
  cancelProvisioning: "qr.cancel"
});
function redactProvisioning(state) {
  const base = { phase: state?.phase ?? "idle" };
  if (typeof state?.qrDataUrl === "string") base.qrDataUrl = state.qrDataUrl;
  if (typeof state?.expiresIn === "number") base.expiresIn = state.expiresIn;
  if (typeof state?.pollMessage === "string") base.pollMessage = state.pollMessage;
  if (typeof state?.appId === "string") base.appId = state.appId;
  if (typeof state?.message === "string") base.message = state.message;
  return base;
}

// packages/im-feishu/client/index.jsx
var name = "dsh-im-feishu";
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
  input: { font: "inherit", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 8, padding: "6px 10px", fontSize: 13, width: 140 }
};
function FeishuSettingsTab({ rpcCall }) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [provision, setProvision] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const timerRef = (0, import_react.useRef)(null);
  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? "RPC failed");
    return res.value;
  };
  const loadStatus = async () => {
    try {
      setStatus(await call(FEISHU_ENDPOINTS.status, {}));
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
  const pollProvision = async () => {
    let s;
    try {
      s = await call(FEISHU_ENDPOINTS.pollProvisioning, {});
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
      await call(FEISHU_ENDPOINTS.beginProvisioning, {});
      setProvision(redactProvisioning({ phase: "starting" }));
      stopPolling();
      timerRef.current = setInterval(pollProvision, 1500);
      pollProvision();
    } catch (err) {
      setProvision({ phase: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    stopPolling();
    try {
      await call(FEISHU_ENDPOINTS.cancelProvisioning, {});
    } catch {
    }
    setProvision({ phase: "cancelled" });
  };
  const connected = status?.connected === true;
  const phase = provision?.phase ?? "idle";
  return (0, import_react.createElement)(
    "div",
    { style: styles.card },
    (0, import_react.createElement)(
      "div",
      { style: styles.row },
      (0, import_react.createElement)("strong", null, "\u98DE\u4E66 | Feishu"),
      (0, import_react.createElement)(
        "span",
        { style: { ...styles.pill, ...connected ? { color: "var(--dsw-alias-state-success-primary,#16a34a)", background: "var(--dsw-alias-bg-layer-2,#f3f4f6)" } : { color: "var(--dsw-alias-label-secondary,#6b7280)", background: "var(--dsw-alias-bg-layer-2,#f3f4f6)" } } },
        connected ? "\u5DF2\u8FDE\u63A5" : "\u672A\u8FDE\u63A5"
      )
    ),
    (0, import_react.createElement)("div", { style: styles.muted }, status?.detail ?? "\u2014"),
    phase === "succeeded" ? (0, import_react.createElement)("div", { style: styles.ok }, `\u{1F389} \u7ED1\u5B9A\u6210\u529F\uFF08${provision.appId ?? ""}\uFF09\u2014\u2014\u91CD\u542F DeepSeek Harness \u540E\u751F\u6548 | bound \u2014 restart dsh web to apply`) : phase === "error" || phase === "expired" || phase === "cancelled" ? (0, import_react.createElement)("div", { style: styles.err }, provision.message ?? "\u5DF2\u53D6\u6D88 | cancelled") : phase === "qr" || phase === "starting" || phase === "scanned" ? (0, import_react.createElement)(
      "div",
      {},
      (0, import_react.createElement)("div", { style: styles.muted }, "\u7528\u624B\u673A\u98DE\u4E66\u626B\u4E00\u626B\uFF08\u6216\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5\u5728\u624B\u673A\u6253\u5F00\uFF09\uFF1A| scan with Feishu"),
      phase === "qr" ? (0, import_react.createElement)("img", { src: provision.qrDataUrl, alt: "QR", style: styles.qr }) : (0, import_react.createElement)("div", { style: styles.muted }, "\u7B49\u5F85\u4E8C\u7EF4\u7801\u2026 | requesting QR\u2026"),
      (0, import_react.createElement)("div", { style: styles.muted }, `\u72B6\u6001\uFF1A${provision.pollMessage ?? "\u2026"}`),
      (0, import_react.createElement)("button", { style: styles.btn, onClick: cancel }, "\u53D6\u6D88 | Cancel")
    ) : (0, import_react.createElement)(
      "div",
      {},
      connected ? (0, import_react.createElement)("div", { style: styles.muted }, "\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5\u3002\u60F3\u6362\u4E00\u4E2A\uFF1F\u53D6\u6D88\u540E\u91CD\u65B0\u626B\u7801\u3002| connected; re-scan to replace") : (0, import_react.createElement)("button", { style: styles.primary, onClick: begin, disabled: busy }, busy ? "\u7533\u8BF7\u4E2D\u2026" : "\u{1F4F1} \u626B\u7801\u7ED1\u5B9A | Scan to connect")
    )
  );
}
function apply(ctx) {
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(FEISHU_RPC_CHANNEL, endpoint, payload, signal);
  ctx.slots.inject(
    "settings.plugins.tab",
    () => ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "feishu",
        order: 30,
        label: "\u98DE\u4E66",
        inject: () => ({ rpcCall })
      },
      FeishuSettingsTab
    )
  );
}

    return module.exports;
  }
});
