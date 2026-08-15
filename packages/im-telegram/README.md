# dsh-im-telegram（Telegram 适配器）

Telegram 渠道适配器：Bot API **polling 长连接**（免公网、NAT 友好），内联按钮审批卡片，文件交付（`/log`）。

- 依赖：`inject: ['im']`（需 `dsh-im` 核心）
- 密钥：`token: 'env:TELEGRAM_BOT_TOKEN'`（找 @BotFather 创建 bot）
- 测试：`npm run test:telegram`（8 个，本地假 Bot API 服务器，无需真实 token）

## 特性

- polling `getUpdates`（long-poll，30s），指数退避重连（FR-1.5）；401/409 致命错误停止并提示（token 冲突检测 C4）
- 消息/按钮回调 → 统一模型；图片/文件自动下载到本地临时目录（FR-7.1 落盘）
- 出站文本 + `inline_keyboard` 按钮（审批卡片）；`sendFile` 以 document 交付
- `/status` 可见连接状态与缺口（FR-9.3）

## 配置

```yaml
- id: im-telegram
  name: 'dsh-im-telegram'
  config:
    token: 'env:TELEGRAM_BOT_TOKEN'
    mode: polling          # polling | webhook（webhook 需要公网 HTTPS + webhookUrl）
```
