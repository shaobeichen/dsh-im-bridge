# 文档索引

不知道从哪看起？按你的目标选：

| 你想做什么 | 看这篇 |
|---|---|
| **把飞书跑通，在手机/电脑飞书里指挥 agent**（推荐路径） | [`feishu-setup.md`](feishu-setup.md) —— 从创建自建应用到在飞书里派活/审批，完整独立指南 |
| 先不看真 IM，在终端里体验效果（不需要任何 token） | 仓库根目录 `README.md` →「怎么用」，或 `node demo/mock-demo.mjs` |
| 装进真实 DSH profile（`dsh plugin add` + `cordis.patch.yml`） | [`install.md`](install.md) + [`example-cordis.patch.yml`](example-cordis.patch.yml) |
| 了解产品需求与设计依据 | [`PRD-v0.5.md`](PRD-v0.5.md)（原始产品需求文档） |

快速导览：

- **`feishu-setup.md`** —— 飞书联调完整指南。⚠️ 最容易踩的坑：审批按钮的 `card.action.trigger`
  回调在开放平台「**回调配置**」页签（不是「事件配置」），且每次改配置都要重新发布版本。
- **`install.md`** —— 以插件方式装进 DSH profile 的完整配置（含 Telegram）。
- **`example-cordis.patch.yml`** —— 可直接复制粘贴的配置示例。
- **`PRD-v0.5.md`** —— 本仓库实现的产品需求文档原件（v0.5，含五轮审核记录）。
