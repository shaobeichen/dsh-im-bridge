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

**Command DeepSeek Harness from Feishu, WeCom, or Telegram: remote tasks · result notifications · risk approval**

[中文](README.md) | [English](README.en.md)

</div>

**dsh-im-bridge** is an IM channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
DeepSeek Harness (DSH) is an AI agent engine that runs locally on your computer — it can read and write code
in your working directory, run commands, and execute long tasks. Normally you control it through its web interface.
dsh-im-bridge adds a "remote control" to that interface: you message a bot in Feishu, WeCom, or Telegram,
those messages become instructions for DSH, and results come back to your chat.

In short: **your chat window is DSH's control panel**.

## ✨ Supported platforms

| Platform | Status | Notes |
|---|---|---|
| Feishu (Lark) | ✅ works | Official long connection, approval via card buttons, verified live |
| WeCom (WeChat Work) | ✅ works | Callback URL + message encryption, approval via text command |
| Telegram | ✅ implemented | No public webhook needed (polling), approval via buttons (bring your own bot token) |
| DingTalk | planned | — |

## 📦 What's inside

- **Chat control**: send tasks to the AI from IM, as naturally as chatting
- **Risk approval**: dangerous operations (file deletion, system commands) require your confirmation — denied by default
- **Result notifications**: tasks pushed on completion or failure, with duration and token usage
- **Full output export**: when long output is truncated, use `/log` to send the full text as a file
- **Session management**: `/new` to start, `/status` to check, `/mute` to silence notifications, and more
- **Access control**: configure who can use it and who is an admin (only admins can approve and change settings)

## 🚀 Getting started

All three platforms follow the same rhythm: **prepare → start → chat**. You need Node.js 22+; run `npm install` in the repo directory first.

> Want to try it in the terminal without any IM? Run `node demo/mock-demo.mjs`.

| Platform | Prepare | Start | Use |
|---|---|---|---|
| Feishu | Create an enterprise self-built app on the [Open Platform](https://open.feishu.cn/app), get App ID / App Secret ([guide](docs/feishu-setup.md)) | Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `DEEPSEEK_API_KEY`, then run<br>`node demo/feishu-real.mjs --mode demo` | Private-chat the bot: `/new` → send tasks; risky operations send an approval card — tap a button |
| WeCom | Create a self-built app in the [admin console](https://work.weixin.qq.com/wework_admin/frame), get CorpID / AgentId / Secret, configure callback URL and Trusted IP ([guide](docs/wecom-setup.md)) | Set `WECOM_CORP_ID`, `WECOM_AGENT_ID`, `WECOM_SECRET`, `WECOM_CALLBACK_TOKEN`, `WECOM_ENCODING_AES_KEY`, then run<br>`node demo/wecom-real.mjs --mode demo` | Open the app from "Workbench": `/new` → send tasks; approval comes as text — reply `/approve <id> yes` (no buttons) |
| Telegram | Create a bot with [@BotFather](https://t.me/BotFather), get the token ([guide](docs/telegram-setup.md)) | Set `TELEGRAM_BOT_TOKEN`, then run<br>`node demo/telegram-real.mjs --mode demo` | Private-chat the bot: `/new` → send tasks; risky operations send an approval card — tap a button |

Step-by-step console screenshots live in each platform's setup doc (linked in the "Prepare" column).

> [!TIP]
> Want to try it in the terminal without any IM? Run `node demo/mock-demo.mjs`.

## 🗂 Package layout

| Directory | Description |
|---|---|
| packages/im | Core: message handling, sessions, approvals, notifications |
| packages/im-telegram | Telegram adapter |
| packages/im-feishu | Feishu adapter |
| packages/im-wecom | WeCom adapter |
| demo | Demo and runner scripts |
| docs | Documentation |

## 🧭 Architecture

Message flow:

```
Message from your IM
      ↓
Channel adapter (converts platform message to a unified format)
      ↓
Core dsh-im (command or task? session management, approvals)
      ↓
DeepSeek Harness (does the actual work)
      ↓
Result sent back to your chat
```

For more, see the [docs index](docs/README.md).

## 🤝 For developers

- Want to modify code or add a channel? Start with [CONTRIBUTING.md](CONTRIBUTING.md)
- Repo rules for AI agents: [AGENTS.md](AGENTS.md)
- Original product spec: [docs/PRD-v0.5.md](docs/PRD-v0.5.md)

## 🔒 Security

This project executes remote instructions and touches real files, so security is a priority. The core principle: denied by default, risky operations require your approval. Security model and vulnerability reporting: [SECURITY.md](SECURITY.md).

## 📄 License

MIT
