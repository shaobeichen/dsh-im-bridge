# 演示模式 vs 真实部署模式

dsh-im-bridge 有两种运行形态，各有对应的"演示/严格"配置：

1. **插件形态**（普通用户，装进 DSH）：没有 `--mode` 概念。严格基线 = 管理员在 `admins` 里配置自己的键（管理员隐式放行；默认空=全禁）、保持 `trustOnFirstContact: false`——普通用户零配置，首接触由管理员一键确认。
2. **运行器形态**（开发者，克隆仓库跑 demo 脚本）：用 `--mode demo|prod` 一键切换，下面的表格针对这种形态。

## 运行器形态：一句话区别

| | 🎛 演示模式 `--mode demo` | 🏭 真实部署 `--mode prod` |
|---|---|---|
| 目标 | 你自己开发、试玩、联调 | 别人（团队/用户）真实使用 |
| 信任 | 首条消息**自动信任** | 首接触走**管理员确认**（`/trust`） |
| allowlist | 不强制 | **必须配置**，否则拒绝启动 |
| 模型 | 真实 DeepSeek 或 `--mock-llm`（不花钱） | 只能真实模型（`--mock-llm` 被禁） |
| shell | 可用 `--allow-shell`（谨慎） | **禁止** `--allow-shell` |
| 权限模型 | 读放行；工作根内写免审批；外写要审批 | 同左，但工作根/黑名单按部署配置 |
| 存储 | 临时目录（重启即清） | `~/.dsh/dsh-im/`（映射/allowlist/审批日志持久化） |
| 日志 | debug 全开 | 只留 warn/error |

**设计原则：prod = demo 去掉所有"省事"开关。** 你在 demo 里验证过的每一个行为，prod 里原样存在，只是更严格。

## 怎么启动

```sh
# 🎛 演示（开发自用）
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
  node demo/feishu-real.mjs --mode demo
# 不想花 token：加 --mock-llm
# 想看详细日志：加 --debug

# 🏭 真实部署（必须先配 allowlist/admins，否则直接拒绝启动）
IM_ALLOWLIST="feishu:ou_xxx" IM_ADMINS="feishu:ou_xxx" \
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
  node demo/feishu-real.mjs --mode prod
```

## 环境变量一览

| 变量 | demo | prod | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | ✅ | ✅ | 飞书自建应用凭据 |
| `DEEPSEEK_API_KEY` | ✅ | ✅ | 真实模型 key（prod 必需） |
| `IM_ALLOWLIST` | 可选 | **必填** | 逗号分隔 `feishu:<open_id>`，可派活的用户 |
| `IM_ADMINS` | 可选 | **必填** | 逗号分隔 `feishu:<open_id>`，可审批/信任人的管理员 |
| `IM_POLICY_ROOTS` | ✅ | ✅ | 写操作免审批的根目录（逗号分隔；默认 `~/Downloads/im-workspace`） |
| `IM_POLICY_DENY` | ✅ | ✅ | 硬拒绝路径正则（逗号分隔，读写都不行） |
| `WORKSPACE_DIR` | ✅ | ✅ | 设置后退回"受限工作区"模式（只能操作该目录） |
| `IM_FEISHU_LOG_LEVEL` | 默认 debug | 默认 warn | SDK 日志级别 |

## 权限模型（两模式一致，只差"是否可配置"）

```
读文件（任意目录）          → 放行
写/编辑（工作根内）          → 放行
写/编辑（工作根外）          → 审批卡片（默认拒绝，超时可恢复）
deny 黑名单命中（读写）      → 硬拒绝，不给审批机会
```

> 工作根默认 `~/Downloads/im-workspace`，生产环境务必用 `IM_POLICY_ROOTS` 指到你的真实项目目录。

## 上线检查清单（prod 前必过）

- [ ] `IM_ALLOWLIST` / `IM_ADMINS` 已配置（拒绝启动即未配置）
- [ ] 确认用 `--mode prod`（而不是 `--mode demo`）；自动信任只在 demo 开启
- [ ] `IM_POLICY_ROOTS` 指到真实工作目录
- [ ] 确认没有 `--mock-llm` / `--allow-shell`
- [ ] 用真实飞书应用 + 真实模型跑通一次"派活 → 审批 → 结果"
- [ ] 审计：`~/.dsh/dsh-im/approvals.log` 正常记录
