# 文档索引

不知道从哪看起？按你的目标选：

| 你想做什么 | 看这篇 |
|---|---|
| **把飞书跑通，在手机/电脑飞书里指挥 agent**（推荐路径） | [`feishu-setup.md`](feishu-setup.md) —— 从创建自建应用到在飞书里派活/审批，完整独立指南 |
| 企业微信 | [`wecom-setup.md`](wecom-setup.md) —— 自建应用 + 回调加密 + 可信 IP |
| Telegram（最省事） | [`telegram-setup.md`](telegram-setup.md) —— BotFather 建 bot，2 分钟搞定 |
| 先不看真 IM，在终端里体验效果（需要克隆仓库 + Node 22） | `node demo/mock-demo.mjs`（终端模拟） |
| 装进 DSH（一条命令 `dsh plugin add`） | [`install.md`](install.md)（含 `-w` 说明与高级配置） |
| 演示 vs 真实部署（运行器形态） | [`modes.md`](modes.md) |
| 分发四连（npm 发布 / awesome 列表 / dsh-market） | [`distribution.md`](distribution.md) |
| 了解产品需求与设计依据 | [`PRD-v0.5.md`](PRD-v0.5.md)（原始产品需求文档） |

快速导览：

- **`feishu-setup.md`** —— 飞书联调完整指南。⚠️ 最容易踩的坑：审批按钮的 `card.action.trigger`
  回调在开放平台「**回调配置**」页签（不是「事件配置」），且每次改配置都要重新发布版本。
- **`install.md`** —— 装进 DSH 的完整流程（`dsh plugin add`、凭据、高级配置）。
- **`example-cordis.patch.yml`** —— 高级自定义配置示例。
- **`modes.md`** —— 运行器形态的 demo / prod 模式。
- **`distribution.md`** —— npm 自动发布与分发四连。
- **`PRD-v0.5.md`** —— 本仓库实现的产品需求文档原件（v0.5，含五轮审核记录）。
