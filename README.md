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

## 怎么用（以飞书为例）

一共三步：

1. **在飞书开放平台建一个应用**，拿到 App ID 和 App Secret。这一步有详细图文指引：[docs/feishu-setup.md](docs/feishu-setup.md)
2. **在电脑上启动桥**。电脑需要装好 Node.js（22 或更高），在仓库目录跑一次 `npm install`，然后运行启动命令，看到"连接成功"就绪
3. **在飞书里给机器人发消息**。搜索你建的应用，私聊它

之后就可以：

- 发 `/new` 创建会话
- 直接发任务，比如"列出当前目录的内容"
- 遇到危险操作，机器人发审批卡片，点按钮放行或拒绝
- 发 `/status` 看状态，`/log` 导出完整结果

企业微信的用法类似，步骤见 [docs/wecom-setup.md](docs/wecom-setup.md)。Telegram 见 [packages/im-telegram](packages/im-telegram)。

> 想先不接任何 IM，在终端里体验？运行 `node demo/mock-demo.mjs` 即可。

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
