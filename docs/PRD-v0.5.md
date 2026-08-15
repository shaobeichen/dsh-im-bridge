# dsh-im-bridge 产品需求文档（PRD）

> 统一 IM 桥插件：让 DeepSeek Harness 通过 IM 可指挥、可通知、可审批
>
> 版本：v0.5（含四轮审核修订 + 需求证据附录 F）｜ 状态：草案待评审 ｜ 作者：AI 辅助设计
> 关联生态：`dsh-plugin` topic（1200+ repos）、官方 deepseek-ai/deepseek-harness（Everything is a Plugin）

---

## 1. 概述

**一句话定位**：`dsh-im-bridge` 是一个插件家族（core + 渠道适配器），把 DeepSeek Harness 的 agent 能力通过 IM（飞书/企业微信/钉钉/Telegram/微信）暴露出来——用户离开电脑也能给 agent 派活、收通知、远程审批高危操作。

**要解决的核心矛盾**：DSH 是本地运行的长任务引擎，而人不可能一直盯着 `127.0.0.1:3080`。当前生态有 21 个碎片化 IM 桥仓库（每个渠道一个 repo，0~9 星，无赢家），需求已被验证、标准答案缺位。

---

## 2. 问题与机会

| 事实 | 证据 |
|---|---|
| 碎片化 | topic 上 IM 相关 21 个仓库：wecom / lark / dingtalk / telegram / wechat 各两三个，互不兼容，全部 <10⭐ |
| 无标准架构 | 有的走 bot API、有的走 gateway、有的依赖第三方壳（ClawBot），没有统一的消息模型、会话模型、审批模型 |
| 官方缺位 | 官方未提供 IM 通道；官方 cookbook 的 "external protocol driver" 模式是现成参考（`packages/acp/acp` 为完整示例） |
| 高频动作 | 「派活、收结果、审批、提醒」是 agent 使用中每天发生的动作，全部需要离开 Web UI 的能力 |

**机会**：做一个「统一核心 + 可插拔渠道」的插件家族，把三个最高频动作（指挥 / 通知 / 审批）一次做对，成为该赛道的标准答案，并顺势进入 awesome 列表与插件市场。

---

## 3. 目标与非目标

### 3.1 目标（Goals）

1. G1：用户能在任意支持的 IM 中新建会话、向 agent 派活、查看状态、收回结果。
2. G2：任务完成/失败/需要审批时，主动推送到 IM。
3. G3：高危工具调用（bash、网络、文件删除）可经 IM 远程审批，默认拒绝。
4. G4：架构可扩展——新增一个 IM 渠道 = 实现一个 adapter，不改核心。
5. G5：安装体验对标社区标准：一条命令装完、双语文档、默认安全。
6. G6：**首启即用**——装完到第一次派活不超过 3 步（配置可视化 + 引导清单 + 首次信任确认）。

### 3.2 非目标（Non-goals，明确不做）

- NG1：不做个人微信官方通道（无官方 API，见风险 R4）。
- NG2：不做 IM 内的完整 Web UI 替代（编辑器、会话浏览）——那是 Web/TUI 的事。
- NG3：不做多 DSH 实例聚合（一个 IM bot 管多台机器）——放 v3。
- NG4：不做语音/视频消息（但手机端文本/文件为主，任务派发靠命令与短文本，长任务描述引导用户回 Web 编写或引用既有 session）。
- NG5：不做企业级 SSO、审计合规导出——放 v2.5+，先验证单点价值。

---

## 4. 用户画像与核心场景

### 4.1 画像

- **P1 独立开发者/极客**（主目标）：本地跑 DSH 做长任务（编译、测试、爬虫、批处理），经常离开电脑。**主力 IM 是国内生态（微信/飞书/QQ），Telegram 未必在用。**
- **P2 小团队（3~10 人）**：共用一个 DSH 实例，需要群聊指挥 + 角色权限。
- **P3 进阶自动化用户**：把 DSH 当后台引擎，IM 当控制台，追求无人值守。

### 4.2 核心场景（Use Cases）

- UC1 **远程派活**：用户在飞书给 agent 发「跑一下 tests 目录的 pytest」，agent 开始执行，完成后推送结果摘要。
- UC2 **远程审批**：agent 请求执行 `rm -rf build/`，IM 弹出审批卡片，用户点「批准」，agent 继续。
- UC3 **任务通知**：长时间任务（编译/下载）完成或失败，推送到 IM；失败附错误摘要。
- UC4 **状态查询**：`/status` 查看当前会话、排队、余额（若装了 balance 插件）。
- UC5 **群聊协作**（需显式开启群共享，见 FR-8.3/FR-8.4）：团队群里 @bot 派活，群里所有人能看到进度，仅管理员能审批/改配置。
- UC6 **断线恢复**：DSH 重启后，之前的 IM 会话自动映射回原 session，历史上下文不丢。
- UC7 **外出拿全量结果**：人在外面，长输出被截断时用 `/log` 把完整结果以文件/长文本发到手机——**不需要回电脑**。

---

## 5. 竞品与差异化

| 仓库 | 现状 | 我们的差异点 |
|---|---|---|
| dbydd/dsh-onlyne | 多平台 gateway，2⭐ | 无统一消息模型/审批流文档；核心+adapter 架构不清晰 |
| One1turn/dsh-omnibridge | AstrBot 式多平台桥，0⭐ | 依赖 AstrBot 生态；我们原生 cordis、直连 `ctx.agents` |
| omdsh-dev/dsh-lark、imetn/dsh-lark-bridge 等 | 单渠道，各做各的 | 我们一个核心统一消息/会话/审批/通知模型，渠道只是插件 |
| 官方 ACP（packages/acp/acp） | 面向 IDE/自动化客户端，非 IM | 我们面向 IM 交互，含审批/通知/命令；复用其 agent 驱动模式 |

**差异化卖点**：approve-first（审批是设计中心，不是附加功能）+ 统一消息模型 + 渠道可插拔 + 通知总线（turn 事件 → 任意渠道/任意目标）+ **对"用户真的会离开电脑"这件事做对**（全量结果可推送、审批可恢复、通知不刷屏）。

---

## 6. 功能需求（FR）

### FR-1 渠道适配架构

- FR-1.1 核心 `dsh-im` 提供 `ctx.im` 服务：渠道注册、统一消息模型 `ImMessage{platform, chatId, userId, text, attachments?, msgId}`、统一事件 `im/message`、`im/command`。
- FR-1.2 每个渠道一个独立插件包：`dsh-im-telegram`、`dsh-im-feishu`、`dsh-im-wecom`、`dsh-im-dingtalk`、`dsh-im-wechat-gw`（experimental）。adapter 只做「平台协议 ⇄ 统一模型」转换，不含业务逻辑。
- FR-1.3 adapter 支持两种连接模式：**polling**（Telegram getUpdates、钉钉 stream 模式）与 **webhook**（需要公网 HTTPS 时）。优先级：polling/长连接优先（NAT 友好，国内用户无公网也能用）。
- FR-1.4 消息去重：按平台消息 ID 幂等去重（webhook 重投、长轮询偏移）。
- FR-1.5 断线重连：指数退避 + 心跳 + 状态可观测（`/status` 显示各渠道连接状态）。

