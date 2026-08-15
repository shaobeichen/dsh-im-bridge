# dsh-im-feishu（飞书适配器）

飞书渠道适配器：**官方 SDK `@larksuiteoapi/node-sdk`** 长连接接收事件（免公网）+ 交互卡片审批按钮 + 文件消息。

> ✅ 状态：**已在真实飞书自建应用上跑通**（长连接 ready、文本收发、审批卡片）。
> 配置步骤见 [`docs/feishu-setup.md`](../../docs/feishu-setup.md)（含 `card.action.trigger` 回调配置的准确位置）。

- 依赖：`inject: ['im']`（需 `dsh-im` 核心）
- 密钥：`appId: 'env:FEISHU_APP_ID'`、`appSecret: 'env:FEISHU_APP_SECRET'`（§9：密钥不落明文）
- 联调脚本：`node demo/feishu-real.mjs --trust-first`
- 测试：`npm run test:feishu`（stub 官方 SDK，验证事件→ImMessage/回调→出站接线）

## 实现说明

- 事件订阅（长连接）：
  - `im.message.receive_v1`（接收消息）→ 统一 ImMessage → `ctx.im.dispatchInbound`
  - `card.action.trigger`（卡片回传交互，**在开放平台「回调配置」页签添加**）→ `ctx.im.handleCallback`
- 出站：
  - 文本消息 `im.message.create`（`receive_id_type` 按入站学习 + id 前缀启发：`ou_`=open_id / `oc_`=chat_id）
  - 审批卡片：`msg_type: interactive`，按钮 value 携带 `{action, id, answer}` 回传；卡片标题用 `out.title`
  - 流式卡片（打字机体验）：`notifications.streamEdit: true`（默认）时，流式增量首帧发送
    interactive 卡片，后续帧经 `im.message.patch` 原地更新同一张卡片（飞书只支持 patch 卡片，
    文本消息不可编辑）；`edit()` 失败时核心自动回退逐条新消息
  - 文件（`/log` 全量交付）：`im.file.create` 上传 → `msg_type: file`
  - 出站业务失败（`code != 0`）一律抛出并带平台错误码（`err.code`/`err.msg`），绝不静默吞掉
- 断线重连/心跳：由官方 `WSClient`（`autoReconnect: true`）内置（FR-1.5）
