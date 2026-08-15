# 企业微信联调指南（完整版）

> 目标：只看这一篇，把 dsh-im-wecom 从零跑通——在企业微信里指挥 DeepSeek Harness 的真实 agent。

## 先说企微的三大差异（和飞书不一样，别按飞书思维来）

| | 飞书 | 企业微信 |
|---|---|---|
| 收消息 | 长连接（免公网） | **必须回调 URL（公网 HTTPS）+ 消息加解密**，没有长连接/轮询 |
| 审批 | 卡片按钮 | **应用消息没有交互按钮**，审批走文本 `/approve <id> yes|no` |
| 机器人类型 | 企业自建应用 | 企业自建应用（需企业微信管理员） |

所以企微的前置比飞书多一步：**需要一个公网地址**（ngrok/cloudflared/caddy 内网穿透）。

---

## ① 创建自建应用（约 10 分钟，逐屏路径）

**前置**：打开 https://work.weixin.qq.com/wework_admin/frame ，用**企业微信 App 扫码**登录；
必须是该企业**管理员**（或让管理员在「管理工具 → 权限管理」给你「应用管理」权限）。

**找 CorpID（企业ID）**：
1. 页面**最左侧竖排菜单**点「**我的企业**」
2. 第一屏「**企业信息**」里找到「**企业ID**」→ 形如 `ww1234567890abcdef`，右边「复制」

**创建应用 + 拿 AgentId / Secret**：
1. 左侧菜单点「**应用管理**」
2. 页面上方「**自建**」分组 → 点「**创建应用**」
3. 填应用名称（如 `DSH Agent`）、Logo；**可见范围**选「部分成员」并勾选你自己 → 创建
4. 进入应用详情页，看上部「**基本信息**」：
   - 「**AgentId**」直接显示（如 `1000002`）→ 复制
   - 「**Secret**」显示星号 → 点「**查看**」→ 确认后显示完整值 → 复制

| 变量 | 在哪（精确路径） |
|---|---|
| `WECOM_CORP_ID` | 我的企业 → 企业信息 → 企业ID |
| `WECOM_AGENT_ID` | 应用管理 → 自建 → 点应用名 → 基本信息 → AgentId |
| `WECOM_SECRET` | 同上 → 基本信息 → Secret → 查看 |

## ② 配置「接收消息」（回调 URL + 加密，逐屏路径）

应用详情页 →「**接收消息**」→「**设置API接收**」：

1. 弹出表单：**URL / Token / EncodingAESKey**
2. Token 和 EncodingAESKey 点「**随机获取**」生成 → **复制保存**（= `WECOM_CALLBACK_TOKEN` / `WECOM_ENCODING_AES_KEY`）
3. URL 先留空 → 先做第 ③ 步拿隧道地址
4. 拿到地址后回填 `https://你的隧道域名/wecom` → 保存 → 企微自动验证（适配器解密 echostr 应答）→ 成功

> ⚠️ 提交前确认 Token/EncodingAESKey 与运行命令里的值**完全一致**；加解密方案选「安全模式」。

## ③ 公网穿透（企微硬性要求，免不了）

适配器在**本机 8787 端口**起了接收服务器，企微要能访问它，需要一个公网 HTTPS 地址。任选一个：

```sh
# 方式一：cloudflared（推荐，免费，无需注册即可临时隧道）
cloudflared tunnel --url http://localhost:8787
# 输出形如 https://xxx.trycloudflare.com → 回调 URL 填 https://xxx.trycloudflare.com/wecom

# 方式二：ngrok
ngrok http 8787
# → https://xxx.ngrok.io → 回调 URL 填 https://xxx.ngrok.io/wecom

# 方式三：caddy（有服务器时）
caddy reverse-proxy --from your.domain --to localhost:8787
```

> 临时隧道每次重启地址会变 → 填完 URL 后**不要关隧道进程**；
> 地址变了要重新回后台改 URL 并验证。

## ④ 收尾：把 URL 填进后台并验证