### FR-2 会话模型与映射

- FR-2.1 映射规则：
  - 私聊：`platform + chatId` → 一个 DSH SessionId（默认每聊天一个 session）。
  - 群聊：默认 `platform + groupId` → 共享 session（群内消息带发送者属性）；可选 per-user 模式。
  - 跨渠道绑定（v2）：用户主动 `/bind` 自己的多平台 ID → 同一 DSH 用户。
- FR-2.2 会话持久化：映射表存 `$DSH_HOME/profiles/<name>/dsh-im/mappings.json`（或 SQLite），启动时恢复；DSH 重启后聊天自动回到原 session。
- FR-2.3 新聊天默认**不自动建 session**（防误触、防攻击面扩大）：首次发消息时回复引导（「/new 创建会话，或等待管理员授权」），可配置 `autoCreate`。
- FR-2.4 会话上限：`maxSessions` 默认 10，超限拒绝新建并提示清理。

### FR-3 消息双向流转与渲染

- FR-3.1 IM→agent：文本直接 `agent.followup()`；图片/文件落盘到 session 工作区并附路径文本（v1 起支持）。
- FR-3.2 agent→IM：监听 `session/event`（`assistant/chunk` 文本增量、`turn/end`、`tool/start` 等），经渲染器转为平台格式（Telegram HTML / 飞书 post / 企业微信 markdown / 钉钉 markdown）。
- FR-3.3 **流式策略（重要）**：不做逐 token 转发（IM 限频 + 刷屏）。采用「蓄水池 + flush」：每 ~400ms 或累计 N 字符发送一次增量；`turn/end` 强制刷完。**且仅当用户会话在线（最近 N 分钟活跃）时发送流式增量，人不在时只发结果卡片**（见 FR-5.5）。
- FR-3.4 长输出截断与全量交付：单条消息超限时拆分（按段落）；无法拆分时折叠为「摘要 + 关键结论」，并提供 `/log` 命令把完整输出作为文件/长文本发送到手机——人在外也能拿到全量结果，而不是被迫回电脑看 Web UI。摘要必须包含可执行的结论，不依赖「回 Web 看日志」路径。
- FR-3.5 Markdown 渲染器按平台能力降级（表格/代码块/链接支持矩阵），不可渲染元素转纯文本。
- FR-3.6 推理过程原生渲染（证据驱动新增）：agent 的 reasoning/thinking 增量映射为平台原生"思考过程"（飞书思考卡片 / Telegram 折叠文本），默认折叠、可展开，不占正文字数。真实用户原声（dsh-lark issue #1）：「推理过程显示为飞书原生的思考过程，回复单独发出，读起来非常连贯」——被验证为最受喜爱的特性之一。

### FR-4 命令集（IM 内斜杠命令）

| 命令 | 功能 | 权限 |
|---|---|---|
| `/start` / `/new` | 创建新会话 | 所有人（allowlist 内） |
| `/resume <id>` | 恢复历史会话 | allowlist |
| `/status` | 当前会话、队列、渠道连接、余额（若可用） | 所有人 |
| `/attach <workspace路径>` | 切换/绑定工作区（白名单内路径） | 管理员 |
| `/log` | 把当前/上一任务完整输出以文件发回 | 所有人（allowlist 内） |
| `/help` | 命令与用法 | 所有人 |
| `/mute` / `/unmute` | 本聊天通知开关 | 本人 |
| `/approve <id> yes\|no` | 文本方式审批（无按钮渠道的降级路径） | allowlist |
| `/bind` | 跨渠道身份绑定（v2） | 本人 |

- FR-4.1 未知命令回复 `/help` 摘要，不吞消息。
- FR-4.2 群聊中命令权限分层：管理员（allowlist 中标记 admin）才能执行 `/attach` 等敏感命令；普通成员只能派活与查状态。

### FR-5 通知

- FR-5.1 事件源：`turn/end`（含结果摘要、耗时、token 估算）、`agent/error`、`approval/request`。
- FR-5.2 通知目标：发起会话的聊天（默认）+ 可配置全局目标（`notifications.targets`，如固定群）。
- FR-5.3 可配置开关：`onTurnEnd`、`onError`、`includeReasoning`（默认 false）、`includeCost`（默认 true，结果附耗时与 token 成本——用户爱看"这单花了多少"）、`onlyOutcome`（只在完成时通知）。
- FR-5.4 聚合与节流：同一任务只推 1 条结果通知（按会话聚合）；同一会话 1 分钟内不重复推同类通知（除审批）；支持 `quietHours` 静默时段（不推送、只落日志，任务不中断）。
- FR-5.5 在线/离线分流：用户在会话中活跃（最近 N 分钟发过消息）才推送流式增量；否则只推结果卡片——**人不在时手机不被刷屏**。
- FR-5.6 可操作通知：失败通知带「重试」操作（重新 followup 同一任务）；审批超时通知带「重新请求审批」操作——通知不是信息孤岛，是下一步动作的入口。

### FR-6 审批流（设计中心）

- FR-6.1 拦截点：`tools/pre-execute` 返回 `ask` 的工具调用（或按风险规则自动标记：bash、网络、删除、写入关键路径）。
- FR-6.2 交互：优先平台原生交互组件（Telegram inline keyboard / 飞书卡片按钮 / 钉钉卡片）；平台不支持时降级为文本命令 `/approve <id> yes|no`。
- FR-6.3 审批内容：工具名、参数摘要（敏感参数脱敏）、发起会话、风险级别、按钮/命令。
- FR-6.4 超时策略（可恢复拒绝）：`timeoutSec` 默认 300s（按风险分级可配）。超时后任务不直接失败——标记 `pending`，向用户推送「任务被阻塞，等待审批」提醒；用户可回复 `/approve <id> yes` 或点按钮**恢复审批**（deny-by-default 不变，但拒绝可逆、任务不白死）。**状态语义待 spike 定稿**：`tools/pre-execute` 的 `ask` 大概率同步阻塞该 step（`{kind:'ask'}` 是拦截决策，不是挂起决策）——若 harness 支持排队消息（`followup` 队列），pending 期间可消费其他排队消息；否则 agent 整体停在该步骤，恢复即续跑原步骤，需确认部分写入的一致性。
- FR-6.5 群聊审批语义：仅 allowlist 成员可审批；**首个响应者生效**；响应后广播结果。
- FR-6.6 可选自动放行：`autoApproveRisk: none|low|medium`——风险低于阈值直接放行（默认 none，即全部人工审批）。风险规则默认值贴合真实工作流（如 `rm -rf node_modules`、`npm install` 属于常规操作，不应触发审批），避免「审批疲劳 → 用户关掉审批 → 反而更不安全」。
- FR-6.7 审批记录：本地追加式日志 `approvals.log`（时间、请求者、审批人、结果），不落 IM。
- FR-6.8 记住本次判断（v1.5）：用户批准后可选「本次会话记住该命令模式」，同会话同类调用免审批（可随时 `/revoke` 撤销）——降低高频重复操作的摩擦。

