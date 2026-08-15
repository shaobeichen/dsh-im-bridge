// dsh-im-bridge × 企业微信 运行器
//
// 前置（企微与飞书差异很大，务必先读 docs/wecom-setup.md）：
//   1. 企业微信管理后台创建自建应用：corpid / agentid / secret
//   2. 应用「接收消息」配置回调 URL + Token + EncodingAESKey —— 需要公网 HTTPS，
//      用 ngrok / cloudflared / caddy 把公网 URL 指到本地端口（默认 8787）
//   3. 导出凭据运行：
//
//      WECOM_CORP_ID=ww_xxx WECOM_AGENT_ID=1000002 WECOM_SECRET=xxx \
//      WECOM_CALLBACK_TOKEN=xxx WECOM_ENCODING_AES_KEY=xxx \
//      DEEPSEEK_API_KEY=sk-xxx \
//      node demo/wecom-real.mjs --mode demo
//
//      （回调 URL 填 https://你的隧道域名/wecom）
//
// ⚠️ 企微应用消息没有交互按钮：审批走文本降级 —— 卡片文本里会提示
//    「回复 /approve <id> yes|no」。

import { homedir } from 'node:os';

const { default: ImWecom } = await import('../packages/im-wecom/lib/index.js');
const { bootBridge } = await import('./bridge-core.mjs');

const argv = process.argv;
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'demo';
const MOCK_LLM = argv.includes('--mock-llm');
const DEBUG = argv.includes('--debug') || process.env.IM_WECOM_DEBUG === '1';

const missing = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET', 'WECOM_CALLBACK_TOKEN', 'WECOM_ENCODING_AES_KEY']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')} (see docs/wecom-setup.md) | 需要环境变量：${missing.join(', ')}（详见 docs/wecom-setup.md）`);
  process.exit(1);
}
if (!MOCK_LLM && !process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is required (or use --mock-llm in demo mode) | 需要 DEEPSEEK_API_KEY（或用 --mock-llm 走脚本化模型，仅 demo 模式）。');
  process.exit(1);
}

console.log(`\n===== dsh-im-bridge × 企业微信  模式：${MODE === 'demo' ? '🎛 演示' : '🏭 真实部署'} =====`);

let core;
try {
  core = await bootBridge({ mode: MODE, mockLLM: MOCK_LLM });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const { ctx, im } = core;

const port = Number(process.env.WECOM_PORT ?? 8787);
const wecomHandle = ctx.plugin(ImWecom, {
  corpid: 'env:WECOM_CORP_ID',
  agentId: 'env:WECOM_AGENT_ID',
  secret: 'env:WECOM_SECRET',
  callbackToken: 'env:WECOM_CALLBACK_TOKEN',
  encodingAESKey: 'env:WECOM_ENCODING_AES_KEY',
  port,
  debug: DEBUG,
});
await wecomHandle.await();

console.log('\n' + '='.repeat(60));
console.log('  企业微信通道已注册。');
console.log('  1) 企微管理后台 → 应用 → 接收消息 → 设置 API 接收 URL：');
console.log(`     https://你的隧道域名/wecom  （指向本机 :${port}，需 ngrok/cloudflared/caddy）`);
console.log('  2) 在企微里给应用发消息（手机端「工作台 → 你的应用」）：');
console.log('     /new 创建会话 → 直接派活 → 结果回发');
console.log('  3) ⚠️ 企微无按钮：审批请回复 /approve <id> yes|no');
console.log('  Ctrl+C 退出。');
console.log('='.repeat(60));

let lastStatus = '';
const tick = setInterval(() => {
  const ch = im.channels.get('wecom');
  if (ch?.status) {
    const st = ch.status;
    const ev = st.lastEventAt ? ` · 最近事件 ${Math.round((Date.now() - st.lastEventAt) / 1000)}s 前` : ' · ⚠️ 尚无事件（检查回调 URL/签名/公网穿透）';
    const line = `📡 企微连接: ${st.connected ? '✅ ' + st.detail : '❌ ' + st.detail}${ev}`;
    if (line !== lastStatus) {
      lastStatus = line;
      console.log(line);
    }
  }
}, 2000);
tick.unref?.();

process.on('SIGINT', async () => {
  clearInterval(tick);
  try { await wecomHandle.dispose(); } catch { /* 忽略 */ }
  await core.dispose();
  process.exit(0);
});

await new Promise(() => {});
