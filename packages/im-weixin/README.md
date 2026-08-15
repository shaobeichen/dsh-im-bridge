# dsh-im-weixin（微信适配器）

> 腾讯 **iLink 个人微信机器人**（官方协议，协议格式源自腾讯开源 MIT 项目
> [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)）。
> `getupdates` 长轮询，**免公网**（不需要隧道/回调 URL）。

## 平台四件事

| # | 事项 | 说明 |
|---|---|---|
| 1 | 凭证 | 扫码绑定（`npx -y dsh-im-weixin-qr`）拿到 `bot_token`，写入 `$DSH_HOME/dsh-im/weixin-credentials.json`；或设 `WECHAT_BOT_TOKEN` 环境变量 |
| 2 | 权限/入口 | **手机微信账号必须已获得「微信机器人」功能**（我 → 设置 → 插件）。腾讯分批开放，插件无法绕过；账号无入口时扫码/连接会失败 |
| 3 | 订阅方式 | `ilink/bot/getupdates` 长轮询（免公网） |
| 4 | 发布生效 | 无（扫码即生效） |

## 实现状态

- [x] 官方协议薄封装（`lib/weixin-api.js`，fetch 可注入；URL 受信白名单防令牌外泄）
- [x] `extractWeixinText` 纯函数 + 单测（文本 / 语音转写）
- [x] 出站文本自动切分（4000 字/条）；微信无原生按钮，审批由核心降级为文本
- [x] 可观测三件套：连接状态 / `lastEventAt` 心跳 / 边界日志（带平台错误码）
- [x] 扫码绑定 CLI（`bin/weixin-qr.mjs`，配对数字流程）
- [x] 契约测试 + 假 iLink 服务器测试（18/18）

## 安装与绑定

```sh
dsh plugin --profile web add dsh-im dsh-im-weixin -w   # 装插件
npx -y dsh-im-weixin-qr                                 # 扫码绑定（一次性）
npx @deepseek-ai/dsh web                                # 重启，在微信里发消息
```

详见仓库 [`docs/weixin-setup.md`](../../docs/weixin-setup.md)。

## 协议来源与许可

iLink 请求格式基于腾讯官方 MIT 项目 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
2.4.6 适配，本包用原生 fetch 重新实现（未引入 OpenClaw 运行时）。本包自身 MIT License。