### FR-7 富媒体

- FR-7.1 v1：图片/文件 → 落盘 session 工作区 `im-inbox/<chatId>/`，消息文本附带路径。
- FR-7.2 v2：图片自动走视觉桥（对接 modlens / dsh-vision 生态，agent 直接可"看图"）。
- FR-7.3 大小限制：默认单文件 20MB，可配；超限拒绝并提示。

### FR-8 群聊与多用户

- FR-8.1 消息属性：群聊消息始终携带发送者（昵称 + 平台 ID），agent 侧可见（便于「谁派的活」）。
- FR-8.5 群聊会话模型（证据驱动修订）：参考竞品验证过的模型——群聊默认按**话题隔离**（群内一个话题 = 一个 session，用户回复某条消息或 `/topic` 切换话题），而非整群共享一个 session；整群共享仅作为显式可选模式（FR-8.4）。真实用户原声（dsh-lark issue #1）：「群聊里按话题隔离会话，大家各聊各的互不干扰」。平台无 thread 能力时降级为 per-user 模式。
- FR-8.2 allowlist 之外的用户：可读不可写（只能看状态/结果，不能派活、不能审批）——默认 deny 派活。
- FR-8.3 隐私边界：群聊共享 session 默认**关闭**；即使开启，群聊中只共享群内任务，各成员私聊会话内容互不可见；通知默认只回发起聊天（FR-5.2）。
- FR-8.4 群共享开启路径（显式）：仅管理员可执行 `/share on|off` 或经设置页开启；开启时向群广播提示「本群消息将共享给 agent，任务内容群内可见」。

### FR-9 首次接触与上手体验（用户视角核心，第二轮修订新增）

- FR-9.1 全部配置在 DSH Web 设置页可视化（插件声明 Schemastery Config），手改 YAML 仅作高级项；设置页内嵌「安装引导清单」：token 未配 / allowlist 为空 / 渠道未启用 / bot 未拉起——逐项打勾，缺什么提示什么。
- FR-9.2 Trust-on-first-contact：未知用户首次发消息不静默忽略——触发信任确认（类 SSH host key 验证）。**流程顺序固定**：未知用户发消息 → 推送信任确认（默认 Web UI 弹窗；管理员不在电脑前时，可路由到管理员已信任的 IM 聊天——否则"插件专治离开电脑的人，却要人守着电脑授权"，自相矛盾）→ 确认后自动写入 allowlist 并创建/绑定会话 → 回复引导（FR-2.3）。默认仍拒绝，但授权从「改配置文件」变成「点一次确认」。
- FR-9.3 渠道就绪检查：`/status` 输出各渠道连接状态与配置缺口，未就绪时给出缺失项与解决步骤。
- FR-9.4 不兼容即报错：插件与当前 DSH 版本不兼容时启动即打印明确错误 + 升级命令（`dsh plugin --profile web update dsh-im ...`），绝不静默失效。

---

## 7. 非功能需求（NFR）

| 编号 | 需求 | 指标 |
|---|---|---|
| NFR-1 | 安全（详见 §10） | 默认 deny-all；无明文密钥入库 |
| NFR-2 | 稳定性 | 渠道断线自动恢复；DSH 重启后映射恢复；无内存泄漏（长跑 7 天） |
| NFR-3 | 性能 | 单消息 P95 延迟 < 500ms（不含 LLM 推理）；flush 频率受平台限频约束 |
| NFR-4 | 兼容性 | 声明支持 DSH 版本区间（如 `>=0.1.0-rc.6`）；跟随官方 breaking-change 发布节奏；不兼容时启动即报错并给出升级命令（FR-9.4） |
| NFR-5 | 可观测性 | `dsh-im` 状态可经 `/status` 与日志查看；日志分级、不落敏感内容 |
| NFR-6 | 本地化 | README/配置说明中英双语；错误消息用户可见部分双语 |
| NFR-7 | 可测试性 | MockChannel 适配器内置，支持无网络 e2e 测试 |

---

## 8. 架构设计

### 8.1 模块拓扑

```
IM 平台 (飞书/企微/钉钉/Telegram/微信GW)
        │  bot API / webhook / long-poll / WebSocket
        ▼
┌───────────────────────────────┐
│ Channel Adapters (独立包)      │  ← 只做协议 ⇄ 统一模型转换
│  dsh-im-telegram / -feishu    │
│  -wecom / -dingtalk / -wechat │
└──────────────┬────────────────┘
               │ ImMessage / im/message / im/command / 按钮回调
               ▼
┌───────────────────────────────┐
│ dsh-im (核心, ctx.im)          │
│  • 会话映射器 session-map      │
│  • 命令解析器 commands         │
│  • 渲染器 renderer (MD→平台)   │
│  • 通知总线 notify-bus         │
│  • 审批管理器 approvals        │
│  • 持久化 store (mappings.json)│
└──────────────┬────────────────┘
               │ followup()/steer()  │ session/event 监听  │ ctx.approval / tools/pre-execute
               ▼
        DSH Agent 运行时 (ctx.agents)
```

### 8.2 关键数据流

**派活**：`IM消息 → adapter → im-core(会话映射→SessionId) → agent.followup()`；`session/event` 的 `assistant/chunk` 增量进蓄水池，仅在线时 flush 回 IM（FR-5.5）。

**审批**：`agent → tools/pre-execute → {kind:'ask'} → im-core → IM卡片`；用户点按钮 → adapter 回调 → im-core → `ctx.approval` 放行 → agent 继续；超时 → pending + 可恢复拒绝（FR-6.4）。

**通知**：`turn/end → notify-bus（聚合 + 静默时段 + 在线分流）→ 目标聊天渲染推送`。

### 8.3 扩展点（对外契约）

- `ctx.im.registerChannel(adapter)`：第三方可接入新渠道。
- `ctx.im.on('message'|'command'|'approval')`：其他插件可复用/扩展行为。
- 事件名统一前缀 `im/*`，与官方 `session/*`、`tools/*` 事件体系并列，不侵入主循环。

