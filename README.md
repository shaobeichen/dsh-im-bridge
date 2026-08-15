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

先选平台，按对应的章节来。三个平台的步骤都是：**准备 → 启动 → 在聊天里开始用**。

> 想先不接任何 IM，在终端里体验？运行 `node demo/mock-demo.mjs` 即可。

### 飞书

**准备**：在[飞书开放平台](https://open.feishu.cn/app)建一个企业自建应用，拿到 App ID 和 App Secret。详细图文指引：[docs/feishu-setup.md](docs/feishu-setup.md)

**启动**（电脑需要 Node.js 22+，仓库目录先跑一次 `npm install`）：

```sh
FEISHU_APP_ID=你的AppID FEISHU_APP_SECRET=你的AppSecret DEEPSEEK_API_KEY=sk-你的Key \
  node demo/feishu-real.mjs --mode demo
```

看到"连接成功"后，在飞书里搜索你的机器人并私聊它：

- 发 `/new` 创建会话，然后直接发任务，比如"列出当前目录的内容"
- 遇到危险操作，机器人发审批卡片，点按钮放行或拒绝
- `/status` 看状态，`/log` 导出完整结果

### 企业微信

**准备**：在[企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)建自建应用，拿到 CorpID / AgentId / Secret，并配置"接收消息"的回调地址和"企业可信 IP"。详细步骤：[docs/wecom-setup.md](docs/wecom-setup.md)

**启动**：

```sh
WECOM_CORP_ID=你的企业ID WECOM_AGENT_ID=1000002 WECOM_SECRET=你的Secret \
WECOM_CALLBACK_TOKEN=你的Token WECOM_ENCODING_AES_KEY=你的43位Key \
DEEPSEEK_API_KEY=sk-你的Key node demo/wecom-real.mjs --mode demo
```

在手机企微的"工作台"里打开你的应用：

- 发 `/new` 创建会话，然后直接发任务
- 危险操作会收到审批文本，回复 `/approve <id> yes` 放行（企微不支持按钮）

### Telegram

**准备**：找 [@BotFather](https://t.me/BotFather) 创建一个 bot，拿到 bot token。

**启动**：

```sh
TELEGRAM_BOT_TOKEN=你的token node demo/telegram-real.mjs --mode demo
```

在 Telegram 里私聊你的 bot，用法与飞书相同（审批是按钮）。

## 包结构

```
packages/im            核心：聊天消息处理、会话管理、审批、通知
packages/im-telegram   Telegram 适配器
packages/im-feishu     飞书适配器
packages/im-wecom      企业微信适配器
demo                   演示和运行脚本
docs                   使用文档
```

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
