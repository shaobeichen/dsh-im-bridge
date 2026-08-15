# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **飞书群聊 @ 过滤（真实飞书联调需求）**：`groupMentionOnly`（默认 true）——群聊中只有手动
  @ 机器人的消息才派发，其他消息不响应（私聊不受影响）。判定经机器人身份查询
  （`bot/v3/info`，懒加载 + 内存缓存 + 失败可重试）；身份查询失败时群聊消息失败关闭
  （宁可漏回不刷屏）。@ 占位符清洗：机器人自身移除、他人替换为「@昵称」（纯函数 + 单测）
- **流式消息原地更新（打字机体验，对照成熟 Claude Code↔IM 桥）**：核心新增
  `notifications.streamEdit`（默认开）——渠道实现 `edit()` 且 `send()` 返回真实 messageId 时，
  流式增量首帧发送、后续帧原地编辑同一条消息；`edit()` 失败或渠道不支持时自动回退逐条新消息，
  绝不丢内容。出站消息模型新增 `title`（卡片标题）与 `stream`（流式帧）字段
- **飞书流式卡片**：适配器实现 `edit()`（`im.message.patch` 原地更新 interactive 卡片，
  飞书不支持 patch 文本消息）；流式帧渲染为 lark_md 卡片（2800 字符兜底截断 + 实时提示脚注）
- **出站业务失败即抛出**：飞书 `send/edit/sendCard` 对 `code != 0` 一律 throw 并带平台
  错误码（`err.code`/`err.msg`），不再静默吞掉（AGENTS.md 可观测三件套）
- **网页扫码接入（设置 → 插件 → 飞书 / 微信 页签）**：二维码直接在 DeepSeek Harness 网页里显示，
  手机扫码确认（微信含配对数字输入框）→ 凭据写入 Host 本机 → 重启生效。全程不碰终端；
  loopback RPC（`ctx.connection.rpc`）+ 官方 SDK 流程，App Secret / bot_token 不进浏览器
- **微信渠道 `dsh-im-weixin`**：腾讯 iLink 个人微信机器人（官方协议，源自腾讯开源 MIT 项目 openclaw-weixin），
  `getupdates` 长轮询免公网；`npx -y dsh-im-weixin-qr` 扫码绑定（含配对数字流程），
  凭据自动写入 `$DSH_HOME/dsh-im/weixin-credentials.json`；无原生按钮，审批降级文本（18/18 测试）
- **飞书扫码接入**：`npx -y dsh-im-feishu-qr` 扫码一键创建应用（官方 `registerApp`，
  权限/事件/回调预填），凭据自动写入 `$DSH_HOME/dsh-im/feishu-credentials.json`；
  `resolveSecret` 在 env 为空时自动回退扫码文件（env 仍优先）

### 修复

- **Windows 兼容**（此前 3 个用例在 Windows 失败）：
  - `demo/policy.test.js`：POSIX 路径字面量 → node:path 平台无关期望值
  - 凭据落盘 0600 断言（feishu/weixin 扫码测试）：POSIX 强制，Windows 跳过（chmod 权限位不生效）
  - `demo/mock-demo.mjs` / `demo/workspace-tools.mjs`：硬编码 `/bin/bash` → 新增跨平台
    `demo/shell.mjs`（Windows 优先 pwsh，缺失回退 powershell.exe），真实模式在 Windows 可跑
- **通知蓄水池上限**：`MAX_RESERVOIR` 此前定义未用——超长离线输出会无限占用内存；
  现在超限保留最新尾部，完整输出走 `/log`
- **流式离线判定 flake**：`isOnline` 毫秒边界（touch 与 appendStream 同毫秒被判在线）导致
  测试偶发；测试改为确定性离线，并消除其连带时序抖动
- **`connection` 硬依赖致插件永不激活（真实飞书联调发现）**：飞书/微信适配器曾把
  `connection` 写进 `inject`——demo 运行器的裸 Context 没有该服务时插件永远 waiting、
  apply 不执行、进程空转退出；而 web 设置页签本就优雅降级。改为可选依赖（web-rpc 用
  `ctx.get('connection')` 读取，本 Cordis 变体对未注入属性访问直接抛错），并补两个
  激活回归测试（真实 Cordis Context 无 connection 挂载插件）
- **文档**：install.md 补充 Windows 缺 pnpm 的安装前置说明
- **安全门体验**：管理员（`security.admins`）隐式放行，不再要求重复写 `allowlist`——普通用户零配置，首接触由管理员一键 `/trust` 确认（FR-8.2/9.2）；全空配置时启动给出双语引导提示（`im.security.admins: ["平台:userId"]`），未授权回复附上同样的可抄配置

### 工程

- **CI 双平台矩阵**：`ubuntu-latest` + `windows-latest`（node 22），防止 Windows 兼容回归
- 新增 `demo/shell.test.js`（跨平台 shell 执行器单测）；notify 测试新增 edit 路径/失败回退/
  蓄水池上限 3 例；飞书测试新增流式卡片/patch/业务失败/超长截断 4 例（全套 120 例全绿）
- 仓库根变成可安装 bundle（根 `cordis.patch.yml` 注册 4 个插件 + 根依赖指向 npm 发布包）：`dsh plugin add github:shaobeichen/dsh-im-bridge` 一键装齐核心+三渠道（awesome-dsh-plugin / dshmarket 收录路径打通）
- 版本号与 npm 对齐（4 包 + 根包 1.0.2，渠道 peer `^1.0.2`）；发布 workflow 现在会在 Release 后**把版本同步自动提交回仓库**（零本地命令，仓库 package.json 永远与 npm 一致）

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