### 8.4 持久化

- `mappings.json`：chat↔session 映射、用户 allowlist、审批日志路径。启动时加载，变更时原子写（tmp+rename）。
- `approvals.log`：追加式审批审计。

---

## 9. 配置模型

```yaml
# $DSH_HOME/profiles/<name>/dsh-im.yml（核心配置；亦可全部在 Web 设置页可视化修改，见 FR-9.1）
im:
  security:
    allowlist: ["feishu:user_a", "telegram:12345"]   # 可派活的用户（默认空=全禁；经首次信任确认自动写入）
    admins: ["feishu:user_a"]                          # 可执行敏感命令/审批
    autoCreate: false                                  # 新聊天是否自动建会话
    maxSessions: 10
  approvals:
    enabled: true
    timeoutSec: 300            # 默认 300s；超时→pending（可恢复拒绝，FR-6.4）
    autoApproveRisk: none      # none|low|medium
    riskRules:                 # 自定义风险规则（工具名/参数正则 → risk 级别）；默认值贴合真实工作流
      - { tool: "tool-bash", args: "rm -rf", risk: "high" }
      # 默认：npm install / rm -rf node_modules 等常规操作 = low，不触发审批
  notifications:
    onTurnEnd: true
    onError: true
    includeReasoning: false
    includeCost: true
    quietHours: []             # 如 ["22:00-08:00"]：静默时段不推送
    targets: []                # 全局通知目标 chatId 列表
  channels:
    telegram:
      enabled: true
      botToken: "env:TELEGRAM_BOT_TOKEN"   # 密钥走 env/settings，不落明文配置
      mode: polling                        # polling | webhook
      webhookUrl: ""                       # mode=webhook 时必填
    feishu:
      enabled: false
      appId: "env:FEISHU_APP_ID"
      appSecret: "env:FEISHU_APP_SECRET"
      mode: websocket                      # 飞书长连接，免公网
    wecom:
      enabled: false
      # corpId / agentId / secret ...
    dingtalk:
      enabled: false
      # clientId / clientSecret / stream 模式
    wechat_gw:
      enabled: false
      # experimental：仅接 ClawBot 等 gateway，稳定性不承诺
```

**配置原则**：① 密钥一律 `env:` 引用或存 DSH settings 加密字段，绝不进配置文件明文；② 默认值全部偏保守（deny-all）；③ 每个渠道独立 `enabled`，装 adapter 但不开 = 无副作用；④ **用户可见配置全部可视化**，YAML 只服务高级用户。

---

## 10. 安全模型

| 威胁 | 对策 |
|---|---|
| 陌生人派活/轰炸 | allowlist 默认空 = 全禁；autoCreate=false；首次接触走 Web UI 信任确认（FR-9.2） |
| 远程触发危险命令 | `tools/pre-execute` 审批门 + deny-by-default + 超时可恢复拒绝 + 风险分级 |
| 密钥泄露 | env/settings 引用；日志脱敏；审批内容脱敏 |
| 公网 webhook 暴露 | 优先 polling/长连接；webhook 强制签名校验（HMAC）|
| 消息注入（markdown/HTML 注入） | 渲染器转义；只渲染白名单标签 |
| 越权访问工作区 | `/attach` 仅限配置白名单路径；默认绑定启动时工作区 |
| 会话数据泄露给群聊 | 群聊共享 session 需显式开启；通知默认只发回发起聊天 |
| 重放/重投攻击 | 平台消息 ID 幂等去重 |
| 结果侧泄露（审批过了但结果含敏感数据） | 结果回传前按会话级脱敏规则（正则/关键词，如密钥、邮箱、手机号模式）打码，可配关闭 |
| 审批按钮回调身份伪造 | 按钮回调校验「点按钮的人」∈ allowlist（消息转发场景同样生效），不信任消息内容本身 |
| 恶意文件经 IM 进入工作区 | im-inbox 仅接收白名单扩展名、文件不可执行；agent 读取前附带来源提示 |
| 官方 ask 与 IM 审批双通道冲突 | 审批路由：会话有 IM 在线用户 → 路由到 IM；否则回退 Web UI；同一请求只弹一处 |

**安全与可用性的平衡（第二轮修订立场）**：deny-by-default 方向正确，但每个安全控制都是用户的摩擦税。原则是「默认拒绝、一键信任、拒绝可逆」——把授权从改文件变成点确认，把超时从任务杀死变成可恢复阻塞，否则用户会用脚投票关闭安全功能。

---

## 11. 安装与分发

- 发布形态：npm 包（`dsh-im`、`dsh-im-feishu`、`dsh-im-telegram` …）+ GitHub 仓库（monorepo，topic: `dsh-plugin`、`deepseek-harness`）。
- 安装（对标社区标准一行命令）：

```sh
dsh plugin --profile web add dsh-im dsh-im-feishu
# 或 git 源：dsh plugin --profile web add "github:<org>/dsh-im-bridge#main&path:/packages/im"
```

- 仓库要求：README 中英双语、截图（审批卡片、聊天界面）、安全/权限声明、兼容矩阵、`dsh.bundle` 声明 + `cordis.patch.yml`。
- 分发渠道：`dsh-plugin` topic → awesome 列表（awesome-dsh-plugin / Alex-Yanggg / 0xsline）→ dsh-market 收录。

---

## 12. 里程碑与范围裁剪

### MVP（2~3 周）
- 核心 `dsh-im` + **双渠道**：Telegram（参考实现：bot API 最友好、CI 可测）+ **飞书（首发渠道**：官方 API、WebSocket 长连接免公网、面向中文目标用户）。adapter 层很薄，双渠道 ≈ 1.3 倍单渠道工作量；若人力只够一个，**选飞书**。
- 文本双向、`/start /new /status /log /help /mute`
- `turn/end` 通知（结果摘要 + 耗时 + 成本）、在线/离线分流、聚合节流
- 审批：按钮 + 文本降级 `/approve`；超时可恢复拒绝（pending + 提醒）
- Trust-on-first-contact 首次信任确认（Web UI）
- MockChannel + 核心 e2e 测试、双语 README、设置页可视化 + 引导清单

### v1（+2~3 周）
- 图片/文件落盘；流式 flush 优化
- 会话映射持久化 + 重启恢复
- 群聊模式 + 权限分层
- 风险规则 `riskRules`（贴合真实工作流）、审批日志
- 可操作通知（失败重试按钮）

### v2（+3~4 周）
- 企业微信 / 钉钉 adapter
- `/resume`、`/attach`、`/bind` 跨渠道身份
- 图片自动视觉桥；`autoApproveRisk` 智能降级
- 记住本次判断（FR-6.8）

