# 分发四连（PRD Phase 3 · 发布与测量）

目标：让 `dsh-im-bridge` 进入 DSH 插件的官方分发入口。按顺序执行，**前一步是后一步的前提**。

```
① GitHub topics（打 tag）→ ② 发布 npm → ③ awesome-dsh-plugin PR → ④ dsh-market（自动收录）
```

> 关键链路：dsh-market 的数据源就是 awesome-dsh-plugin 的 `plugins.json`，
> 所以 **③ 进了 awesome 列表 = 自动进 dsh-market**，不需要单独提交。
> awesome 列表要求：仓库声明 `dsh.bundle`（✅ 已补）+ `dsh-plugin` topic（① 做）+ 真实代码 + 活跃维护。

---

## ① GitHub Topics（2 分钟，网页操作）

仓库主页 → **Settings** → **General** → 拉到最下 **Topics** → 添加：

```
dsh-plugin  deepseek-harness  im-bridge  feishu  lark  wecom  telegram  ai-agent  deepseek
```

保存。`dsh-plugin` 是必须的（awesome 列表硬性要求），其余是曝光。

## ② 发布 npm（先核心后适配器）

前置：注册 npm 账号，终端执行一次 `npm login`。

```sh
# 顺序很重要：先 dsh-im（适配器 peerDepend 它），再渠道
npm publish --workspace dsh-im
npm publish --workspace dsh-im-telegram
npm publish --workspace dsh-im-feishu
npm publish --workspace dsh-im-wecom
```

已检查：4 个包名在 npm 全部可用 ✅；元数据（license/repository/keywords/dsh.bundle）已补齐 ✅。
版本号都是 `0.1.0-rc.1`，建议保持同步发布（PRD §11：单版本同步发布）。

发布后安装命令就变成：

```sh
dsh plugin --profile web add dsh-im dsh-im-feishu   # 或 dsh-im-wecom / dsh-im-telegram
```

> 小坑：发 rc 版本 `npm publish` 默认带 `--tag next`，正式 `dsh plugin add` 默认装 latest。
> 想让它出现在默认安装里，发 `0.1.0` 正式版，或 `npm dist-tag add dsh-im@0.1.0-rc.1 latest`。

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
