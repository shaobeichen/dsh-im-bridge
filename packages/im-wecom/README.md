# dsh-im-wecom（企业微信适配器）

企业微信渠道适配器：**回调 URL + 消息加解密**（官方 `@wecom/crypto`）+ 应用消息收发 + 文件交付。

> ✅ 实现完成（本地 HTTP 服务器 + 官方加解密全链路测试 11/11）。
> ⚠️ 企微无长连接/轮询——必须公网回调 URL（ngrok/cloudflared/caddy 穿透到本地 8787 端口），
> 且应用消息**没有交互按钮**——审批走文本降级 `/approve <id> yes|no`。
> 完整配置步骤见 [`docs/wecom-setup.md`](../../docs/wecom-setup.md)。

- 依赖：`inject: ['im']`（需 `dsh-im` 核心）；`@wecom/crypto`（官方加解密）
- 密钥（全部 `env:` 引用）：
  - `WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET`
  - `WECOM_CALLBACK_TOKEN` / `WECOM_ENCODING_AES_KEY`
- 运行器：`node demo/wecom-real.mjs --mode demo`
- 测试：`node --test "packages/im-wecom/test/*.test.js"`（契约 + 加解密 + HTTP 回调 + 出站）

## 平台四件事（对照 docs/wecom-setup.md）

| # | 事项 | 企微情况 |
|---|---|---|
| 1 | 凭证 | 管理后台自建应用：CorpID / AgentId / Secret |
| 2 | 权限/作用域 | 应用天然有收发消息能力；需配「企业可信IP」否则报 60020 |
| 3 | 订阅方式 | **仅回调 URL（公网 HTTPS）+ 消息加解密**；无长连接 |
| 4 | 发布生效 | 应用可见范围包含用户即可；改回调 URL 立即生效 |

## 实现说明

- **接收**：本地 HTTP 服务器 `/wecom`；GET=URL 验证（解密 echostr），POST=消息回调
  （验签 sha1(sort(token,ts,nonce,Encrypt)) + AES-CBC 解密 XML → ImMessage）；5 秒内响应 success
- **验签**：GET 用 echostr、POST 用 body 的 Encrypt 值参与签名（企微规则，易踩坑）
- **发送**：`/cgi-bin/message/send` 应用消息（touser=userid）；access_token 缓存 2h
- **文件**（`/log` 全量交付）：`/cgi-bin/media/upload` → file 消息
- **审批降级**（FR-6.2）：企微应用消息无按钮，`send()` 遇到 buttons 时在文本里附上
  带真实审批 id 的 `/approve <id> yes|no` 提示
- **可观测三件套**：status.connected + lastEventAt 心跳 + 出站错误带 errcode/errmsg
