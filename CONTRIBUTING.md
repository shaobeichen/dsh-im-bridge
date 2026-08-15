# 贡献指南（Contributing）

感谢你愿意为 dsh-im-bridge 做贡献！这个项目把 DeepSeek Harness 通过 IM（飞书/企微/Telegram/钉钉…）暴露出去——**可指挥、可通知、可审批**。

本指南适用**人类贡献者**。AI 代理请同时阅读 [`AGENTS.md`](AGENTS.md)（仓库"宪法"，DSH/Claude Code/Codex 等会自动加载）。

## 代码结构

```
packages/im/           核心插件：ctx.im 服务、会话映射、命令、通知总线、审批管理、MockChannel
packages/im-telegram/  Telegram 适配器（参考实现 ✅）
packages/im-feishu/    飞书适配器（官方 SDK 长连接 ✅ 已实测）
packages/im-wecom/     企微适配器（回调 URL + 加解密 ✅ 已实测）
demo/                  mock-demo.mjs（终端演示）、feishu-real.mjs / wecom-real.mjs（真实运行器）、bridge-core.mjs（共享桥核心）、policy.js（权限模型）
docs/                  设计文档（PRD、适配器指南、各平台 setup、demo/prod 模式）
```

## 环境准备

- Node.js ≥ 22
- `npm install`
- 跑测试：`npm test`（78+ 用例：核心单测 + agent-loop 集成 e2e + 假服务器渠道测试，**全部无需真实 token/API key**）

## 我能贡献什么

| 方向 | 入口 |
|---|---|
| **新渠道适配器**（钉钉/QQ/Telegram 打磨…） | 先读 [`docs/adapters-guide.md`](docs/adapters-guide.md)（十条经验+落地清单），然后 `node scripts/new-adapter.mjs <platform>` 生成骨架 |
| **核心功能**（PRD 里程碑里的 v1/v2 项：话题隔离、/resume、记住审批、Web 设置页…） | [`docs/PRD-v0.5.md`](docs/PRD-v0.5.md) 的 §12/附录 G |
| **权限模型**（策略细化、按用户授权、审计） | [`demo/policy.js`](demo/policy.js) + [`docs/modes.md`](docs/modes.md) |
| **文档/翻译** | README 中英双语；平台 setup 文档用"平台的词+页签名" |

## 开发流程

1. `npm test` 确认基线绿
2. 小步提交：每个逻辑改动配对应测试（本项目原则：**没有测试的改动不合并**）
3. 新适配器验收：
   - `node scripts/new-adapter.mjs` 生成骨架
   - 契约测试 + stub SDK 测试全绿（`node --test "packages/im-<x>/test/*.test.js"`）
   - `docs/adapters-guide.md` 文末 checklist 逐项打勾
4. 提交信息风格：`feat(im-wecom): ...` / `fix(approvals): ...` / `docs: ...`（Conventional Commits）

## 安全（本项目红线）

- **密钥一律 `env:` 引用**，任何文件/日志/测试不得出现真实凭据
- 提交前自查：`grep -rn "<你的token>" .` 应为空
- 涉及远程执行/审批/文件操作的改动，必须过 `docs/adapters-guide.md` 的十条规则
- 发现安全问题请走 [`SECURITY.md`](SECURITY.md)，不要公开 issue

## PR 流程

1. fork → 分支 → 改动 → 测试 → PR
2. 描述：改了什么、为什么、测试怎么跑的
3. CI（GitHub Actions `npm test`）必须绿
4. 维护者评审：优先合并小而清晰的 PR；大改动先开 issue 讨论
