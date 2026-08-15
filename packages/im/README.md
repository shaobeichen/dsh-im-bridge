# dsh-im（核心）

统一 IM 桥核心插件：`ctx.im` 服务、会话映射、命令、渲染、通知总线、审批管理、MockChannel。

- 依赖：`inject: ['agents']`（需要 `dsh-agent`/`dsh-agent-loop`）、可选 `approval`（`dsh-user-approval`，缺省 ask→deny）
- 配置：见 [`docs/example-cordis.patch.yml`](../../docs/example-cordis.patch.yml) 与 [`docs/install.md`](../../docs/install.md)
- 测试：`npm run test:im`（44 个：单测 + 真实 agent-loop 全链路 e2e，无网络/无 key）

## 扩展点（§8.3）

```js
// 第三方渠道：实现 send() 契约后注册即可
ctx.im.registerChannel({
  platform: 'my-im',
  send: async (out) => { /* 发消息 */ },
  sendFile: async (chatId, name, text, mime) => { /* 发文件 */ },
});
// 入站：构造 ImMessage 后交给核心
ctx.im.dispatchInbound({ platform: 'my-im', chatId, userId, text, msgId, chatType });
// 按钮回调：data 载荷约定 approve:<id>:yes|no / trust:<platform>:<userId> / retry:<sessionId>
ctx.im.handleCallback({ platform, chatId, userId, userName, data });
```

事件（其他插件可复用）：`im/message`、`im/command`、`im/dispatch`、`im/approval`。

## 审批接线（FR-6）

- `tools/pre-execute` 风险门：仅拦截 IM 会话的工具调用（不双弹窗，§10），风险规则见 `lib/risk.js`
- `approval/request` answerer：把官方审批缝路由到 IM 卡片；超时 → pending（可恢复拒绝 FR-6.4）
- 文本降级：`/approve <id> yes|no`；首个响应者生效（FR-6.5）；`approvals.log` 审计（FR-6.7）