### v3（视采用率）
- 多 DSH 实例聚合、企业审计导出、通知模板系统

---

## 13. 成功指标

| 指标 | 目标（发布后 3 个月） |
|---|---|
| topic 可见性（收录与排名） | topic 搜索前 5、被 2+ awesome 列表收录（star 仅作参考，不作主目标） |
| 安装量（dsh-market / npm 下载） | >200 独立安装 |
| 渠道覆盖 | 飞书 + Telegram 稳定可用，企微/钉钉 beta |
| **首启转化** | 安装→首次成功派活 ≤ 3 步（以设置页引导清单完成率度量）；「装完无人应答」类 issue 为 0 |
| **审批使用率** | ≥60% 用户保持审批开启（防审批疲劳指标） |
| issue 健康度 | 一周内响应；P0 bug 24h 内修 |
| 社区贡献 | ≥3 个第三方渠道/功能 PR |

---

## 14. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| R1 | DSH 官方 breaking change 频繁（README 明示） | 高 | 锁版本区间；核心尽量薄，只依赖 `ctx.agents`/`session/event` 等稳定 seam；不兼容启动即报错 + 一键升级（FR-9.4） |
| R2 | 平台限频/风控（尤其群发、快速消息） | 高 | flush 蓄水池、节流、退避、在线/离线分流；文档明示频率建议 |
| R3 | 公网部署门槛（webhook 模式） | 中 | polling/长连接优先（Telegram/飞书/钉钉均可免公网）；webhook 模式文档化（Caddy/ngrok + 签名校验） |
| R4 | 个人微信无官方 API | 中 | 明确降级为 experimental gateway；主推企业微信/飞书 |
| R5 | 同类竞品先发（onlyne/omnibridge） | 中 | 差异化：approve-first + 统一模型 + 通知总线 + 上手体验；抢先发布 MVP 占位 |
| R6 | 审批 UX 复杂导致误拒/误放、审批疲劳 | 中 | 风险分级贴合真实工作流 + 可恢复拒绝 + 记住本次判断 + 审批日志可追溯 |
| R7 | 群聊中多人抢审批/权限混乱 | 低 | 首个响应者生效 + admin 分层，文档写清语义 |
| R8 | 消息注入/社工攻击 | 中 | 渲染白名单、allowlist、命令只解析白名单命令 |
| R9 | 用户装完即死锁（默认全禁无人引导） | 中 | FR-9 首次接触体验：引导清单 + 首次信任确认 + `/status` 缺口提示 |

---

## 15. 开放问题（需评审确认）

1. 群聊共享 session 是否默认开启？（默认关，避免隐私事故）
2. 审批是否要支持「多人审批」（如 2/3 通过）？——MVP 建议否。
3. 密钥存储：优先用 DSH settings 加密字段，还是独立 `.env`？需与官方 settings 能力对齐。
4. 是否在 MVP 就发布 npm 包，还是先 git 源安装收集反馈？
5. `ctx.approval` 与 `tools/pre-execute` 的确切签名需以官方 `docs/cookbook/adding-a-tool.md` 与 `dsh-tool-ask-user` 实现为准，实现前先做 spike。
6. **MVP 首发渠道最终确认**：飞书（目标用户）vs Telegram（CI 友好）——见 §12 决策点。
7. **Trust-on-first-contact 的 Web UI 确认组件**是否可经官方 UI 扩展点实现（ConversationNode / 设置页），需 spike 验证。
8. **审批超时默认值**（300s？）与「恢复审批」窗口长度，需用户访谈校准。
9. **通知「在线判定」窗口**（最近 N 分钟活跃）取多少合理？N 建议 10~30，需实测。

---

## 附录 A：第一轮自审记录（架构/开发视角 → 修订）

### A.1 审核发现

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | P0 | **MVP 范围过载**：原稿 MVP 含 Telegram+飞书+审批+通知+群聊，3 周内不可交付 | 砍至单渠道 Telegram、text-only、审批+通知+基础命令；飞书移 v1 |
| 2 | P0 | **微信渠道不可行**：个人微信无官方 Bot API，原稿未处理 | 降级为 experimental gateway（NG1），主推企业微信/飞书 |
| 3 | P0 | **安全默认值不够严**：原稿 allowlist 默认放行 | 改为默认空=全禁、autoCreate=false、deny-by-default 审批 |
| 4 | P0 | **审批交互缺降级路径**：原稿只考虑按钮，微信等平台无交互卡片 | 增加文本命令 `/approve <id> yes\|no`（FR-6.2），按钮为增强项 |
| 5 | P0 | **公网部署门槛未处理**：webhook 模式对 NAT 用户不友好 | polling/长连接优先（FR-1.3），webhook 仅作可选并文档化 |
| 6 | P1 | **流式转发会刷屏/触发限频**：逐 token 转发不可行 | 蓄水池+flush 策略（FR-3.3），思考中占位符 |
| 7 | P1 | **会话映射无持久化**：DSH 重启即丢映射 | mappings.json 原子写 + 启动恢复（FR-2.2） |
| 8 | P1 | **群聊语义未定义**：多人共享 session 的权限与审批语义模糊 | 首个响应者生效、admin 分层、默认关闭共享（§6 FR-8 / R7） |
| 9 | P1 | **可测试性缺失**：IM 集成测试困难 | 内置 MockChannel + 契约测试（NFR-7，§12 MVP） |
| 10 | P1 | **配置面过宽**：5 渠道 × 多选项，用户易迷失 | 每渠道独立 enabled、默认安全值、`env:` 密钥引用（§9） |
| 11 | P1 | **竞品差异化不明确**：onlyne/omnibridge 已存在 | 明确定位 approve-first + 统一模型 + 通知总线（§5） |
| 12 | P2 | 多实例聚合/SSO/语音被写入正文 | 明确移出（NG2-NG5），防镀金 |
| 13 | P2 | 成功指标只有 star | 改为安装量/渠道覆盖/issue 健康度（§13） |
| 14 | P2 | 未声明 DSH 兼容策略 | 增加版本区间 + 稳定 seam 依赖策略（NFR-4 / R1） |

### A.2 修订结论

- 范围：MVP 收敛为「Telegram 单渠道、文本、通知、审批、4 个命令、MockChannel 测试」——**可交付**。
- 安全：全链路 deny-by-default，审批与 allowlist 是设计中心而非附加功能。
- 架构：核心 `dsh-im` 薄、渠道 adapter 纯转换、事件前缀 `im/*` 不侵入主循环。
- 遗留接受项：多实例、SSO、语音、视觉路由按里程碑后置；微信 gateway 标注 experimental。

> ⚠️ 注意：A.2 中「Telegram 单渠道 MVP」的结论被第二轮用户视角审核推翻（U2），最新范围为 §12。

---

