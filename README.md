# dsh-im-bridge — 统一 IM 桥插件家族

> 让 DeepSeek Harness 通过 IM 可指挥、可通知、可审批。
> 基于 `dsh-im-bridge-PRD.md`（v0.5）实现的 **MVP 可运行版本**。

[![CI](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

English | [中文](#中文)

**dsh-im-bridge** is a plugin family (core + channel adapters) that exposes the DeepSeek Harness agent through instant messaging — dispatch tasks, receive results, and approve risky operations remotely, no need to watch `127.0.0.1:3080`.

This monorepo implements the **MVP scope** of the PRD (`§12 MVP`): a real `dsh-im` core plugin against the actual `@deepseek-ai/dsh` plugin seams (`ctx.agents` / `session/event` / `tools/pre-execute` / `approval/request`), a **MockChannel** for contract/e2e tests (NFR-7), a **Telegram adapter** (polling, fully tested against a fake Bot API), and an **experimental Feishu adapter** (WebSocket long connection, protocol-level tests only — needs a real Feishu app to verify).

## Packages

| Package | Role | Status |
|---|---|---|
| [`packages/im`](packages/im) | Core `dsh-im`: unified message model, session mapping + persistence, slash commands, notification bus, approval manager (risk gate + answerer), MockChannel | ✅ tested (44 tests, incl. 4 full-loop e2e) |
| [`packages/im-telegram`](packages/im-telegram) | Telegram adapter: Bot API polling (NAT-friendly, no public webhook), inline-keyboard approval cards, file delivery | ✅ tested against fake Bot API (8 tests) |
| [`packages/im-feishu`](packages/im-feishu) | Feishu adapter: official SDK long connection, interactive-card approvals | ✅ tested (4) + live-verified |
| [`packages/im-wecom`](packages/im-wecom) | WeCom adapter: callback URL + message encryption, app-message send, text-based approval fallback | ✅ tested (11); needs enterprise account + public tunnel |

## Feature coverage vs PRD

| PRD | Implemented |
|---|---|
| FR-1 channel adapters (`ctx.im`, ImMessage, dedupe, reconnect) | ✅ core + adapters; Telegram polling w/ exponential backoff + fatal-error stop |
| FR-2 session mapping (chat→session, persisted `mappings.json`, restart recovery) | ✅ deterministic ids + atomic save + lazy resume |
| FR-3 message flow & rendering (MD→text, truncation, `/log` full delivery, attachments→`im-inbox`) | ✅ |
| FR-4 commands (`/start /new /status /log /help /mute /unmute /approve /trust /revoke`) | ✅ permission-layered (admin vs allowlist, FR-4.2) |
| FR-5 notifications (turn/end card + usage/cost, aggregation, quiet hours, online/offline split, actionable retry) | ✅ |
| FR-6 approvals (risk rules, `tools/pre-execute` ask, `approval/request` answerer, buttons + `/approve` fallback, recoverable timeout, first-responder-wins, `approvals.log`) | ✅ (FR-6.8 remember-decision deferred to v1.5) |
| FR-8 group chat (sender attribution, allowlist read-only, share-off default) | ⚠️ partial — group routes to shared session; topic isolation (FR-8.5) deferred |
| FR-9 first contact (trust-on-first-contact, `/status` gap hints, loud incompatibility) | ✅ admin-confirmation flow + auto-trust mode |
| NFR-7 MockChannel + no-network e2e tests | ✅ |
| §9 config model (env: secrets, deny-all defaults) | ✅ |

Deferred (per PRD milestones): webhook mode (Telegram config present, polling preferred), `/resume /attach /bind /share`, topic isolation, Web-UI settings page, visual bridge, group multi-admin voting.

## Quick start (real DSH profile)

```sh
# 1) install packages into a profile
dsh plugin --profile web add dsh-im dsh-im-telegram

# 2) add rows to $DSH_HOME/profiles/web/cordis.patch.yml
#    (see docs/install.md for the full example)

# 3) set secrets and boot
TELEGRAM_BOT_TOKEN=123:abc dsh web
```

Then message your bot in Telegram: `/start` → `/new` → `跑一下 tests 目录的 pytest`.

## 先跑起来看看（no tokens needed）

The fastest way to see it working is the **live demo** — it boots the real agent loop with a scripted LLM and a Mock IM channel, so you can command the agent right from your terminal:

```sh
node demo/mock-demo.mjs        # interactive: type tasks, approve/reject risk cards
node demo/mock-demo.mjs --auto # scripted walkthrough of the whole flow
DEEPSEEK_API_KEY=sk-xxx node demo/mock-demo.mjs --real   # real DeepSeek model + real shell tool
```

Try: `/new`, `跑一下 pytest`, `删除 /tmp 危险操作` (an approval card pops up), then `!approve <id>`.
`--real` runs a real DeepSeek agent in a temp workspace with real streaming, result cards (duration + tokens), and IM-gated approval for risky shell commands (`--auto-approve` auto-approves for scripted runs).

## Architecture

```
IM platforms (Telegram / Feishu / …)
        │  bot API / long-poll / WebSocket
        ▼
Channel adapters (protocol ⇄ unified model only)
        │ ImMessage / handleCallback
        ▼
dsh-im core (ctx.im)
   • session-map   chat↔session, allowlist, mappings.json
   • commands      /start /new /status /log /approve …
   • renderer      MD→text, truncation, /log
   • notify-bus    turn/end cards, aggregation, quiet hours, online split
   • approvals     risk gate + approval/request answerer + approvals.log
        │ followup() / steer()      │ session/event        │ approval seam
        ▼
   DSH Agent runtime (ctx.agents / dsh-user-approval / dsh-tools)
```

## Development

```sh
npm install
npm test          # 56 tests: unit + agent-loop e2e + fake Bot API + feishu protocol
```

The integration tests compose the **real** `dsh-agent-loop` (via `dsh-agent-loop-testkit`) with a scripted LLM adapter and drive the full 派活→审批→通知 loop through MockChannel — no IM tokens or LLM keys needed.

## Security model (PRD §10)

- allowlist default **empty = deny all**; new chats do not auto-create sessions; `trustOnFirstContact` auto-trust is opt-in for personal use
- first contact from an unknown user → **admin confirmation** in IM (`/trust` or button), never silent
- high-risk tool calls (`rm -rf ~`, `curl | sh`, …) are gated via `tools/pre-execute` and answered through the official `approval/request` seam — deny-by-default, timeout is *recoverable* (pending window, FR-6.4)
- button callbacks are validated against the allowlist (not trusted from message content)
- secrets via `env:` references only; args in approval cards are redacted (keys/tokens masked)
- messages are rendered as plain text (no HTML injection)

## Roadmap (from PRD appendix G)

Phase 0–1 (demand proof / spike) → **Phase 2 MVP (this repo)** → Phase 3 release & measurement → Phase 4 data-driven v1+. The PRD's falsification gates (§13 / F.4) still apply: activation <50% or D7 retention <20% → rework onboarding; <100 installs and no organic praise → cut.

## License

MIT. Independent implementation of the PRD; not affiliated with deepseek-ai.

---

# 中文

**dsh-im-bridge** 是一个插件家族（核心 + 渠道适配器），把 DeepSeek Harness 的 agent 能力通过 IM 暴露出来——离开电脑也能派活、收通知、远程审批高危操作。

本仓库实现了 PRD（v0.5）的 **MVP 范围（§12）**：核心 `dsh-im` 对接真实 `@deepseek-ai/dsh` 插件缝（`ctx.agents` / `session/event` / `tools/pre-execute` / `approval/request`）、内置 **MockChannel**（NFR-7 无网络 e2e）、**Telegram 适配器**（polling，用假 Bot API 全量测试）、**飞书适配器**（experimental，WS 长连接，仅协议级测试——需要真实飞书应用联调）。

## 包结构

| 包 | 职责 | 状态 |
|---|---|---|
| [`packages/im`](packages/im) | 核心：统一消息模型、会话映射+持久化、斜杠命令、通知总线、审批管理（风险门 + answerer）、MockChannel | ✅ 44 个测试（含 4 个全链路 e2e） |
| [`packages/im-telegram`](packages/im-telegram) | Telegram：Bot API polling（免公网）、内联按钮审批卡片、文件交付 | ✅ 假 Bot API 8 个测试 |
| [`packages/im-feishu`](packages/im-feishu) | 飞书：官方 SDK 长连接、交互卡片审批 | ✅ 已实测跑通 |
| [`packages/im-wecom`](packages/im-wecom) | 企业微信：回调 URL + 消息加解密、应用消息、文本审批降级 | ✅ 已实现（11 测试）；需企业账号 + 公网隧道 |

## 覆盖范围（对照 PRD）

- **FR-1** 渠道架构：`ctx.im` 服务、`ImMessage` 统一模型、幂等去重、断线指数退避 ✅
- **FR-2** 会话映射：确定性会话 id + `mappings.json` 原子持久化 + 重启懒恢复（UC6）✅
- **FR-3** 消息流转与渲染：MD→纯文本降级、截断、`/log` 全量交付、附件落盘 `im-inbox` ✅
- **FR-4** 命令集：`/start /new /status /log /help /mute /unmute /approve /trust /revoke`，admin/allowlist 权限分层 ✅
- **FR-5** 通知：turn/end 结果卡片（含耗时/token/成本）、聚合、静默时段、在线/离线分流、失败可重试 ✅
- **FR-6** 审批（设计中心）：风险规则 + `tools/pre-execute` ask + `approval/request` answerer + 按钮/`/approve` 文本降级 + 超时可恢复拒绝 + 首个响应者生效 + `approvals.log` ✅（FR-6.8 记住判断留 v1.5）
- **FR-8** 群聊：发送者属性、allowlist 只读、共享默认关 ⚠️ 部分（话题隔离 FR-8.5 后置）
- **FR-9** 首次接触：未知用户→管理员 IM 确认（或 `trustOnFirstContact` 自动信任）、`/status` 缺口提示、不兼容即报错 ✅
- **NFR-7** MockChannel + 无网络 e2e ✅
- **§9** 配置模型：`env:` 密钥引用、默认全禁 ✅

按里程碑后置：webhook 模式、`/resume /attach /bind /share`、话题隔离、Web 设置页可视化、视觉桥、群聊多人审批。

## 快速开始（真实 DSH profile）

```sh
dsh plugin --profile web add dsh-im dsh-im-telegram
# 编辑 $DSH_HOME/profiles/web/cordis.patch.yml 加行（完整示例见 docs/install.md）
TELEGRAM_BOT_TOKEN=123:abc dsh web
```

然后给 bot 发：`/start` → `/new` → `跑一下 tests 目录的 pytest`。

## 快速开始（飞书，已实测跑通 ✅）

飞书的"界面"就是**飞书聊天窗口**：私聊机器人 = 派活，结果/审批卡片直接发到聊天里。
完整配置步骤（创建自建应用、权限、事件+回调订阅、发布）见 **[`docs/feishu-setup.md`](docs/feishu-setup.md)**——只看那一篇就能从零跑通。

```sh
# 1) 在飞书开放平台创建企业自建应用（一次性，见 docs/feishu-setup.md）
#    关键：事件配置加 im.message.receive_v1（长连接）；
#          回调配置加 card.action.trigger（审批按钮，⚠️ 在「回调配置」页签，不在「事件配置」）
# 2) 启动桥接程序（保持终端开着）
#    开发自用：--mode demo（首条消息自动信任）
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
  node demo/feishu-real.mjs --mode demo
#    真实部署：--mode prod（必须先配 IM_ALLOWLIST/IM_ADMINS，否则拒绝启动）
IM_ALLOWLIST="feishu:ou_xxx" IM_ADMINS="feishu:ou_xxx" \
  FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
  node demo/feishu-real.mjs --mode prod
# 3) 飞书里私聊机器人：/new → 直接派活 → 高危操作弹审批卡片点按钮
# 4) 演示 vs 真实部署的完整区别见 docs/modes.md
```

终端显示 `📡 飞书连接: ✅ long connection ready` 即已连上。
不想花钱跑真实模型时（仅 demo 模式）：`node demo/feishu-real.mjs --mode demo --mock-llm`。

## 先跑起来看看（不需要任何 token）

最快的体验方式是**现场演示**——组合真实 agent loop + 脚本化 LLM + Mock IM 渠道，直接在终端指挥 agent：

```sh
node demo/mock-demo.mjs        # 交互：打字派活、批准/拒绝审批卡片
node demo/mock-demo.mjs --auto # 脚本自动演示完整流程
DEEPSEEK_API_KEY=sk-xxx node demo/mock-demo.mjs --real   # 真实 DeepSeek 模型 + 真实 shell 工具
```

试试：`/new`、`跑一下 pytest`、`删除 /tmp 危险操作`（弹出审批卡片），然后 `!approve <id>`。
`--real` 模式在临时工作区跑真实 DeepSeek agent：真实流式增量、结果卡片（耗时+token）、危险 shell 命令走 IM 审批（`--auto-approve` 可脚本化自动批准）。

## 架构

```
IM 平台（Telegram / 飞书 / …）
        │ bot API / long-poll / WebSocket
        ▼
渠道适配器（只做协议 ⇄ 统一模型转换）
        │ ImMessage / handleCallback
        ▼
dsh-im 核心（ctx.im）
   • 会话映射   chat↔session、allowlist、mappings.json
   • 命令集     /start /new /status /log /approve …
   • 渲染器     MD→文本、截断、/log
   • 通知总线   turn/end 卡片、聚合、静默时段、在线/离线分流
   • 审批      风险门 + approval/request answerer + approvals.log
        │ followup()       │ session/event        │ 官方审批缝
        ▼
   DSH Agent 运行时（ctx.agents / dsh-user-approval / dsh-tools）
```

## 开发

```sh
npm install
npm test   # 56 个测试：单测 + 真实 agent-loop e2e + 假 Bot API + 飞书协议
```

集成测试用 `dsh-agent-loop-testkit` 组合**真实** agent loop + 脚本化 mock LLM，经 MockChannel 跑通「派活→审批→通知」全链路——不需要任何 IM token 或 LLM key。

## 安全模型（PRD §10）

- allowlist 默认空 = 全禁；新聊天不自动建会话；`trustOnFirstContact` 自动信任仅个人自用
- 未知用户首次接触 → 推送管理员 IM 确认（`/trust` 或按钮），绝不静默
- 高危工具调用（`rm -rf ~`、`curl | sh` 等）经 `tools/pre-execute` 门 + 官方 `approval/request` 缝审批——默认拒绝、超时可恢复（pending 窗口，FR-6.4）
- 按钮回调校验 allowlist 身份；密钥仅 `env:` 引用；审批卡片参数脱敏；消息纯文本渲染（无 HTML 注入）

## 路线（PRD 附录 G）

Phase 0–1（需求反证 / spike）→ **Phase 2 MVP（本仓库）** → Phase 3 发布与测量 → Phase 4 数据驱动 v1+。PRD 的可证伪门槛（§13 / F.4）依然适用：激活 <50% 或 D7 留存 <20% → 回炉上手流程；安装 <100 且无自发好评 → 砍掉。

## 贡献 / 安全 / 许可

- [贡献指南](CONTRIBUTING.md)（人类）· [AGENTS.md](AGENTS.md)（AI 代理自动加载的仓库规则）
- [行为准则](CODE_OF_CONDUCT.md)
- [安全策略](SECURITY.md)——本项目涉及远程执行与真实凭据，报告漏洞请走私信，不要公开 issue
- [变更日志](CHANGELOG.md)

## License

MIT。为 PRD 的独立实现，与 deepseek-ai 无关联。
