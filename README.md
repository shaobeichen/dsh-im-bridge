<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/banner.jpg">
  <img alt="dsh-im-bridge" src="docs/banner.jpg" width="720">
</picture>

<h1>dsh-im-bridge</h1>

[![GitHub stars](https://img.shields.io/github/stars/shaobeichen/dsh-im-bridge)](https://github.com/shaobeichen/dsh-im-bridge/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/shaobeichen/dsh-im-bridge)](https://github.com/shaobeichen/dsh-im-bridge/network/members)
[![CI](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**在飞书 / 企业微信 / Telegram 里指挥 DeepSeek Harness：远程派活 · 结果通知 · 危险操作审批**

[English](README.en.md) | [中文](README.md)

</div>

**dsh-im-bridge** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 IM 通道。
DeepSeek Harness（DSH）是一个本地运行的 AI 助手引擎——能在你的工作目录里读写代码、执行命令、
跑长任务，平时你用网页界面指挥它。dsh-im-bridge 给这个网页界面加了一个"远程遥控器"：
你在飞书、企业微信或 Telegram 里给机器人发消息，消息变成指令交给 DSH 执行，结果再发回你的聊天里。

简单说：**聊天窗口就是 DSH 的操作台**。

## ✨ 支持平台

| 平台 | 状态 | 说明 |
|---|---|---|
| 飞书 | ✅ 可用 | 官方长连接，审批是卡片按钮，已真实联调 |
| 企业微信 | ✅ 可用 | 回调 + 消息加解密，审批走文本命令 |
| Telegram | ✅ 已实现 | 免公网轮询，审批是按钮（需自己申请 bot token） |
| 钉钉 | 规划中 | — |

## 📦 里面有什么

- **聊天派活**：在 IM 里直接给 AI 发任务，像聊天一样自然
- **危险操作审批**：删文件、系统命令这类操作要你确认才执行，默认拒绝
- **结果通知**：任务完成或失败主动推送，附耗时和 token 用量
- **完整结果导出**：长输出截断时，用 `/log` 把全文导出成文件发回来
- **会话管理**：`/new` 建会话、`/status` 看状态、`/mute` 关通知等常用命令
- **权限控制**：配置哪些人能用、哪些人是管理员（只有管理员能审批和改配置）

## 🚀 怎么用

**前提**：电脑上已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。如果终端里运行 `dsh` 提示 `command not found`，先安装：

```sh
npm install -g @deepseek-ai/dsh     # 全局安装；验证：dsh --version
# 不想全局装？每次命令前加 npx：npx @deepseek-ai/dsh <命令>
```

三个平台都是同一条路：**装插件 → 配凭据 → 重启 → 在聊天里用**。不用克隆本仓库、不用写代码。

| 平台 | 一条命令安装 | 准备（拿什么） | 开始用 |
|---|---|---|---|
| 飞书 | `dsh plugin --profile web add dsh-im dsh-im-feishu` | 在[开放平台](https://open.feishu.cn/app)建企业自建应用，拿 App ID / App Secret（[图文指引](docs/feishu-setup.md)） | 配好凭据重启 `dsh web`，在飞书私聊机器人：`/new` → 派活；危险操作弹审批卡片，点按钮放行 |
| 企业微信 | `dsh plugin --profile web add dsh-im dsh-im-wecom` | 在[管理后台](https://work.weixin.qq.com/wework_admin/frame)建自建应用，拿 CorpID / AgentId / Secret，并配置回调地址和可信 IP（[指引](docs/wecom-setup.md)） | 配好凭据重启 `dsh web`，手机"工作台"打开应用：`/new` → 派活；审批回复 `/approve <id> yes`（企微无按钮） |
| Telegram | `dsh plugin --profile web add dsh-im dsh-im-telegram` | 用 [@BotFather](https://t.me/BotFather) 建 bot，拿 token（[图文指引](docs/telegram-setup.md)） | 配好凭据重启 `dsh web`，私聊 bot：`/new` → 派活；危险操作弹审批卡片，点按钮放行 |

> 凭据通过环境变量配置（`FEISHU_APP_ID`、`WECOM_CORP_ID`、`TELEGRAM_BOT_TOKEN` 等），具体见各平台 setup 文档。

> [!NOTE]
> 想**不装进 DSH**、克隆仓库直接跑联调脚本（需要 Node.js 22+）？见下方「开发者相关」里的 demo 运行器说明。

## 🗂 包结构

| 目录 | 说明 |
|---|---|
| packages/im | 核心：聊天消息处理、会话管理、审批、通知 |
| packages/im-telegram | Telegram 适配器 |
| packages/im-feishu | 飞书适配器 |
| packages/im-wecom | 企业微信适配器 |
| demo | 演示和运行脚本 |
| docs | 使用文档 |

## 🧭 架构

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

## 🤝 开发者相关

- 想改代码、加新渠道，先看 [CONTRIBUTING.md](CONTRIBUTING.md)
- 给 AI 代理看的仓库规则：[AGENTS.md](AGENTS.md)
- 原始产品需求文档：[docs/PRD-v0.5.md](docs/PRD-v0.5.md)

**不想装进 DSH、直接跑联调脚本？**（需要克隆本仓库 + Node.js 22+）

```sh
node demo/mock-demo.mjs            # 终端模拟 IM，不接任何平台
node demo/feishu-real.mjs --mode demo     # 真实飞书（需 FEISHU_APP_ID/SECRET）
node demo/wecom-real.mjs --mode demo      # 真实企微（需 WECOM_* 凭据）
node demo/telegram-real.mjs --mode demo   # 真实 Telegram（需 TELEGRAM_BOT_TOKEN）
```

## 🔒 安全说明

这个项目会执行远程指令、操作真实文件，所以安全是重点。核心原则：默认拒绝，危险操作必须你点头。安全模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 📄 License

MIT
