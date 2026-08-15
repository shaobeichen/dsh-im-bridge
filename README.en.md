# dsh-im-bridge

> Command your AI from Feishu, WeCom, or Telegram.
>
> 中文版：[README.md](README.md)

[![CI](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/shaobeichen/dsh-im-bridge/actions/workflows/ci.yml)

## What is this

dsh-im-bridge is a "chatbot" middleware. Once set up, you send messages to a bot in Feishu or WeCom, and those messages become instructions for the DeepSeek Harness running on your computer. In short: **your chat window is the control panel** — no need to sit in front of the computer.

It helps you:

- Dispatch tasks to your AI even when you're away from the computer
- When the AI wants to do something risky (like deleting files), it asks you first — nothing happens without your approval
- When a task finishes, the result is pushed to your chat automatically
- Long outputs can be exported as a file with a single command

## Supported platforms

| Platform | Status | Notes |
|---|---|---|
| Feishu (Lark) | ✅ works | Official long connection, approval via card buttons, verified live |
| WeCom (WeChat Work) | ✅ works | Callback URL + message encryption, approval via text command |
| Telegram | ✅ implemented | No public webhook needed (polling), approval via buttons (bring your own bot token) |
| DingTalk | planned | — |

## What's inside

- **Chat control**: send tasks to the AI from IM, as naturally as chatting
- **Risk approval**: dangerous operations (file deletion, system commands) require your confirmation — denied by default
- **Result notifications**: tasks pushed on completion or failure, with duration and token usage
- **Full output export**: when long output is truncated, use `/log` to send the full text as a file
- **Session management**: `/new` to start, `/status` to check, `/mute` to silence notifications, and more
- **Access control**: configure who can use it and who is an admin (only admins can approve and change settings)

## Getting started (with Feishu)

Three steps:

1. **Create an app on the Feishu Open Platform** and get the App ID and App Secret. Illustrated guide: [docs/feishu-setup.md](docs/feishu-setup.md)
2. **Start the bridge on your computer**. You need Node.js 22 or newer; run `npm install` in the repo directory, then run the start command and wait for "connected"
3. **Message the bot in Feishu**. Search for your app and start a private chat

Then you can:

- Send `/new` to create a session
- Send a task directly, e.g. "list the files in the current directory"
- For risky operations, the bot sends an approval card — tap a button to allow or deny
- Send `/status` to check state, `/log` to export the full output

WeCom works similarly ([docs/wecom-setup.md](docs/wecom-setup.md)). Telegram: [packages/im-telegram](packages/im-telegram).

> Want to try it in the terminal without any IM? Run `node demo/mock-demo.mjs`.

## Package layout

```
packages/im            Core: message handling, sessions, approvals, notifications
packages/im-telegram   Telegram adapter
packages/im-feishu     Feishu adapter
packages/im-wecom      WeCom adapter
demo                   Demo and runner scripts
docs                   Documentation
```

## Architecture

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

## For developers

- Want to modify code or add a channel? Start with [CONTRIBUTING.md](CONTRIBUTING.md)
- Repo rules for AI agents: [AGENTS.md](AGENTS.md)
- Original product spec: [docs/PRD-v0.5.md](docs/PRD-v0.5.md)

## Security

This project executes remote instructions and touches real files, so security is a priority. The core principle: denied by default, risky operations require your approval. Security model and vulnerability reporting: [SECURITY.md](SECURITY.md).

## License

MIT. This is an independent implementation of the PRD, not affiliated with deepseek-ai.
