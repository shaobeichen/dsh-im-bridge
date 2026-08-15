# 渠道适配器开发指南（飞书实战提炼）

> 从 dsh-im-feishu 的真实联调过程总结的通用经验。
> **做任何新渠道适配器（Telegram/企微/钉钉/微信GW…）之前，先读这篇。**

## 核心原则：适配器 = 官方 SDK 的薄封装

**第一版飞书的教训**：手写了长连接 JSON 协议——但飞书平台早已改用 protobuf 帧，手写协议连上但收不到事件（协议版本漂移，静默失败）。

- ✅ 平台有官方 SDK 就用官方 SDK（协议、重连、心跳、token 管理它全包）
- ✅ 适配器只做「官方 SDK ⇄ 统一模型（ImMessage / buttons / handleCallback）」的转换
- ✅ SDK 边界做成**可注入**（`internals.sdk`），测试用 stub 替换，CI 不用真实凭据

## 一、平台"四件事"前置检查清单（每个新适配器必做）

飞书的坑：事件收不到 = 缺 `im:message.p2p_msg:readonly` 权限；按钮没反应 = 回调没在「回调配置」页签注册。**每个平台都要先弄清楚这四件事，写进文档并让 `/status` 能检查：**

| # | 事项 | 飞书实例 | 检查方式 |
|---|---|---|---|
| 1 | **凭证** | App ID / App Secret | 用"身份 API"验证（飞书 bot/v3/info），`/status` 显示应用名 |
| 2 | **权限（作用域）** | 收消息要 `im:message.p2p_msg:readonly`，发送要 `im:message:send_as_bot` | 从**官方事件文档**逐个核对（笼统权限往往不顶用） |
| 3 | **订阅方式** | 长连接（企业自建）/ webhook（需公网） | 文档给决策表（见下） |
| 4 | **发布生效** | 每次改配置要"创建版本+审批" | 文档 checklist 末尾必须写"重新发布" |

> ⚠️ 权限是**每个事件/API 各自**要求的，不是"加一个大权限就全通"。做适配器时逐个事件查官方权限要求。

## 二、连接方式决策表（FR-1.3）

| 平台 | 免公网方案 | 公网方案 | 备注 |
|---|---|---|---|
| 飞书 | 长连接 WS（**仅企业自建应用**） | webhook | 集群模式：多实例只随机推送一个 |
| Telegram | getUpdates 长轮询 | webhook | 双进程轮询同一 token → 409 |
| 企微/钉钉 | 长连接/stream | webhook | 企微主动消息 20 条/分钟配额 |
| 个人微信 | 无官方 API | — | 只能 experimental gateway |

- **优先免公网**（PRD FR-1.3）；文档里把"这个平台能不能免公网"放在第一行
- **订阅方式选错 = 静默失败**：选成 webhook 后连接还"活着"但事件全去了 webhook → 可观测性必须能看出"连接活着但没事件"

## 三、可观测性三件套（防"静默失败"的核心）

飞书的坑：桥显示"已连接"但事件一个不来，全靠 SDK debug 日志里的 `receive message` 才定位。

1. **连接状态**：`channel.status = { connected, detail }` → `/status` 展示（已有）
2. **最近事件心跳**：`channel.status.lastEventAt` —— 收到任何事件都更新时间戳，`/status` 显示"xx 秒前有事件"。**连接活着 ≠ 事件在流**，心跳是最早的报警
3. **边界日志**：WS 帧 → 事件 → handler → 出站结果，每层一条 debug 日志；**出站失败必须带平台错误码**（飞书 `code/msg` 极有信息量）

## 四、多实例/凭据冲突

- 飞书长连接是**集群模式**：同一应用多个连接，事件只随机推送一个 → 多开实例会随机丢事件
- Telegram 双进程 polling 同一 token → 409
- ✅ 文档写清"一个 token/一套凭据只允许一个实例"；`/status` 显示连接数或直接做凭据锁

## 五、ID 类型学（每个平台都要提前学）

飞书：open_id / user_id / union_id / chat_id，发消息要指定 `receive_id_type`，发错类型静默失败。

- ✅ 入站时学习 `chatId → id 类型` 映射（飞书：`ou_`=open_id，`oc_`=chat_id 前缀启发兜底）
- ✅ 核心出站统一用 `{platform, chatId}`，id 类型解析留在适配器内

## 六、消息内容解析（平台形状各异）

飞书 text/post/file/interactive 各有 JSON 结构。✅ 每个平台写一个纯函数
`parseContent(msgType, content)`（带降级链），**无网络单测**（飞书已这么做，4/4 通过）。

## 七、审批按钮 = 平台原生交互组件

核心出站 `buttons: [{id, label, style}]` 是中性模型，适配器负责：

- 映射到平台原生组件：飞书 interactive 卡片、Telegram inline_keyboard、钉钉卡片……
- **按钮回调 → 中性 `data` 载荷**回传（`approve:<id>:yes`），核心 `handleCallback` 统一处理
- 平台把"卡片回调"当**回调**不是事件（飞书在「回调配置」页签）——文档必须用平台的词

## 八、测试策略（无网络/无凭据）

1. **stub 官方 SDK**（`internals.sdk`），测"事件 → ImMessage → 出站"接线（飞书 4/4）
2. **假服务器**测 HTTP 协议（Telegram 假 Bot API 8/8）
3. 纯函数单测（parseContent / 按钮映射 / 风险规则）
4. **集成测试只测核心**（MockChannel + 真实 agent loop），适配器不进集成测试