## 附录 B：参考文档

- 官方 deepseek-ai/deepseek-harness：README、docs/cookbook/extension-cookbook.md、adding-a-tool.md、adding-a-package.md、docs/user/develop/basic/publish.md（bundle/profile 机制）、packages/acp/acp（协议驱动完整示例）
- 生态：dbydd/dsh-onlyne、One1turn/dsh-omnibridge、omdsh-dev/dsh-lark、LoserFox/telegram（渠道实现参考）
- 分发：awesome-dsh-plugin、Alex-Yanggg/awesome-DSH-plugin、dsh-market、vlln/plugin-registry（官方插件格式引导）

---

## 附录 C：用户视角审核记录（第二轮，角色扮演审核）

> 方法：代入 P1 独立开发者 / P2 小团队 / P3 自动化用户，完整走一遍「发现→安装→首次配置→第一次派活→第一次离开电脑→第一次审批→长期使用」旅程，逐段问「我会不会在这里卡住/骂人/放弃」。

| # | 级别 | 用户原话（角色扮演） | 根因 | 处置 |
|---|---|---|---|---|
| U1 | P0 | 「我装完了，为什么 bot 不理我？」 | allowlist 默认空 = 全禁，配置入口只有 YAML，**装完即死锁** | 新增 FR-9：trust-on-first-contact（Web UI 一键信任）+ 设置页引导清单 + `/status` 缺口提示 |
| U2 | P0 | 「Telegram？我在国内主力是微信/飞书，装它还得先翻墙」 | MVP 选 Telegram（CI 友好）与**中文目标用户错位**——生态里中文用户占主流（皮肤/文档/社区全是中文） | §12 MVP 改为飞书首发 + Telegram 参考实现；微信/QQ 仅 experimental |
| U3 | P0 | 「人在外面，你却让我回电脑看完整日志？那这插件还有啥用」 | FR-3.4 截断策略默认「回 Web 看」，**本末倒置**——离开电脑恰恰是插件存在的意义 | FR-3.4 改为 `/log` 文件/长文本全量交付 + 摘要含可执行结论（UC7） |
| U4 | P1 | 「审批 60 秒超时，我开个会回来任务就死了，白跑」 | 超时硬拒绝 = 任务白死，且无恢复路径 | FR-6.4 可恢复拒绝：pending + 阻塞提醒 + `/approve` 可再批；默认 300s 可配 |
| U5 | P1 | 「手机被通知刷屏，我直接把它静音了」 | 每个 turn 都推 + 流式增量照发，人不在也刷 | FR-5.4/5.5 聚合 + 静默时段 + 在线/离线分流（离开时只推结果卡片） |
| U6 | P1 | 「我不想手改 YAML，设置应该在界面里」 | 配置只在 YAML 里，DSH 用户习惯设置页可视化 | FR-9.1 设置页可视化（Schemastery Config）+ 引导清单 |
| U7 | P1 | 「rm -rf node_modules 也要我审批？那我干脆关掉审批」 | 风险规则默认值吓人 → **审批疲劳 → 关闭 → 反而更不安全** | FR-6.6 默认规则贴合真实工作流；FR-6.8「记住本次判断」降低摩擦；§13 新增「审批保持开启率」指标 |
| U8 | P2 | 「失败通知除了看一眼还能干嘛？」 | 通知不可操作，是信息孤岛 | FR-5.6 失败通知带「重试」操作 |
| U9 | P2 | 「DSH 一升级插件就坏，还没人告诉我为什么，也没人教我怎么修」 | 兼容性策略只有「声明版本区间」，无用户侧兜底 | FR-9.4 不兼容即启动报错 + 一键升级命令（NFR-4） |
| U10 | P2 | 「群里共享 session，我的任务别人都看得到？」 | 群共享边界不清 | 共享默认关 + 通知只回发起聊天 + 私聊内容互不可见（FR-8.3） |
| U11 | P2 | 「我在飞书和 Telegram 各聊各的，agent 不认得我」 | `/bind` 跨渠道身份排到 v2 | 接受为 v2（架构预留 `im/user` 身份层），文档明示路线 |

### C.1 审核结论

1. **三个 P0 推翻了两处上一轮决定**：①「Telegram 单渠道 MVP」→ 飞书首发；②「配置=YAML+默认全禁」→ 可视化 + 首次信任确认。用户的耐心比架构师的完美更稀缺。
2. **核心洞察**：deny-by-default 方向正确，但**每一个安全控制都是用户的摩擦税**。修订立场是「默认拒绝、一键信任、拒绝可逆、通知不刷屏、全量结果推到手」——让安全功能不成为用户关掉它的理由。
3. **剩余接受项**：U11 多端身份延迟到 v2；微信 gateway 不承诺稳定；语音明确不做（NG4）。
4. 新增 4 个待验证开放问题（§15 #6~#9），其中「首次信任确认的 Web UI 组件可行性」与「首发渠道」需在 spike 阶段定稿。

---

## 附录 D：修订历史

| 版本 | 轮次 | 内容 |
|---|---|---|
| v0.1 | 初稿 | 完整 PRD（架构、FR、NFR、安全、里程碑） |
| v0.2 | 第一轮自审（架构/开发视角） | 14 条发现（4 P0）；MVP 收敛、安全默认收紧、审批降级路径、MockChannel |
| v0.3 | 第二轮用户视角审核 | 11 条发现（3 P0）；新增 FR-9 上手体验、可恢复审批、通知聚合/分流/可操作、飞书首发、首启转化与审批保持率指标 |
| v0.4 | 第三轮找茬审核 | 修 5 处文档硬伤（UC5/FR-8.3 矛盾、首接触双轨、审批 pending 语义、指标自洽）；安全表补 4 项盲区；遗留找茬清单见附录 E |
| v0.5 | 第四轮：需求证据验证 | 采集真实用户原声与竞品 issue 作为证据；新增 FR-3.6 推理原生渲染、FR-8.5 话题隔离会话模型；新增附录 F（证据 + 可证伪验证闭环） |
| v0.6 | 第五轮：执行路线图 | 新增附录 G（Phase 0~4 带决策门的执行路线）；npm 包名占用检查全绿（dsh-im* 8 个包名可用） |

---

## 附录 G：执行路线图（第五轮，带决策门）

> 原则：**先反证，再验证，最后才建设。** 每一步都有退出标准，不达标的下一步不启动。预算按找茬清单 C1 上浮 1.5~2 倍。

### Phase 0 — 需求反证（48h，成本≈0，最便宜的一步）

