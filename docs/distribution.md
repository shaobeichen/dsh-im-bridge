# 分发四连（PRD Phase 3 · 发布与测量）

目标：让 `dsh-im-bridge` 进入 DSH 插件的官方分发入口。按顺序执行，**前一步是后一步的前提**。

```
① GitHub topics（打 tag）→ ② 发布 npm → ③ awesome-dsh-plugin PR → ④ dsh-market（自动收录）
```

> 关键链路：dsh-market 的数据源就是 awesome-dsh-plugin 的 `plugins.json`，
> 所以 **③ 进了 awesome 列表 = 自动进 dsh-market**，不需要单独提交。
> awesome 列表要求：仓库声明 `dsh.bundle`（✅ 仓库根已补：根 `cordis.patch.yml` 注册 4 个插件，根依赖指向 npm 发布包）+ `dsh-plugin` topic（① 做）+ 真实代码 + 活跃维护。
> 一键安装：`dsh plugin --profile web add github:shaobeichen/dsh-im-bridge` 即装齐 4 个插件。

---

## ① GitHub Topics（2 分钟，网页操作）

仓库主页 → **Settings** → **General** → 拉到最下 **Topics** → 添加：

```
dsh-plugin  deepseek-harness  im-bridge  feishu  lark  wecom  telegram  ai-agent  deepseek
```

保存。`dsh-plugin` 是必须的（awesome 列表硬性要求），其余是曝光。

## ② 发布 npm（GitHub 打 Release 即自动发布，零本地命令）

仓库已带 `.github/workflows/npm-publish.yml`：**在 GitHub 手动创建一个 Release，workflow 就会自动：测试 → 把 tag 版本同步进 4 个包 + 根包的 package.json → 按顺序发布到 npm → 把版本同步提交回仓库（零本地命令，仓库 package.json 永远与 npm 已发布版本一致）**。

**一次性配置（10 分钟，只需一次）**：

1. 注册 npm 账号：https://www.npmjs.com/signup
2. 生成发布 token：npmjs.com → 头像 → **Access Tokens** → Generate New Token → 类型选 **Automation** → 复制
3. 存进仓库 Secret：GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret** → 名字 **`NPM_TOKEN`**，值粘贴 token

**以后每次发布（全程网页操作，不用碰终端）**：

1. GitHub 仓库 → **Releases** → **Draft a new release**
2. **Choose a tag** → 新建一个版本号 tag（必须是语义化版本，如 `v0.1.0` / `v1.2.3`）
3. 写标题和说明 → **Publish release**
4. 到 **Actions** 页看进度；完成后在 npm 搜索 `dsh-im` 即可看到

**说明**：

- tag 里的版本号会自动写进 4 个包的 package.json 和根包（`v0.1.0` → `0.1.0`），发布成功后自动提交回仓库，不用手动改
- 发布顺序固定：先 `dsh-im` 核心，再三个渠道
- 某包已发布过同版本时会自动跳过（重跑安全）
- 正式版本号（如 `0.1.0`）默认就是 npm 的 latest，`dsh plugin add dsh-im` 直接能装
- 安装命令（发布后生效）：`dsh plugin --profile web add dsh-im dsh-im-feishu`（或 `dsh-im-wecom` / `dsh-im-telegram`）

已检查：4 个包名 npm 全部可用 ✅；发布元数据（license/repository/keywords/dsh.bundle/publishConfig）✅；tarball 含 `cordis.patch.yml` ✅。

## ③ awesome-dsh-plugin PR（分类：Notifications & Integrations / 通知与集成）

给 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 开一个 PR，**两个文件各加一行**：

**README.md（英文）**，加在 `### Notifications & Integrations` 分类下：

```markdown
- [shaobeichen/dsh-im-bridge](https://github.com/shaobeichen/dsh-im-bridge) - IM bridge for DeepSeek Harness: dispatch tasks, receive result notifications, and approve risky operations from Feishu, WeCom, and Telegram.
```

**README.zh.md（中文）**，加在「通知与集成」分类下：

```markdown
- [shaobeichen/dsh-im-bridge](https://github.com/shaobeichen/dsh-im-bridge) — 让 DeepSeek Harness 通过飞书、企业微信、Telegram 远程派活、接收结果通知、审批危险操作。
```

要求自查（都已满足或随 PR 说明）：

- [x] 声明 `dsh.bundle`（package.json 已加，4 个包都有）
- [x] `dsh-plugin` topic（① 做）
- [x] 真实可用代码 + 78 测试
- [x] 描述只说功能、无营销词
- [x] 发布 npm（② 做，推荐项：预构建安装免 allowBuilds 授权）

PR 标题建议：`add: shaobeichen/dsh-im-bridge (IM bridge, Feishu/WeCom/Telegram)`

## ④ dsh-market（自动，无需操作）

③ 合并后，站点自动重建，`awesome-dsh-plugin.com/plugins.json` 会带上我们，
dsh-market 里即可一键安装。检查：`curl https://awesome-dsh-plugin.com/plugins.json | grep dsh-im-bridge`

---

## 发布后测量（PRD §13 / F.4 决策门）

| 指标 | 目标 | 不达标处理 |
|---|---|---|
| 安装量（npm 下载） | 3 个月 >200 | — |
| 首启转化（装完→首次派活 ≤3 步） | 引导清单完成率高 | 回炉上手流程 |
| 审批保持开启率 | ≥60% | 防审批疲劳设计失效，回炉 |
| 自发好评 / PR | 有 | 方向验证 |

> 记住 PRD F.5 的诚实结论：需求存在可以证明，但"被喜爱"只能发布后测量。
> 先发最小版本，用数据决定继续、回炉还是砍掉。
