# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **微信渠道 `dsh-im-weixin`**：腾讯 iLink 个人微信机器人（官方协议，源自腾讯开源 MIT 项目 openclaw-weixin），
  `getupdates` 长轮询免公网；`npx -y dsh-im-weixin-qr` 扫码绑定（含配对数字流程），
  凭据自动写入 `$DSH_HOME/dsh-im/weixin-credentials.json`；无原生按钮，审批降级文本（18/18 测试）
- **飞书扫码接入**：`npx -y dsh-im-feishu-qr` 扫码一键创建应用（官方 `registerApp`，
  权限/事件/回调预填），凭据自动写入 `$DSH_HOME/dsh-im/feishu-credentials.json`；
  `resolveSecret` 在 env 为空时自动回退扫码文件（env 仍优先）

### 工程

- 仓库根变成可安装 bundle（根 `cordis.patch.yml` 注册 4 个插件 + 根依赖指向 npm 发布包）：`dsh plugin add github:shaobeichen/dsh-im-bridge` 一键装齐核心+三渠道（awesome-dsh-plugin / dshmarket 收录路径打通）
- 版本号与 npm 对齐（4 包 + 根包 1.0.2，渠道 peer `^1.0.2`）；发布 workflow 现在会在 Release 后**把版本同步自动提交回仓库**（零本地命令，仓库 package.json 永远与 npm 一致）

### 修复

- **安全门体验**：管理员（`security.admins`）隐式放行，不再要求重复写 `allowlist`——普通用户零配置，首接触由管理员一键 `/trust` 确认（FR-8.2/9.2）；全空配置时启动给出双语引导提示（`im.security.admins: ["平台:userId"]`），未授权回复附上同样的可抄配置

### 已实现（v0.1.0-rc 候选）

**核心 `dsh-im`**（对应 PRD §12 MVP）
- `ctx.im` 服务：渠道注册、统一消息模型 `ImMessage`、事件 `im/*`（FR-1）
- 会话映射 + `mappings.json` 原子持久化 + 重启懒恢复（FR-2 / UC6）
- 命令集：`/start /new /status /log /help /mute /unmute /approve /trust /revoke`，权限分层（FR-4）
- 通知总线：turn/end 结果卡片（耗时+token）、聚合、静默时段、在线/离线分流、失败重试（FR-5）
- 审批流：风险规则门 + 官方 `approval/request` answerer + 按钮/文本降级 + 超时可恢复拒绝 + 首个响应者生效 + `approvals.log`（FR-6）
- 首次信任确认（FR-9.2）、MockChannel（NFR-7）
- 渠道契约检查器 `validateAdapterContract`（FR-9.4 不兼容即报错）

**渠道适配器**
- Telegram：Bot API polling 长连接 + 内联按钮审批卡片 + 文件交付（假 API 全量测试）
- 飞书：官方 SDK 长连接 + 交互卡片审批 + 文件交付（**已真实联调跑通**）
- 企业微信：回调 URL + 消息加解密（官方 @wecom/crypto）+ 应用消息 + 文本审批降级（**已真实联调跑通**）

**工程与安全**
- `--mode demo|prod` 双模式隔离（prod：强制 allowlist、禁 mock-llm/裸 shell、持久化存储）
- 权限模型 `PathPolicy`：读放行 / 工作根写免审批 / 外部写审批 / deny 黑名单（resolved-path 判定，防路径技巧绕过）
- 可观测三件套：连接状态 + 最近事件心跳 + 边界日志（带平台错误码）
- 适配器开发指南 + 脚手架 `scripts/new-adapter.mjs` + AGENTS.md（AI 贡献者自动加载）
- 78+ 测试全绿（无网络/无真实凭据）

## [0.0.1] - 2026-08

- 项目启动：按 `docs/PRD-v0.5.md` 实现 MVP（核心 + Telegram + MockChannel）
- 飞书真实联调跑通（长连接、事件订阅、权限、卡片回调）
- 企业微信真实联调跑通（公网隧道、消息加解密、可信 IP）
- demo/prod 模式、权限策略、demo 运行器、中文/英文双语文档