| 行动 | 产物 | 退出标准 |
|---|---|---|
| 官方 Discord + GitHub Discussions 发需求投票帖（含使用场景多选：远程派活/审批/通知/群协作） | 投票结果 | 有意向 ≥30 人 → 进 Phase 1；<30 → 转 POC 或放弃 |
| 预注册（GitHub Discussion 点赞/回帖即可，不上表单） | 预注册名单 | 同上 |
| npm 包名检查 | ✅ 已完成：dsh-im、dsh-im-feishu、dsh-im-telegram 等 8 个包名全部可用 | — |

### Phase 1 — Spike（3~5 天，技术可行性验证）

| # | 验证项 | 对应风险 |
|---|---|---|
| S1 | 官方 API 实测：`ctx.agents.followup` / `session/event` / `tools/pre-execute` / `ctx.approval` 的真实签名与行为（以官方 examples/web-cordis 与 acp 包为起点） | R1（breaking change） |
| S2 | 审批 pending 语义：`ask` 是否同步阻塞 step？超时/恢复如何续跑？部分写入一致性 | N3（附录 E） |
| S3 | 飞书最小链路：WebSocket 长连接 + 文本收发 + 按钮卡片回调 + 主动消息权限（用户"扫码注册"路径是否可行） | C2/C5（附录 E） |
| S4 | 单 token 多实例冲突实测（Telegram polling 409？）、平台频率配额表 | C4/C5（附录 E） |
| S5 | 选型定稿：原生 adapter vs 复用 OneBot/gateway（写一页取舍文档） | C6（附录 E） |

**退出标准**：飞书"消息→agent→回复"最小闭环跑通 + 审批按钮闭环跑通；未解项必须有明确 workaround 或列入砍单。**S2 若证明 pending 不可行，FR-6.4 降级为"超时拒绝 + 一键重试"，范围不变。**

### Phase 2 — MVP（3~4 周，按 C1 上浮预算）

范围 = §12 MVP（core + 飞书首发 + Telegram 参考实现、文本双向、`/start /new /status /log /help /mute`、结果通知+成本、审批按钮+文本降级、trust-on-first-contact、MockChannel e2e、双语 README、设置页引导清单）。

**顺序要求**：先搭 MockChannel 契约测试框架 → 再写 core → 最后写 adapter（可测性先行，adapter 是平台细节的重灾区）。

### Phase 3 — 发布与测量（发布后 2 周 ~ 1 月）

1. 分发四连：`dsh-plugin` topic → awesome 列表 PR（3 家）→ dsh-market 收录 → npm 发布（6 包同步版本）。
2. 按附录 F.4 采集：激活率 / D7 留存 / 审批保持开启率 / 自发好评。
3. **决策门（falsification）**：激活 <50% 或 D7 留存 <20% → 回炉上手流程；安装 <100 且无自发好评 → 砍掉。

### Phase 4 — v1+（按数据决定，不按计划表）

- 数据达标才做：图片落盘、会话持久化恢复、群聊话题隔离（FR-8.5）、可操作通知、`/resume /attach`。
- 数据不达标：先修 Phase 3 暴露的问题，不追加新功能（防镀金）。
- 维护节奏承诺：对标竞品验证过的"上架当天连更"——发布后 2 周内保持每 2~3 天一个修复版（附录 F.2 证明用户把维护速度当信任信号）。

### 里程碑总览

```
Phase 0 (48h) → 门槛: ≥30 意向 ──→ Phase 1 (3-5d) → 门槛: 飞书闭环 ──→ Phase 2 (3-4w) → MVP
   → Phase 3 (2w-1m) → 门槛: 激活≥50% & 留存≥20% & ≥100 安装 ──→ Phase 4 (v1+，数据驱动)
        └─ 任一门槛不达标 → 回炉 / 砍掉（砍掉也是成功：省了继续烧时间）
```

---

## 附录 F：需求证据与"被喜爱"的可证伪验证（第四轮）

> 回答："如何证明设计满足用户需求、能成为大家喜爱的内容？"——诚实答案：**需求存在可以证明，设计方向可以对齐证据，但"被喜爱"只能发布后测量。** 本附录把前两层做到位，并为第三层设好可证伪标准。

### F.1 需求存在的证据（已采集，2026-08 实测）

| 证据类型 | 证据 | 强度 |
|---|---|---|
| 供给侧 | `dsh-plugin` topic 上 IM 相关仓库 21 个（wecom/lark/dingtalk/telegram/wechat 各两三个），说明有 21 个团队/个人判断"值得做" | 中（也可能=需求弱，无人做完） |
| 需求侧原声 | dsh-lark issue #1（真实用户）："通过飞书直接指挥 DSH 的体验真的非常丝滑"；「上手成本极低：扫码…不到五分钟」；「审批直接变成按钮卡片，点一下就完成确认」；「群聊里按话题隔离会话」；「维护非常积极：上架当天就连更三版」 | **强（用户主动写长文好评 + 送 star）** |
| 活跃度 | dsh-lark 10⭐、LoserFox/telegram 6⭐、wssfk12138/dsh-wechat-notify 5⭐——小但真实有人用 | 中 |
| 官方背书 | 官方 README 把 `dsh-plugin` topic 定为插件分发通道 | 强（生态方向） |
| 维护痛点实证 | LoserFox/telegram 的 issue：DSH 0806 命令面变更、schemastery vendor 化把插件弄坏——兼容性断裂是**已发生的现实**，不是猜测 | 强（验证 R1/C7） |

### F.2 设计决策 ↔ 真实用户原声对照

| PRD 决策 | 用户原声证据 | 结论 |
|---|---|---|
| approve-first（FR-6） | 「审批直接变成按钮卡片，点一下就完成确认，不用来回打字」 | ✅ 设计中心被真实用户验证 |
| 低摩擦上手（FR-9） | 「扫码就能完成应用注册…不到五分钟」 | ✅ 方向正确；补充：扫码注册是竞品已验证的更优形态，FR-9 应含「扫码/免配置」引导 |
| 免公网长连接（FR-1.3） | 「不需要服务器、不需要公网回调 URL，WebSocket 长连接一接就通」 | ✅ 验证 polling/长连接优先 |
| 群共享 session（FR-8.3 旧版） | 「群聊里按话题隔离会话，大家各聊各的互不干扰」 | ❌ **旧模型被推翻** → FR-8.5 改按话题隔离 |
| 无推理渲染（旧版缺） | 「推理过程显示为飞书原生的思考过程…非常连贯」 | ❌ **漏了最受喜爱的特性** → FR-3.6 |
| 维护节奏（旧版缺） | 「上架当天就连更三版，让人放心」 | ⚠️ 喜爱包含对维护者的信任 → 发布节奏写入 §11/§13 |

### F.3 证据反哺设计的 3 处修订（本附录的产出）

1. FR-3.6 推理过程原生渲染（新增）
2. FR-8.5 群聊按话题隔离会话（修订，取代"整群共享"默认）
3. §13 增加"发布节奏/迭代速度"作为信任指标（用户原话证明维护速度直接影响喜爱）

