# 钉钉联调指南（dsh-im-dingtalk）

> 目标：**只看这一篇**，把 dsh-im-dingtalk 从零跑通——在钉钉里指挥 DeepSeek Harness 的真实 agent。
>
> 走的是钉钉**官方 Stream 模式**（协议源自官方 SDK
> [open-dingtalk/dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)），
> WebSocket 长连接，**免公网**（不需要公网 IP / 回调 URL / 内网穿透）。
>
> 全文约 10 分钟。分四部分：
> ① 建机器人拿凭据（最关键）
> ② 安装插件 + 配环境变量
> ③ 在钉钉里使用（派活 / 审批 / 查状态）
> ④ 常见问题排查

---

## ⚠️ 实测诊断经验（2026-10-05，真实企业应用验证）

用真实企业应用凭据做过完整联调。**最重要的一条**：如果"连上了但收不到消息"，
**先查订阅类型，不要先怀疑网络**。

### 🥇 头号原因：漏了 CALLBACK 订阅

钉钉把机器人消息和卡片回调归为 **`CALLBACK`** 类型，而
`registerAllEventListener` 只订阅 `EVENT/*`（`topic:'*'` **不包含** CALLBACK）。
症状就是：`connected=true`、能发消息、但**永远收不到**。

```js
// ❌ 收不到任何消息
client.registerAllEventListener(handler);

// ✅ 正确
client.registerCallbackListener(TOPIC_ROBOT, handler);  // /v1.0/im/bot/messages/get
client.registerCallbackListener(TOPIC_CARD, handler);   // /v1.0/card/instances/callback
client.registerAllEventListener(handler);
```

**一键自检**（最直接的证据）：

```js
console.log(client.getConfig().subscriptions);
// 必须包含 2 条 CALLBACK：
// [{type:'EVENT',topic:'*'},
//  {type:'CALLBACK',topic:'/v1.0/im/bot/messages/get'},
//  {type:'CALLBACK',topic:'/v1.0/card/instances/callback'}]
```

### 症状 → 判据表

| 现象 | 含义 | 该查什么 |
|---|---|---|
| gettoken `errcode=0` | 凭据有效 | — |
| WebSocket `connect success` | **仅**网关握手成功，不代表订阅成功 | 继续往下看 |
| `registered=false` **长期不变** | ✅ **正常** | 它只反映 EVENT 握手，**不是故障指标** |
| `connected=true` 但收不到消息 | ⚠️ 订阅类型不对 | **`getConfig().subscriptions` 有无 CALLBACK** |
| 能发不能收 | ⚠️ 同上（发送走 HTTP、接收走 WS，路径不同） | 同上 |
| 机器人 API 报 `invalidParameter.robotCode.notExsit` | robotCode 传错了 | 传 **Client ID**，不是 AgentId |

### 关键实测发现

**1. `robotCode` = `Client ID`，不是 AgentId**

```
robotCode = ding<your-client-id>    → ✅ OK，返回 processQueryKey
robotCode = 1234567890（AgentId）    → ❌ invalidParameter.robotCode.notExsit
```

适配器已据此把 `robotCode` 默认**回退为 clientId**，通常无需单独配置。

**2. Client Secret 区分大小写**

实测：`EVhr...`（大写 E）→ `errcode=40096 不合法的appKey或appSecret`；
`eVhr...`（小写 e）→ `errcode=0`。**复制 Secret 时注意首字母大小写。**

**3. ⚠️ 不要手动只注入 `EVENT` 订阅**

`topic:'*'` 只覆盖 `EVENT`。机器人消息必须走 `CALLBACK`（见上方头号原因）。
`registerCallbackListener` 会自动把 `{type:'CALLBACK', topic}` 加进 subscriptions。

**4. 应用侧三个配置仍然要做**（但做对了不代表能收消息）

```
□ 应用已「发布」（版本管理与发布）
□ 「添加应用能力」→ 机器人
□ 机器人「消息接收模式」= Stream 模式
```

这三项是**必要条件，不是充分条件**——即使全做对，漏了 CALLBACK 订阅一样收不到。

### 🚫 排查时别走的弯路（我实际走过的）

以下假设我都做了实验并**证伪**，记录在此避免重复：

| 错误假设 | 实验 | 结果 |
|---|---|---|
| 机器人配置没保存/没发布 | 反复核对后台 | 配置本来就是好的 |
| 别的应用占用 Stream 会话 | 杀掉占用进程后重测 | 仍零帧 → **证伪** |
| 代理 fake-IP / TUN 模式拦截 | 关闭 TUN 后重测 | 仍零帧 → **证伪** |
| SDK 版本 bug | 换 `2.1.7-beta.1` | 仍零帧 → **证伪** |
| `registered=false` 是故障 | —— | **误判**，它本来就该是 false |

> 教训：中间件/环境类假设**先做可证伪的最小实验**，再动手改环境——
> 我曾为此关闭用户代理、杀掉用户正在使用的进程，都是不必要的。

---

## 先说钉钉的三大特点（和企微/飞书不一样）

