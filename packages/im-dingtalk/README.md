# dsh-im-dingtalk（钉钉适配器）

> DeepSeek Harness 的钉钉渠道适配器：在钉钉里指挥 DSH——远程派活、结果通知、危险操作审批。
> 走钉钉**官方 Stream 模式**（官方 SDK `dingtalk-stream`），WebSocket 长连接，**免公网**。

安装：

```sh
dsh plugin --profile web add dsh-im dsh-im-dingtalk -w
```

完整联调步骤见 **[docs/dingtalk-setup.md](../../docs/dingtalk-setup.md)**。

## 平台四件事

| # | 事项 | 钉钉情况 |
|---|---|---|
| 1 | **凭证** | 开放平台 → 应用开发 → 企业内部应用 → 创建应用 → 凭证与基础信息 → **Client ID / Client Secret** |
| 2 | **权限/作用域** | 收发消息走 Stream **无需额外权限**；仅**主动推送**需 `Robot.Message.Write`（机器人发送消息） |
| 3 | **订阅方式** | ✅ **Stream 模式（免公网）**。⚠️ 机器人配置里必须选 Stream，选成「HTTP 回调模式」会**连接正常但收不到消息**（静默失败） |
| 4 | **发布生效** | 应用必须**发布**；每次改配置后需**重新发布**才生效 |

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `clientId` | `env:DINGTALK_CLIENT_ID` | 应用 Client ID（旧称 AppKey） |
| `clientSecret` | `env:DINGTALK_CLIENT_SECRET` | 应用 Client Secret（旧称 AppSecret） |
| `robotCode` | `env:DINGTALK_ROBOT_CODE` | **可选**。仅主动推送需要 |
| `apiBase` | `https://api.dingtalk.com` | 测试/代理用 |
| `debug` | `false` | 官方 SDK 调试日志 |

密钥一律 `env:` 引用，不落明文（AGENTS.md 规则 #6）。

## 实现状态

- [x] 官方 SDK 薄封装（SDK 可注入 `internals.sdk`）
- [x] `parseContent` / `stripAt` / `normalizeRobotMessage` / `parseCardCallback` 纯函数 + 单测
- [x] 按钮 → 卡片回调映射为中性 `approve:<id>:yes|no`；无卡片时降级文本命令
- [x] 可观测三件套（`connected` + `detail` + **`lastEventAt` 心跳** + 出站错误带平台错误码）
- [x] 免公网（Stream 模式，无需回调 URL）
- [x] 契约测试 + stub SDK 接线测试全绿（21/21）
- [x] **CALLBACK 订阅**（机器人消息必须显式注册，见下方"头号陷阱"）
- [ ] demo 运行器接入（`--mode demo|prod`）

## ⚠️ 头号陷阱：机器人消息是 `CALLBACK`，不是 `EVENT`

**这是本适配器开发中耗时最久的一个坑，务必先读。**

```js
// ❌ 只这样写 → 连接成功、status.connected=true，但永远收不到任何消息
client.registerAllEventListener(handler);

// ✅ 必须显式订阅 CALLBACK topic
client.registerCallbackListener(TOPIC_ROBOT, handler);  // /v1.0/im/bot/messages/get
client.registerCallbackListener(TOPIC_CARD, handler);   // /v1.0/card/instances/callback
client.registerAllEventListener(handler);               // EVENT/* 仍保留（系统事件）
```

原因：`registerAllEventListener` 订阅的是 `{type:'EVENT', topic:'*'}`，
**`topic:'*'` 并不包含 `CALLBACK` 类型**。而钉钉把机器人消息和卡片回调都归为 `CALLBACK`。
官方 Python SDK 对每个 callback handler 都会 push `{type:'CALLBACK', topic}`——Node SDK 同理，
只是必须用 `registerCallbackListener` 才会带上。

**排障要点（血泪教训）**：

| 观察 | 真相 |
|---|---|
| `registered=false` 长期不变 | **正常**！它只反映 EVENT 订阅握手，不是故障指标 |
| `connected=true` + 零帧 | 查 CALLBACK 订阅，**不是**查网络/代理/应用发布 |
| `getConfig().subscriptions` | 这是最直接的证据——应含 2 条 `CALLBACK` |

> 不要被"连接成功"误导：Stream 的 WS 握手成功 ≠ 订阅成功 ≠ 能收消息。
> 唯一可靠判据是 `subscriptions` 里有没有 `CALLBACK` 条目，以及实际收到的帧。

## 设计要点

| 决策 | 选择 | 理由 |
|---|---|---|
| 连接 | Stream 模式（官方 SDK） | 免公网优先（FR-1.3）；重连/心跳交给 SDK |
| 出站 | **sessionWebhook 优先** → 降级机器人 API | 回复消息无需额外权限；webhook 过期后才需 RobotCode |
| 按钮 | 卡片回调 → `approve:<id>:yes` | 与核心中性模型一致（FR-6.2） |
| ID | `conversationId`=chatId，`senderStaffId`=userId | `conversationType`（'2'=群）判定群/私聊 |
| 去重 | Stream ACK 立即返回 `SUCCESS` | 避免服务端 60s 重推同一条消息 |

## 已知限制

- **sessionWebhook 有时效**：过期后的主动推送必须配 `robotCode`，否则只记录告警不报错
- **文件交付降级**：钉钉 webhook 不支持直接 file 上传，`sendFile`（即 `/log` 全文交付）改用
  **`msgtype: 'text'` 纯文本消息**按字节分段送出。**不要改回 markdown**：markdown 会解析正文里的
  ``` / 链接 / 表格，既可能被正文自身闭合导致渲染错乱，也会让原文不再逐字保真。
  普通出站消息仍走 markdown（`buildWebhookBody`）。
- **卡片回调依赖开放平台配置**：未注册卡片回调时按钮不可用；文本 `/approve <id> yes|no` 始终可用
- **@机器人**：群聊默认需 @ 才有事件；私聊不需要