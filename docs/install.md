# 安装与配置指南（Installation & Configuration）

## 1. 安装包（Install the packages）

```sh
# 把插件装进某个 profile（会转发给 pnpm 安装到 profile 目录）
dsh plugin --profile web add dsh-im dsh-im-telegram
# 可选：飞书（experimental）
# dsh plugin --profile web add dsh-im dsh-im-feishu
```

本地开发/未发布时可用本地路径：

```sh
dsh plugin --profile web add "file:/path/to/dsh-im-bridge/packages/im"
dsh plugin --profile web add "file:/path/to/dsh-im-bridge/packages/im-telegram"
```

## 2. 在 cordis.patch.yml 中启用（Activate rows）

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（或你自己的 profile），追加：

```yaml
# ── dsh-im-bridge ─────────────────────────────────────────────────────────
- insert:
    - id: im
      name: 'dsh-im'
      config:
        security:
          # 可派活的用户（默认空 = 全禁）；键格式：<platform>:<userId>
          # Telegram userId 即聊天 id（私聊）；可用 /status 或先让用户发消息后
          # 由管理员 /trust telegram:<userId> 一键信任
          allowlist: []
          admins: []
          autoCreate: true          # 新聊天自动建会话；false 则先 /new
          maxSessions: 10
          # 个人自用可开：未知用户首条消息自动信任（否则走管理员确认）
          trustOnFirstContact: false
        approvals:
          enabled: true
          timeoutSec: 300           # 超时 → pending（可恢复拒绝）
          pendingMaxSec: 3600       # 兜底：仍无人响应 → 失败关闭
          autoApproveRisk: none     # none | low | medium
          # riskRules 缺省用内置默认（npm install / rm -rf node_modules 等常规操作不弹审批）
        notifications:
          onTurnEnd: true
          onError: true
          includeCost: true
          quietHours: []            # 如 ["22:00-08:00"]
          streamWhileOnline: true   # 人在才推流式增量；人不在只推结果卡片
          onlineWindowMin: 10
        agent:
          provider: ''              # 空 = 用默认模型（deepseek-official / deepseek-v4-flash）
          model: ''
          workspace: ''             # 空 = dsh 启动目录

    - id: im-telegram
      name: 'dsh-im-telegram'
      config:
        token: 'env:TELEGRAM_BOT_TOKEN'
        mode: polling               # polling | webhook（polling 免公网，推荐）
        pollIntervalMs: 1000

    # 可选：飞书（需真实自建应用，配置步骤见 docs/feishu-setup.md）
    # - id: im-feishu
    #   name: 'dsh-im-feishu'
    #   config:
    #     appId: 'env:FEISHU_APP_ID'
    #     appSecret: 'env:FEISHU_APP_SECRET'
```

> ⚠️ **快速联调飞书**：不装进 DSH profile 也可以跑——直接用仓库里的联调脚本
> `node demo/feishu-real.mjs --trust-first`（组合真实 agent loop + DeepSeek + 飞书通道，
> 无需走 profile/bundle 配置）。完整配置指南见 **[`docs/feishu-setup.md`](feishu-setup.md)**。

## 3. 设置密钥（Secrets）

```sh
export TELEGRAM_BOT_TOKEN='123456:ABC-DEF...'   # 找 @BotFather 创建 bot 获得
dsh web
```

飞书：在 [飞书开放平台](https://open.feishu.cn) 创建**企业自建应用**，按
[`docs/feishu-setup.md`](feishu-setup.md) 配置：开启机器人能力、加
`im:message.p2p_msg:readonly`（收单聊必需）/ `im:message:send_as_bot`（发送必需）权限、
事件配置加 `im.message.receive_v1`（长连接）、
**回调配置加 `card.action.trigger`**（审批按钮，⚠️ 在「回调配置」页签）、发布版本。

## 4. 首次使用（First run）

1. 私聊你的 bot，发任意消息 → 若 `trustOnFirstContact: false`，bot 会提示未授权（或向管理员推送信任确认，管理员回复 `/trust telegram:<你的id>`）。
2. 发 `/status` 检查渠道连接与配置缺口（FR-9.3）。
3. 发 `/new` 创建会话，然后直接派活：

```
/new
跑一下 tests 目录的 pytest
```

4. 高危操作（如 `rm -rf ~`）会弹审批卡片，点按钮或回复 `/approve <id> yes`。

## 5. 命令速查（FR-4）

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

## 6. 数据与存储（FR-2.2 / §8.4）

- `$DSH_HOME/dsh-im/mappings.json`：chat↔session 映射、allowlist/admins 运行期追加、原子写
- `$DSH_HOME/dsh-im/approvals.log`：追加式审批审计（FR-6.7）
- `$DSH_HOME/dsh-im/im-inbox/<chatId>/`：IM 附件落盘（FR-7.1）
- 可改 `storeDir` 配置指向其他目录

## 7. 常见问题（FAQ）

**bot 不理我？** 检查 allowlist 是否授权（`/status` 看 allowlist，管理员 `/trust`）；检查 token 是否正确（`/status` 显示渠道连接状态）。

**审批超时了怎么办？** 默认 300s 后任务进入 pending（可恢复），回复 `/approve <id> yes` 或点按钮仍可放行；`pendingMaxSec` 后失败关闭（deny-by-default 兜底）。

**DSH 升级后插件报错？** 本插件按 FR-9.4 启动即报错并提示升级命令，绝不静默失效。锁定 peerDependencies 版本区间（`@deepseek-ai/dsh-*` `^0.1.0-rc.6`）。

**群聊能用吗？** 能（发送者属性 + allowlist 只读），共享 session 默认关；话题隔离（FR-8.5）在 v1.5。