| | 企微 | 钉钉 |
|---|---|---|
| 收消息 | **必须公网回调 URL** | ✅ **Stream 长连接，免公网** |
| 审批 | 文本 `/approve` | 卡片按钮（需注册卡片回调）或文本降级 |
| 机器人类型 | 企业自建应用 | 企业内部机器人应用 |

**免公网是钉钉最大的优势**——不用折腾 ngrok/cloudflared，`dsh web` 直接出站长连接即可。

---

## ① 创建企业内部机器人（约 8 分钟，逐屏路径）

**前置**：打开 https://open-dev.dingtalk.com/ ，用**钉钉 App 扫码**登录；
需要是组织**管理员**，或让管理员给你开发者权限。

### 拿 Client ID / Client Secret

1. 进入「**应用开发**」→「**企业内部应用**」→ 点「**创建应用**」
2. 填应用名称（如 `DSH Agent`）、描述、图标 → 创建
3. 进入应用详情页，左侧点「**凭证与基础信息**」
4. 在「**应用凭证**」区域看到：
   - 「**Client ID**」（旧称 AppKey，形如 `dingxxxxxxx`）→ 复制
   - 「**Client Secret**」（旧称 AppSecret）→ 点「显示」→ 复制

| 变量 | 在哪（精确路径） |
|---|---|
| `DINGTALK_CLIENT_ID` | 应用开发 → 企业内部应用 → 点应用 → 凭证与基础信息 → Client ID |
| `DINGTALK_CLIENT_SECRET` | 同上 → Client Secret（点显示） |
| `DINGTALK_ROBOT_CODE` | 应用详情 → 机器人 → RobotCode（**可选**，见下） |

### 开通机器人能力 + Stream 模式（最容易漏的一步）

1. 应用详情页左侧点「**机器人**」→ 点「**添加机器人**」/「配置」
2. **消息接收模式必须选「Stream 模式」** ⚠️
   - 如果选了「HTTP 回调模式」，桥会显示已连接但**收不到任何消息**（静默失败）
   - 这正是 `docs/adapters-guide.md` 里说的"订阅方式选错 = 静默失败"
3. 机器人名称、图标按需填
4. **发布**：应用详情页右上角「**发布**」→「版本管理与发布」→ 创建版本 → 申请发布
   - ⚠️ 每次改配置都要**重新发布**才生效（和飞书一样）
5. 可见范围设置：至少包含你自己

### 关于 RobotCode（可选）

`DINGTALK_ROBOT_CODE` 只在一种场景需要：**主动推送**（agent 完成任务时主动通知你，
而不是回复你的消息）。配置方法：应用详情 → 机器人 → 查看 RobotCode。

- 只回复消息（最常用）→ **不需要** RobotCode（走 sessionWebhook）
- 需要主动通知 → 需要 RobotCode，且要到「权限管理」开通
  `机器人发送消息`（`Robot.Message.Write`）权限

---

## ② 安装插件 + 配环境变量（约 2 分钟）

```sh
# 装核心 + 钉钉适配器（两个都要装）
dsh plugin --profile web add dsh-im dsh-im-dingtalk -w
```

**配环境变量**（凭据一律走 `env:` 引用，不落明文配置）：

```powershell
# Windows PowerShell（当前会话）
$env:DINGTALK_CLIENT_ID = "dingxxxxxxx"
$env:DINGTALK_CLIENT_SECRET = "你的secret"
# 可选：需要主动推送时
# $env:DINGTALK_ROBOT_CODE = "你的robotCode"
```

永久生效（Windows）：

```powershell
setx DINGTALK_CLIENT_ID "dingxxxxxxx"
setx DINGTALK_CLIENT_SECRET "你的secret"
```

> 也可以在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里直接配
> `clientId: 'env:DINGTALK_CLIENT_ID'`（默认已如此，通常无需改）。

配好后**重启 `dsh web`**。

**验证连接**：重启后在钉钉里给机器人发 `/status`，应显示 `dingtalk` 渠道 `connected: true`
以及「xx 秒前有事件」。如果显示已连接但发消息没反应 → 回看①的第 2 步（Stream 模式）。

---

## ③ 在钉钉里使用

| 你在钉钉里发 | 会发生什么 |
|---|---|
| `/new` | 创建新会话，agent 就绪 |
| 直接发任务，如 `列出当前目录内容` | agent 执行，结果发回钉钉 |
| 任务里触发危险命令（如删除文件） | 收到**审批卡片**，点「✅ 批准」/「❌ 拒绝」按钮 |
| 按钮点不动时 | 审批同时给出文本降级指令：`/approve <id> yes\|no` |
| `/status` | 看渠道连接状态、最近事件心跳、当前会话 |
| `/log` | 长输出被截断时，导出全文 |
| `/mute` | 关闭主动通知 |

### 审批的两种形态

- **卡片按钮**：点一下就完成审批，无需打字
- **文本命令**（默认，始终可用）：回复 `/approve <id> yes` 或 `/approve <id> no`