## 九、文档必须用平台的词（用户找不到=文档失败）

飞书实例：用户找不到 `card.action.trigger`，因为它在「**回调配置**」页签而不是「事件配置」；权限标识是 `im:message.p2p_msg:readonly` 不是 `im:message`。

- ✅ 文档写"开发者后台 → 具体页签名 → 按钮名"，并标红常见走错路
- ✅ 每个平台一份独立 setup 文档（feishu-setup.md 模式），含**发布**步骤与自查清单

## 十·一、出口 IP 白名单（企微经典坑，差点又踩）

企微对调用 API 的**出口 IP** 有白名单限制（「企业可信 IP」）：收消息回调不需要白名单，
但**发消息必须**——所以症状是"能收到消息、回复全失败（60020）"，且报错里带着你的 IP。

- ✅ 适配器**启动时自动查公网 IP 并醒目打印**（dsh-im-wecom 已做：`api.ipify.org`）
- ✅ 错误码带 IP 时（`from ip: x.x.x.x`）解析出来提示用户，而不是只 log 一个 errcode
- ✅ 文档把它放**必做步骤**（不是附录）——"怎么知道 IP"写三种方式（桥自打印 / ip.sb / 报错解析）

> 教训：平台限制分"配置期可见"和"运行期才炸"两类。后者必须**程序自检 + 文档必做清单**双保险，
> 放附录 = 等于没写（企微可信 IP 就属于这一类，第一版只放附录，用户果然踩了）。

## 十一、安全：失败关闭

飞书平台侧：本机 macOS 无可用沙箱后端时，官方选择**拒绝执行**而不是裸跑。

- ✅ 安全机制不可用时宁可拒绝，不降级（默认 deny 原则）
- ✅ 演示/生产的开关（`--mode demo|prod`）要在适配器层也体现：prod 禁掉 demo 专用开关

## 新适配器落地 checklist

```
□ 官方 SDK 存在吗？→ 用 SDK，薄封装；SDK 可注入（internals.sdk）
□ 四件事：凭证 / 权限（逐事件核对）/ 订阅方式 / 发布生效 —— 写进文档 + /status 可查
□ 连接方式决策表（免公网优先）
□ 可观测三件套：状态 + 最近事件心跳 + 边界日志（带平台错误码）
□ ID 类型学：入站学习 + 前缀启发
□ parseContent 纯函数 + 单测
□ 按钮 → 平台原生组件 + 回调 → 中性 data
□ stub SDK 测试 + 假服务器测试 + 核心集成测试
□ setup 文档（平台的词 + 页签名 + 发布 + 自查清单）
□ 安全失败关闭；demo/prod 模式隔离
```

## 各平台下一步（按此清单开工）

| 平台 | 第一件事 | 已知坑 |
|---|---|---|
| 企微 | 官方 SDK + 回调 URL 模式 | 主动消息 20 条/分钟；需要可信 IP 配置 |
| 钉钉 | stream 模式（免公网） | 卡片回调需配置；@消息识别 |
| Telegram | 已完成（polling + 假 API 测试） | 409 双进程；callback_data ≤64 字节 |
| 微信 GW | 无官方 API，experimental | 合规风险；仅 gateway |

---

## 附录：让"新 AI"遵守这些规则（机制，不是口号）

写文档没人读。要让后续的 AI 代理（DSH agent / Claude Code / Codex / Cursor）真的遵守，
需要**四层机制**（本仓库已全部落地）：

### 1. `AGENTS.md`（仓库根）—— AI 启动即读的"宪法"

DSH 的 agent 会把工作目录（及子目录）的 `AGENTS.md` 自动加载进上下文；
Claude Code / Codex / Cursor 同样约定先读它。规则 #1 就要求：写新适配器前
先读 `docs/adapters-guide.md` 并跑脚手架——**不遵守规则本身就在违反 AGENTS.md**。

### 2. 契约检查器（机器强制）—— 不完整 = 启动即抛错

`packages/im/lib/channel.js` 的 `validateAdapterContract()`，在
`ctx.im.registerChannel()` 时执行：

- 硬性必需：`platform`（string）、`send()`（function）→ 缺失直接 throw（FR-9.4）
- `status.connected` 必须 boolean；`sendFile`/`dispose` 类型错误 throw
- `status.lastEventAt`（最近事件心跳）缺失 → warning（可观测性提示）

新适配器合不合法，不是"评审说了算"，是**跑起来就报错**。

### 3. 脚手架 `scripts/new-adapter.mjs` —— 规则 by construction

```sh
node scripts/new-adapter.mjs wecom
```

生成 `packages/im-wecom/`：契约完整的 `lib/index.js` 骨架（含 status+lastEventAt）、
**契约测试**（`test/contract.test.js`，直接导入 `validateAdapterContract` 验证）、
stub-SDK 接线测试骨架、四件事 README 模板。AI 从模板出发 = 从合规出发。

### 4. 契约测试进 CI —— 不合规 = 测试红

脚手架的 `test/contract.test.js` 跑在 `npm test` 里：缺契约、缺心跳都会红。
验收标准：新适配器的 `npm test` 全绿 + `docs/adapters-guide.md` 文末 checklist 打勾。

### 检查闭环

```
AGENTS.md（宪法）→ adapters-guide.md（怎么做）→ new-adapter.mjs（骨架）
      → validateAdapterContract（运行时强制）→ contract.test.js（CI 强制）
```

四条链任一都能拦住"不守规矩的适配器"；四条都过，适配器才是合格的。
