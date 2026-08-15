# dsh-im-bridge

> Command your AI from Feishu, WeCom, or Telegram.
>
> 中文版：[README.md](README.md)

## What is this

dsh-im-bridge is a "chatbot" middleware. Once set up, you can send messages to a bot in Feishu or WeCom, and those messages become instructions for the DeepSeek Harness running on your computer.

In short: **your chat window is the control panel** — no need to sit in front of the computer.

What it does for you:

- Dispatch tasks to your AI even when you're away from the computer
- When the AI wants to do something risky (like deleting files), it asks you first — nothing happens without your approval
- When a task finishes, the result is pushed to your chat automatically
- Long outputs can be exported as a file with a single command

Good for: developers running long tasks with DeepSeek Harness, and anyone who wants to command their AI remotely.

## Getting started (with Feishu)

Three steps:

1. **Create an app on the Feishu Open Platform** (get App ID and App Secret). Step-by-step guide: [docs/feishu-setup.md](docs/feishu-setup.md)
2. **Start the bridge on your computer**. Open a terminal, run one command, wait for "connected"
3. **Message the bot in Feishu**. Search for your app and start a private chat

Then you can:

- Send `/new` to create a session
- Send a task directly, e.g. "list the files in the current directory"
- For risky operations, the bot sends an approval card — tap a button to allow or deny
- Send `/status` to check state, `/log` to export the full output

WeCom works similarly ([docs/wecom-setup.md](docs/wecom-setup.md)). Telegram is also supported ([packages/im-telegram](packages/im-telegram)).

> Want to try it in the terminal without any IM? Run `node demo/mock-demo.mjs`.

## What's inside

- **Chat control**: dispatch tasks, check status, export results from IM
- **Risk approval**: dangerous operations (file deletion, system changes) need your confirmation — denied by default
- **Result notifications**: tasks pushed on completion or failure, with duration and usage
- **Multi-user**: configure who can use it and who can approve
- **Multi-platform**: Feishu, WeCom, Telegram — designed to keep growing

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
