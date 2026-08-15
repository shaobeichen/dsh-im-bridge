# AGENTS.md — dsh-im-bridge 仓库规则（AI 代理必读）

本文件是 dsh-im-bridge 仓库的"宪法"。任何 AI 代理（DSH agent、Claude Code、Codex、
Cursor 等）在本仓库内工作前，**必须**先完整阅读本文件；修改/新增代码前**必须**遵守下列规则。

## 这是什么

dsh-im-bridge 是一个 DSH 插件家族 monorepo：核心 `dsh-im` + 各 IM 渠道适配器。
让 DeepSeek Harness 通过 IM 可指挥、可通知、可审批。产品需求见 `docs/PRD-v0.5.md`。

```
packages/im/          核心插件（ctx.im 服务、会话映射、命令、通知、审批、MockChannel）
packages/im-telegram/ Telegram 适配器（已完成 ✅，可作参考实现）
packages/im-feishu/   飞书适配器（已完成 ✅，官方 SDK，线上跑通）
demo/                 mock-demo.mjs（终端演示）、feishu-real.mjs（飞书运行器，--mode demo|prod）
docs/                 adapters-guide.md（适配器开发指南，写新适配器前必读）
```

## 硬性规则（违反 = 打回）

1. **写新适配器前，先读 `docs/adapters-guide.md`**，并运行 `node scripts/new-adapter.mjs <platform>` 生成骨架——不允许手写裸文件。
2. **适配器 = 官方 SDK 的薄封装**：平台有官方 SDK 就用官方 SDK（协议/重连/心跳/token 交给它）；
   禁止手写平台协议（飞书教训：协议版本漂移会静默失败）。
3. **SDK 必须可注入**（`internals.sdk` / `internals.fetchImpl` / `internals.wsImpl`），测试用 stub 替换，CI 不碰真实凭据。
4. **契约完整**：适配器必须实现 `registerChannel` 契约 —— `platform`、`send()`、`status`
   （含 `connected`/`detail`/**`lastEventAt`** 心跳）、`dispose()`；可选 `sendFile()`。
   `registerChannel` 时核心会跑 `validateAdapterContract`，不完整直接抛错（FR-9.4 不兼容即报错）。
5. **可观测三件套**（防"连接活着但事件没来"）：连接状态 + 最近事件心跳 + 边界日志（出站失败必须带平台错误码）。
6. **密钥一律 `env:` 引用**（`botToken: 'env:XXX'`），绝不落明文配置/代码/日志。
7. **入站统一走 `ctx.im.dispatchInbound(ImMessage)`，按钮回调走 `ctx.im.handleCallback({data})`**；
   出站用中性 `buttons: [{id,label,style}]`，由适配器映射到平台原生交互组件（飞书卡片/Telegram 键盘/钉钉卡片）。
8. **每个平台写 `parseContent(msgType, content)` 纯函数** + 无网络单测；消息内容格式平台各异，禁止在核心层解析。
9. **测试必须有**：stub SDK 接线测试 + 假服务器 HTTP 测试 + 纯函数单测。
   全部测试不依赖真实 token/API key。改动后必须 `npm test` 全绿。
10. **安全默认**：deny-by-default；安全机制不可用（如本机无沙箱后端）→ 拒绝执行，不降级；
    `--mode demo|prod` 两模式隔离，prod 禁止 demo 专用开关（`--mock-llm`/`--allow-shell`/自动信任）。

## 工作流

1. 改代码前：`npm test` 确认基线绿。
2. 小步提交：每个逻辑改动配对应测试。
3. 改完：`npm test`（62+ 用例，含核心 44、Telegram 8、飞书 4、策略 5、集成 e2e）。
4. 新适配器验收：`node scripts/new-adapter.mjs` 生成的 `test/contract.test.js` 必须通过，
   且 `docs/adapters-guide.md` 文末 checklist 逐项打勾。

## 文档即契约

- `docs/adapters-guide.md` —— 适配器开发指南（十条经验 + 落地 checklist），**先读再写**
- `docs/modes.md` —— 演示 vs 真实部署模式隔离
- `docs/feishu-setup.md` —— 平台 setup 文档的样板（四件事：凭证/权限/订阅/发布）
- 新增平台必须配一份同样的 setup 文档，用平台的词 + 页签名，标红常见走错路
