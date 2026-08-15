# 安全策略（Security Policy）

dsh-im-bridge 是一个**远程执行**型项目：它把 DeepSeek Harness 的 agent 能力暴露到 IM，
允许远程派活、远程审批、操作真实文件。安全是本项目的红线。

## 支持范围

| 版本 | 支持 |
|---|---|
| main 分支 | ✅ 积极维护 |
| 已发布 tag（v0.1.0-rc.x） | ✅ 按需修复 |

## 报告漏洞

**不要公开 issue**（除非确认是纯文档/非安全类问题）。请通过以下方式报告：

- 私信项目维护者（GitHub 上找 maintainer）
- 或发送邮件（见仓库 About 页面）

请提供：

1. 影响面：能做什么？（读任意文件 / 远程执行 / 绕过审批 / 凭据泄露…）
2. 复现步骤（尽量最小化）
3. 影响版本
4. 建议的修复（如有）

我们承诺：确认后尽快修复，并会在 CHANGELOG 中标注安全修复。

## 本项目已知的安全模型（评审改动时对照）

| 威胁面 | 现有对策 |
|---|---|
| 陌生人派活/轰炸 | allowlist 默认空=全禁；demo/prod 模式隔离；prod 必须显式配置 allowlist/admins |
| 远程触发危险命令 | 审批门（工具内 resolved-path 策略 + 官方 approval seam）+ deny-by-default + 超时可恢复拒绝 |
| 读取敏感文件 | 文件工具内 `PathPolicy`：敏感路径（.ssh/.aws/.env/密钥…）读/写要审批，deny 黑名单硬拒绝 |
| 越权访问工作区外 | 受限模式（WORKSPACE_DIR）+ 开放模式的可配置 writeRoots |
| 密钥泄露 | 一律 `env:` 引用；日志脱敏；审批卡片参数脱敏 |
| 消息注入 | 纯文本渲染；平台原生组件只映射白名单内容 |
| 公网回调伪造 | 企微验签（sha1+Encrypt）；飞书长连接无公网面 |
| 审批回调身份伪造 | 按钮回调校验 allowlist 身份 |

## 维护者注意事项

- 任何改动不得把凭据写进代码/文档/日志（CI 里应有密钥扫描）
- 新增渠道适配器必须过 [`docs/adapters-guide.md`](docs/adapters-guide.md) 十条规则
- 涉及执行/文件/审批的改动，`demo/policy.js` 与审批流必须有对应测试