### F.4 把"被喜爱"变成可证伪预测（发布前后验证闭环）

| 阶段 | 指标 | 推翻标准（falsification） |
|---|---|---|
| 发布前（2 周内） | Discord/官方 Discussions 发需求投票 + 预注册页（landing + 一键装） | 预注册 <30 人 → 需求假设弱，转 POC 或放弃 |
| 发布后 2 周 | 激活率（安装→首次成功派活）、D7 留存、审批保持开启率 | 激活 <50% 或 D7 留存 <20% → 上手/价值假设错，回炉 |
| 发布后 1 月 | 安装量、渠道覆盖、主动好评数（像 dsh-lark issue #1 那样的自发内容） | 安装 <100 且无自发好评 → 需求方向错，砍掉 |
| 持续 | issue 里的"感谢作者"类、PR 数、截图分享数 | 有自发传播 = "被喜爱"的代理信号 |

### F.5 诚实的边界（能证明 vs 不能证明）

- ✅ 能证明：需求存在（供给侧 21 + 需求侧原声）；设计方向与真实用户喜好吻合（对照表）；存在推翻我的机制（F.4）。
- ❌ 不能证明（文档阶段）："大家会爱我们的实现"。竞品好评存在幸存者偏差（用的人少才敢夸？），且**用户的喜爱是对竞品实现的**，不是对我们的——唯一办法是发布最小版本、用 F.4 的数据说话。
- 因此本 PRD 的最终验收标准不是"写完很完美"，而是：**spike 验证技术可行性 → MVP 发布 → 用 F.4 的数据决定继续、回炉还是砍掉**。

---

## 附录 E：找茬审核记录（第三轮，挑刺视角）

> 立场：不替文档辩护，专找"哪里会翻车"。分三类：文档硬伤（已修）、安全盲区（已补）、成本误判与待验证（留在找茬清单，spike 阶段定稿）。

### E.1 文档硬伤（已修）

| # | 硬伤 | 修订 |
|---|---|---|
| N1 | UC5 群聊协作与 FR-8.3「共享默认关」矛盾，且无开启路径 | UC5 标注需显式开启；新增 FR-8.4 `/share` 开启路径 + 群内广播提示 |
| N2 | FR-2.3 引导回复与 FR-9.2 信任确认双轨首接触，先后顺序未定义；确认入口在 Web UI 与"离开电脑"场景自相矛盾 | FR-9.2 固定顺序：消息→信任确认→写 allowlist→建会话→引导；确认可路由到管理员已信任的 IM |
| N3 | FR-6.4「暂停该步骤并可继续其他工作」疑似与 DSH 执行模型矛盾（`ask` 同步阻塞 step，无挂起机制） | 改为「状态语义待 spike 定稿」，写明两种可能及部分写入一致性风险 |
| N4 | 附录 A.2 遗留「Telegram 单渠道」结论与 §12 冲突 | 保留 ⚠️ 注，主路径以 §12 为准（重排附录代价大于收益） |
| N5 | §13 把 star 放回主指标（与第二轮矛盾）；「≤3 步」不可测 | star 降为参考；首启转化以引导清单完成率度量 |

### E.2 安全盲区（已补进 §10）

- 结果侧脱敏（审批过了但结果可能含敏感数据，回传前按规则打码）
- 审批按钮回调身份校验（点按钮的人必须 ∈ allowlist，不信任消息内容）
- im-inbox 文件白名单（扩展名 + 不可执行 + 来源提示）
- 审批路由（官方 `ask` 与 IM 不双弹窗：IM 在线→IM，否则→Web）

### E.3 成本误判与待验证（找茬清单，未改文档）

| # | 找茬 | 后果 | 建议 |
|---|---|---|---|
| C1 | **「薄 adapter/薄 core」双重薄是神话**：core 6 个模块不薄；5 平台各自的按钮回调、媒体、限频、签名、重连都不薄。复杂度守恒 | MVP 2~3 周双渠道大概率**过度承诺**，是第一交付风险 | 工期预算 ×1.5~2；或 MVP 真砍到单渠道 |
| C2 | **飞书 onboarding 成本被"免公网"掩盖**：创建自建应用、申请权限、版本发布、用户要把 bot 加联系人/可见范围——新手半天起；Telegram 建 bot 2 分钟 | 首发飞书把开发便利换成了用户/开发者双重摩擦 | 引导清单显式含「飞书应用创建」步骤 + 提供模板/视频；或重估首发渠道 |
| C3 | **「双渠道 ≈ 1.3×」拍脑袋** | 预算失真 | 删掉该数字，按两个独立 adapter 估 |
| C4 | **单 bot token 多实例冲突**：Telegram polling 双进程 409；同一 token 在两个 profile/实例重复启用互踩 | 用户多开即翻车 | FR-1 加「token 单实例校验 + 冲突提示」 |
| C5 | **平台主动消息权限/频率配额未落 FR**：飞书应用默认不能主动发消息；企微 20 条/分钟 | 通知/审批推送静默失败 | FR-5 加各平台配额表 + 主动消息权限检查 |
| C6 | **未论证"为什么不用 MCP/ACP 中转或 OneBot/gateway 生态"**：官方已有 harness-mcp-server；OneBot/NoneBot 有成熟 IM 桥 | 自研 5 adapter = 造轮子，成本与维护被低估 | 补一节「选型取舍」：原生适配（按钮/卡片/审批）vs 复用 gateway（快但薄） |
| C7 | **兼容性无 CI 矩阵落点**："锁版本区间"需要每个 DSH 版本跑 e2e | 升级即碎 | NFR-4 补「DSH 版本 × 渠道 的 CI 测试矩阵」 |
| C8 | **维护模型未定义**：5 平台持续维护 + v3 大计划（多实例聚合），solo 撑不住 | 项目半年后烂尾风险 | 明确 solo/组织；v3 从计划表移除或标注"仅社区驱动" |
| C9 | **微信 gateway 合规风险**：平台条款 + 封号风险 | README 需免责声明 | NG1 补「合规免责」 |
| C10 | **npm 包名占用未查；6 包发布节奏未定义** | 发布当天发现包名被抢 | §11 补发布前包名检查 + 单版本同步发布 |

### E.4 找茬结论

1. 文档级硬伤已清零（N1~N5），安全表补齐 4 项。
2. **最大风险是交付承诺（C1/C3）与平台现实（C2/C4/C5）**——都不是功能问题，是"做不出来/做出来没人能用"的问题。
3. 下一步 spike 的验收标准应包含：C1（工期校准）、N3（审批 pending 语义）、C4（token 冲突）、C6（选型取舍定稿）。