> ⚠️ 钉钉的 sessionWebhook 消息**只支持 text/markdown 等有限消息类型，不能内联交互按钮**，
> 所以默认形态就是「文本 + 可复制的 `/approve` 命令」，正文自带用法提示，不依赖任何卡片配置。

#### 想要真正的可点按钮？需要互动卡片模板

实测钉钉的两种「带按钮」能力（2026-10，用本应用凭据逐个探测 `oToMessages/batchSend` 的 `msgKey`）：

| msgKey | 是否被接受 | 按钮能力 |
|---|---|---|
| `sampleText` / `sampleMarkdown` | ✅ | 无按钮 |
| `sampleActionCard` / `sampleActionCard2` | ✅ | **有按钮，但只能打开 URL**（`actionURL`），不能回调 |
| `sampleCard` / `interactiveCard` | ❌ `invalidParameter.msgKey.invalid` | — |

要拿到**能回调**的按钮，必须走**互动卡片（card instance）**：

```bash
# 探测结果：接口存在，且强制要求 cardTemplateId
POST /v1.0/card/instances                  → MissingcardTemplateId
POST /v1.0/card/instances/createAndDeliver → MissingcardTemplateId
POST /v1.0/card/instances/deliver          → MissingoutTrackId
```

**因此需要一次性人工步骤**（只有你本组织的管理员能做）：

1. 打开 [钉钉开放平台](https://open-dev.dingtalk.com) → 你的应用 → **卡片平台 / 互动卡片**
2. 新建卡片模板，放上按钮（如「✅ 批准」「❌ 拒绝」），给按钮配置回调 id
3. **发布**模板，复制 `cardTemplateId`
4. 把它填进配置的 `cardTemplateId`，适配器即改走
   `/v1.0/card/instances/createAndDeliver`（`callbackType: 'STREAM'`）发卡

按钮回调不需要公网地址：Stream 长连接已订阅 `TOPIC_CARD`
（`/v1.0/card/instances/callback`），点击事件会从同一条 WebSocket 回来。

> 未配置 `cardTemplateId` 时一切照旧：文本命令始终可用，功能不缺。

---

## ④ 常见问题排查

| 症状 | 原因 | 解决 |
|---|---|---|
| `/status` 显示 `missing clientId` | 环境变量没配 | 检查 `DINGTALK_CLIENT_ID` 是否在**启动 `dsh web` 的那个环境**里 |
| 显示 `connect failed: ...` | 凭据错 / 应用未发布 | 核对 Client ID/Secret；确认应用已**发布** |
| **已连接但@机器人没反应** | 消息接收模式不是 Stream | 机器人配置改回「**Stream 模式**」并**重新发布** |
| **看不到按钮/选项卡** | 钉钉 markdown 消息不支持内联按钮 | 正常现象；用正文里的文本命令。要按钮需配 `cardTemplateId`（见上） |
| 审批卡片没到钉钉 | 被 Web 桥抢先认领 `/approval/request` | 已修（`prepend`）；确认 dsh-im ≥ 本次修复版本 |
| 卡片正文里命令列了两遍 | 旧版 `buildWebhookBody` 重复追加 | 已修（去重） |
| 卡片里出现 `approve:xxx:yes` 原始载荷 | 旧版降级用了内部 id | 已修（改用 `command` 友好命令） |
| 主动通知发不出 | 没配 RobotCode / 没开权限 | 配 `DINGTALK_ROBOT_CODE` + 开 `Robot.Message.Write` |
| 群聊里要@机器人才有反应 | 钉钉群机器人默认需 @ | 正常行为；私聊不需要 |

### 自查清单

```
□ Client ID / Client Secret 已复制到环境变量
□ 机器人「消息接收模式」= Stream 模式  ← 最容易漏
□ 应用已「发布」（每次改配置都要重新发布）
□ 可见范围包含自己
□ 重启了 dsh web
□ /status 显示 connected: true 且「xx 秒前有事件」
□ （可选）主动推送：RobotCode + Robot.Message.Write 权限
```

---

## 附：这个适配器的技术选择

| 决策 | 选择 | 理由 |
|---|---|---|
| 连接方式 | **Stream 模式**（官方 SDK `dingtalk-stream`） | 免公网优先（PRD FR-1.3）；官方 SDK 负责重连/心跳 |
| 出站路径 | **sessionWebhook 优先** | 回复消息最简单，无需额外权限 |
| 出站降级 | 企业机器人 API（需 RobotCode） | webhook 有会话有效期，过期后可主动推送 |
| 按钮 | 卡片回调 → 中性 `approve:<id>:yes` | 与核心统一模型一致；无卡片时降级文本 |
| ID 类型学 | `conversationId` = chatId；`senderStaffId` = userId | 群聊/私聊由 `conversationType`（'2'=群）判定 |

**已知限制**：

- 钉钉 sessionWebhook 有**会话有效期**（`sessionWebhookExpiredTime`），过期后的主动推送必须配 RobotCode
- 文件交付目前以 markdown 代码块形式给出（钉钉 webhook 不支持直接 file 上传）
- 卡片回调解耦在开放平台侧，未注册时按钮不可用（文本 `/approve` 始终可用）