1. 回到「接收消息」设置：URL 填 `https://你的隧道域名/wecom`，Token / EncodingAESKey 填第 ② 步的
2. 保存 → 企微会发验证请求，适配器自动应答（成功会提示"验证成功"）
3. 若失败：检查隧道进程是否在跑、URL 路径是不是 `/wecom`、Token/EncodingAESKey 是否和运行器一致

---

## ⑤ 配置「企业可信 IP」（必做，否则回复消息报 60020 发不出去）

企微规定：自建应用调用 API **发消息**，服务器出口 IP 必须在白名单（收消息不需要，所以"能收到但回不了"是典型症状）。

**怎么知道自己的 IP（三种方式任选）**：
1. **启动 dsh web 后会自动打印**（推荐）：插件连接企微时会显示
   `⚠️ 你的出口 IP：x.x.x.x` —— 直接抄进后台即可
2. 浏览器打开 [ip.sb](https://ip.sb) 看当前公网 IP
3. 发消息失败时桥会解析报错里的 `from ip: x.x.x.x` 提示你

**配置路径**：企微管理后台 → 你的应用详情 →「**企业可信 IP**」→ 添加 → 填入上面的 IP → 保存。

> ⚠️ 家庭宽带是动态 IP，变了要回来更新白名单（重新启动桥会再打印一次当前 IP）。

## ⑥ 安装插件（一条命令）

**前提**：已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` 命令可用；`command not found` 先 `npm install -g @deepseek-ai/dsh`）。

```sh
dsh plugin --profile web add dsh-im dsh-im-wecom -w
```

> `-w` 是给 pnpm 的（profile 是 workspace 根，报 `ERR_PNPM_ADDING_TO_ROOT` 时带上）。

**配置环境变量**（启动 `dsh web` 前导出，5 个企微凭据 + DeepSeek key）：

```sh
export WECOM_CORP_ID=ww_xxx WECOM_AGENT_ID=1000002 WECOM_SECRET=xxx
export WECOM_CALLBACK_TOKEN=xxx WECOM_ENCODING_AES_KEY=43位key
export DEEPSEEK_API_KEY=sk-xxx
dsh web
```

启动后企微通道自动连接（回调服务监听本地端口，公网隧道需保持运行）；在手机企微里打开应用即可使用。

> 想不装进 DSH、克隆仓库直接跑联调脚本？见文末「附：不装进 DSH 的联调方式」。

## ⑦ 在企微里使用

手机端企微 →「**工作台**」→ 找到你的应用 → 打开聊天：

| 你发 | 结果 |
|---|---|
| `/new` | 创建会话 |
| 直接派活（如 `列出 /Users/zhouliqiang/Downloads 的内容`） | agent 执行，结果回发 |
| 危险操作/工作根外写入 | 收到审批文本卡片，**回复 `/approve <id> yes|no`**（企微无按钮） |
| `/status` `/log` `/mute` | 状态 / 完整输出 / 通知开关 |

## ⑧ 排查

| 现象 | 原因 |
|---|---|
| 后台 URL 验证失败 | 隧道没跑 / 路径不是 `/wecom` / Token 或 EncodingAESKey 不一致 |
| 能发消息但 bot 不回 | 回调 URL 失效（隧道重启地址变了）；或没 `--mock-llm` 且没配 DEEPSEEK_API_KEY |
| 终端显示"尚无事件" | 后台没把消息推过来：检查接收消息配置、可见范围是否包含你 |
| 审批没有按钮 | 正常——企微应用消息无按钮，用 `/approve <id> yes\|no` |
| 发消息报错 errcode | 看终端错误码：**60020**（IP 不在白名单 → 按第 ⑤ 步加「企业可信 IP」，桥会打印当前 IP）/ 60111（secret 错）/ 301002（可见范围） |



---

## 附：不装进 DSH 的联调方式（开发者）

需要克隆本仓库 + Node.js 22+：

```sh
npm install
WECOM_CORP_ID=ww_xxx WECOM_AGENT_ID=1000002 WECOM_SECRET=xxx \
WECOM_CALLBACK_TOKEN=xxx WECOM_ENCODING_AES_KEY=43位key \
DEEPSEEK_API_KEY=sk-xxx node demo/wecom-real.mjs --mode demo
```

`--mode demo`：首条消息自动信任；`--mode prod`：严格 allowlist。
