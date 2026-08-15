# 安装与配置指南

把 dsh-im-bridge 装进 DeepSeek Harness（`dsh`），在 IM 里指挥你的 agent。
**前提**：电脑上已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。如果 `dsh` 提示 `command not found`，先装：

```sh
npm install -g @deepseek-ai/dsh    # 全局安装；验证 dsh --version
# 或每次用 npx @deepseek-ai/dsh <命令>
```

> 想**不装进 DSH**、克隆仓库直接跑联调脚本？见文末「附：不装进 DSH 的方式」。

## 1. 一条命令装插件

```sh
# 选一个渠道（可多个一起装）
dsh plugin --profile web add dsh-im dsh-im-feishu -w       # 飞书
# dsh plugin --profile web add dsh-im dsh-im-wecom -w      # 企业微信
# dsh plugin --profile web add dsh-im dsh-im-telegram -w   # Telegram
```

装完插件自带默认配置（`dsh.bundle` 自动应用），**不需要手动改配置文件**。

> 如果报 `ERR_PNPM_ADDING_TO_ROOT`（pnpm 9 在 workspace 根的限制），在命令末尾加 `-w`（`--workspace-root`）即可——上面已默认带上。

## 2. 配凭据（环境变量）

各渠道凭据一律通过环境变量配置，在启动 `dsh web` 前导出：

| 渠道 | 环境变量 | 说明 |
|---|---|---|
| 飞书 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 开放平台自建应用，配置步骤见 [`feishu-setup.md`](feishu-setup.md) |
| 企业微信 | `WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET` / `WECOM_CALLBACK_TOKEN` / `WECOM_ENCODING_AES_KEY` | 管理后台自建应用，配置步骤见 [`wecom-setup.md`](wecom-setup.md) |
| Telegram | `TELEGRAM_BOT_TOKEN` | BotFather 创建，配置步骤见 [`telegram-setup.md`](telegram-setup.md) |

所有渠道都需要：`DEEPSEEK_API_KEY`（真实模型 key）。

```sh
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export DEEPSEEK_API_KEY=sk-xxx
```

## 3. 重启并开始用

```sh
dsh web
```

然后在 IM 里私聊机器人：

```
/new                               # 创建会话
跑一下 tests 目录的 pytest           # 派活
/status                            # 渠道/会话/审批状态
/log                               # 导出完整结果
```

高危操作（删文件、系统命令等）会弹审批卡片/文本提示，批准才执行（默认拒绝）。

## 4. 自定义配置（可选，默认不需要）

插件有默认配置（allowlist 空 = 全禁、审批开、通知开）。要改的话，编辑
`$DSH_HOME/profiles/web/cordis.patch.yml` 覆盖对应行：

```yaml
- id: im
  config:
    security:
      allowlist: ["feishu:ou_xxx"]     # 可派活的用户（默认空 = 全禁）
      admins: ["feishu:ou_xxx"]        # 管理员（可审批/信任人）
      autoCreate: true                 # 新聊天自动建会话
      trustOnFirstContact: false       # 个人自用可开 true（否则走管理员确认）
    approvals:
      timeoutSec: 300                  # 审批超时 → pending（可恢复拒绝）
      autoApproveRisk: none            # none | low | medium
    notifications:
      quietHours: []                   # 如 ["22:00-08:00"] 静默时段
```

完整配置项见 [`example-cordis.patch.yml`](example-cordis.patch.yml)。

> 多用户部署建议用 `--mode prod` 的严格基线（强制 allowlist、禁自动信任），见 [`modes.md`](modes.md)。

## 5. 命令速查

| 命令 | 功能 | 权限 |
|---|---|---|
| `/start` `/new` | 创建新会话 | allowlist |
| `/status` | 会话/渠道/审批状态 | allowlist |
| `/log` | 完整输出以文件发回 | allowlist |
| `/help` | 帮助 | 所有人 |
| `/mute` `/unmute` | 本聊天通知开关 | 本人 |
| `/approve <id> yes|no` | 文本审批（无按钮渠道降级） | allowlist |
| `/trust <platform:userId>` | 信任用户（管理员） | admin |
| `/revoke <platform:userId>` | 撤销授权（管理员） | admin |

## 6. 数据与存储

- `$DSH_HOME/dsh-im/mappings.json`：chat↔session 映射、allowlist/admins 运行期追加、原子写
- `$DSH_HOME/dsh-im/approvals.log`：追加式审批审计
- `$DSH_HOME/dsh-im/im-inbox/<chatId>/`：IM 附件落盘
- 可改 `storeDir` 配置指向其他目录

## 7. 常见问题

**bot 不理我？** 检查 `/status` 看渠道连接与 allowlist（管理员 `/trust` 授权）；检查凭据环境变量是否正确导出。

**审批超时了怎么办？** 默认 300s 后任务进入 pending（可恢复），回复 `/approve <id> yes` 或点按钮仍可放行；`pendingMaxSec` 后失败关闭（deny-by-default 兜底）。

**DSH 升级后插件报错？** 插件按「不兼容即报错」启动即提示升级命令，绝不静默失效；用 `dsh plugin --profile web update dsh-im ...` 升级。

**群聊能用吗？** 能（发送者属性 + allowlist 只读），共享 session 默认关；话题隔离在 v1.5。

---

## 附：不装进 DSH 的方式（开发者/快速联调）

克隆仓库 + Node.js 22+，用联调脚本直接跑（组合真实 agent loop + DeepSeek + IM 通道，等价于插件行为）：

```sh
npm install
node demo/mock-demo.mjs                   # 终端模拟 IM，不接任何平台
FEISHU_APP_ID=... FEISHU_APP_SECRET=... DEEPSEEK_API_KEY=... \
  node demo/feishu-real.mjs --mode demo   # 真实飞书
# 企微 / Telegram 同理，见各平台 setup 文档
```
