# dsh-im-bridge

> 在飞书、企业微信、Telegram 里指挥你的 AI。
>
> English: [README.en.md](README.en.md)

[![CI](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml)

## 这是什么

dsh-im-bridge 是一个"聊天机器人"中间件。装好之后，你在飞书或企业微信里给一个机器人发消息，消息会变成指令，交给电脑上的 DeepSeek Harness 去执行。简单说：**聊天窗口就是你的操作台**，不用一直守在电脑前。

它能帮你：

- 人不在电脑前，也能给 AI 派活
- AI 想执行危险操作（比如删文件）时，先问你，你同意它才动手
- 任务干完了，结果自动发到聊天里
- 结果太长，用一条命令就能导出完整内容

## 支持平台

| 平台 | 状态 | 说明 |
|---|---|---|
| 飞书 | ✅ 可用 | 官方长连接，审批是卡片按钮，已真实联调 |
| 企业微信 | ✅ 可用 | 回调 + 消息加解密，审批走文本命令 |
| Telegram | ✅ 已实现 | 免公网轮询，审批是按钮（需自己申请 bot token） |
| 钉钉 | 规划中 | — |

## 里面有什么

- **聊天派活**：在 IM 里直接给 AI 发任务，像聊天一样自然
- **危险操作审批**：删文件、系统命令这类操作要你确认才执行，默认拒绝
- **结果通知**：任务完成或失败主动推送，附耗时和 token 用量
- **完整结果导出**：长输出截断时，用 `/log` 把全文导出成文件发回来
- **会话管理**：`/new` 建会话、`/status` 看状态、`/mute` 关通知等常用命令
- **权限控制**：配置哪些人能用、哪些人是管理员（只有管理员能审批和改配置）

## 怎么用

三个平台都是同样的节奏：**准备 → 启动 → 在聊天里开始用**。电脑需要 Node.js 22+，仓库目录先跑一次 `npm install`。

> 想先不接任何 IM，在终端里体验？运行 `node demo/mock-demo.mjs` 即可。

| 平台 | 准备（拿什么） | 启动 | 开始用 |
|---|---|---|---|
| 飞书 | 在[开放平台](https://open.feishu.cn/app)建企业自建应用，拿 App ID / App Secret（[图文指引](docs/feishu-setup.md)） | 设好 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`DEEPSEEK_API_KEY`，然后运行<br>`node demo/feishu-real.mjs --mode demo` | 私聊机器人：`/new` 建会话 → 直接派活；危险操作弹审批卡片，点按钮放行 |
| 企业微信 | 在[管理后台](https://work.weixin.qq.com/wework_admin/frame)建自建应用，拿 CorpID / AgentId / Secret，并配置回调地址和可信 IP（[指引](docs/wecom-setup.md)） | 设好 `WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_SECRET`、`WECOM_CALLBACK_TOKEN`、`WECOM_ENCODING_AES_KEY`，然后运行<br>`node demo/wecom-real.mjs --mode demo` | 手机"工作台"打开应用：`/new` → 派活；危险操作收到审批文本，回复 `/approve <id> yes`（企微无按钮） |
| Telegram | 用 [@BotFather](https://t.me/BotFather) 建 bot，拿 token | 设好 `TELEGRAM_BOT_TOKEN`，然后运行<br>`node demo/telegram-real.mjs --mode demo` | 私聊 bot：`/new` → 派活；危险操作弹审批卡片，点按钮放行 |

详细的逐屏配置步骤，见各平台的 setup 文档（上面"准备"列已链接）。

## 包结构

| 目录 | 说明 |
|---|---|
| packages/im | 核心：聊天消息处理、会话管理、审批、通知 |
| packages/im-telegram | Telegram 适配器 |
| packages/im-feishu | 飞书适配器 |
| packages/im-wecom | 企业微信适配器 |
| demo | 演示和运行脚本 |
| docs | 使用文档 |

## 架构

消息的流转：

```
你在 IM 里发消息
      ↓
渠道适配器（把平台消息转成统一格式）
      ↓
核心 dsh-im（判断是命令还是任务、管理会话、处理审批）
      ↓
DeepSeek Harness（真正干活）
      ↓
结果原路返回，发到你的聊天里
```

想深入了解，见 [docs/README.md](docs/README.md) 的文档索引。

## 开发者相关

- 想改代码、加新渠道，先看 [CONTRIBUTING.md](CONTRIBUTING.md)
- 给 AI 代理看的仓库规则：[AGENTS.md](AGENTS.md)
- 原始产品需求文档：[docs/PRD-v0.5.md](docs/PRD-v0.5.md)

## 安全说明

这个项目会执行远程指令、操作真实文件，所以安全是重点。核心原则：默认拒绝，危险操作必须你点头。安全模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## License

MIT。本项目是 PRD 的独立实现，与 deepseek-ai 官方无关联。
