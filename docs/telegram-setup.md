# Telegram 联调指南（完整版）

> 目标：只看这一篇，把 dsh-im-telegram 从零跑通——在 Telegram 里指挥 DeepSeek Harness 的真实 agent。
> 全文约 10 分钟。**Telegram 是所有平台里最省事的**：不需要企业资质、不需要审批、不需要公网。

## 先说 Telegram 和飞书/企微的差异

| | 飞书 | 企业微信 | Telegram |
|---|---|---|---|
| 创建门槛 | 企业自建应用 + 管理员审批 | 企业自建应用 + 管理员审批 | **个人就能建，2 分钟** |
| 收消息 | 长连接（免公网） | 回调 URL（**要公网**） | **polling 轮询（免公网）** |
| 审批 | 卡片按钮 | 文本命令 | **内联按钮** |
| IP 白名单 | 无 | **有（可信 IP）** | 无 |

**核心结论：Telegram 只需要一个 bot token，token 即用即生效，没有审批、没有公网、没有 IP 白名单。**

---

## ① 创建 bot，拿 token（约 2 分钟）

1. 打开 Telegram（手机 App 或桌面版）
2. 搜索 **@BotFather**（官方机器人，蓝色对勾认证）
3. 私聊它，发 **`/newbot`**
4. 按提示：
   - 给你的 bot 起个**显示名**（如 `DSH Agent`）
   - 再起一个 **username**（必须以 `bot` 结尾，如 `dsh_agent_bot`）
5. 完成后 BotFather 会返回一行：

```
Use this token to access the HTTP API:
123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**这行 `123456789:AAH...` 就是 token**（= 运行器的 `TELEGRAM_BOT_TOKEN`）。复制保存。

> ⚠️ token 相当于 bot 的密码：拥有它的人能操控你的 bot。不要公开；怀疑泄露可在 BotFather 发 `/revoke` 重置。

## ② 可选：几个推荐设置（都在 @BotFather 里发命令）

| 命令 | 作用 | 建议 |
|---|---|---|
| `/setprivacy` → Disable | 群聊里响应所有消息（默认只响应 @ 和命令） | 群聊用就设，单聊不用管 |
| `/setjoingroups` → Enable | 允许 bot 被拉进群 | 群聊用就开 |
| `/setcommands` | 给 bot 设置命令菜单（/new /status /log /help /mute /unmute） | 建议设置，手机端长按菜单可见 |

`/setcommands` 可以这样填（逐行发命令名和说明）：

```
new - 创建新会话
status - 查看状态
log - 导出完整输出
help - 帮助
mute - 关闭通知
unmute - 开启通知
```

## ③ 启动运行器

电脑需要 Node.js 22+，仓库目录先跑一次 `npm install`。

```sh
# 演示模式（开发自用）
TELEGRAM_BOT_TOKEN=123456789:AAH... DEEPSEEK_API_KEY=sk-你的Key \
  node demo/telegram-real.mjs --mode demo

# 真实部署（必须先配 allowlist/admins，否则拒绝启动）
IM_ALLOWLIST="telegram:你的数字ID" IM_ADMINS="telegram:你的数字ID" \
TELEGRAM_BOT_TOKEN=... DEEPSEEK_API_KEY=... \
  node demo/telegram-real.mjs --mode prod
```

终端显示 `📡 Telegram 连接: ✅ @你的bot用户名` 即就绪（bot 会自动 polling，免公网）。

> 不用真实模型也可以：`--mock-llm`（仅 demo 模式）。
> 换用 webhook 模式（需公网 HTTPS + setWebhook）：把 `mode` 改成 `webhook` 并配 `webhookUrl`，一般不推荐，polling 更省事。

## ④ 在 Telegram 里使用

1. 打开 Telegram，搜索你建的 **bot username**（如 `dsh_agent_bot`）
2. 点进去，按 **Start** 或直接发消息
3. 使用：

| 你发 | 结果 |
|---|---|
| `/new` | 创建会话 |
| 直接发任务，如 `列出当前目录的内容` | agent 执行，结果流式发回 + 结果卡片 |
| 危险操作（如删除文件） | 弹**审批卡片**，点【批准】【拒绝】按钮 |
| `/approve <id> yes` | 文本审批（备用） |
| `/status` | 渠道/会话/审批状态 |
| `/log` | 完整输出以文件发回 |
| `/mute` `/unmute` | 通知开关 |

## ⑤ 排查

| 现象 | 原因与解决 |
|---|---|
| 启动报 `401 Unauthorized` | token 无效：复制完整了吗？没有多余空格？BotFather `/revoke` 过吗？ |
| 启动报 `409 Conflict` | **同一 token 被两个进程同时轮询**（多开/残留进程）——只保留一个实例 |
| bot 单聊不回话 | 检查 `📡 Telegram 连接` 是否 ✅；`/status` 看 allowlist（demo 模式首条消息自动信任） |
| 群聊不回话 | 隐私模式开启（只响应 @ 和命令）→ BotFather `/setprivacy` → Disable |
| 审批按钮点了没反应 | 检查终端是否报错；按钮回调走同一连接，一般不会单独失效 |
| 命令没反应 | 群聊里命令要带 @，如 `/new@你的bot用户名`（或 BotFather 开 privacy Disable） |

## 附：命令菜单 /setcommands 一次粘贴版

```
new - 创建新会话
status - 查看状态
log - 导出完整输出
help - 帮助
mute - 关闭通知
unmute - 开启通知
approve - 审批 用法 /approve id yes|no
```
