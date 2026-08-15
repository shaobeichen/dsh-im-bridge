// dsh-im-bridge × Telegram 运行器（薄壳：核心逻辑在 demo/bridge-core.mjs）
//
//   # 准备：找 @BotFather 创建 bot，拿到 token
//   TELEGRAM_BOT_TOKEN=123456:ABC... DEEPSEEK_API_KEY=sk-xxx \
//     node demo/telegram-real.mjs --mode demo
//
//   # 真实部署（必须先配 IM_ALLOWLIST/IM_ADMINS，否则拒绝启动）
//   IM_ALLOWLIST="telegram:123456789" IM_ADMINS="telegram:123456789" \
//   TELEGRAM_BOT_TOKEN=... DEEPSEEK_API_KEY=sk-xxx \
//     node demo/telegram-real.mjs --mode prod

const { default: ImTelegram } = await import('../packages/im-telegram/lib/index.js');
const { bootBridge } = await import('./bridge-core.mjs');

const argv = process.argv;
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'demo';
const MOCK_LLM = argv.includes('--mock-llm');
const DEBUG = argv.includes('--debug');

if (MODE !== 'demo' && MODE !== 'prod') {
  console.error(`Unknown mode ${MODE} (demo | prod) | 未知模式 ${MODE}（支持 demo | prod）`);
  process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required (create a bot via @BotFather) | 需要 TELEGRAM_BOT_TOKEN（找 @BotFather 创建 bot 获取）。');
  process.exit(1);
}
if (!MOCK_LLM && !process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is required (or use --mock-llm in demo mode) | 需要 DEEPSEEK_API_KEY（或用 --mock-llm 走脚本化模型，仅 demo 模式）。');
  process.exit(1);
}

console.log(`\n===== dsh-im-bridge × Telegram  模式：${MODE === 'demo' ? '🎛 演示' : '🏭 真实部署'} =====`);

let core;
try {
  core = await bootBridge({ mode: MODE, mockLLM: MOCK_LLM });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const { ctx, im } = core;

const tgHandle = ctx.plugin(ImTelegram, {
  token: 'env:TELEGRAM_BOT_TOKEN',
  mode: 'polling',
});
await tgHandle.await();

console.log('\n' + '='.repeat(60));
console.log('  Telegram 通道已注册（polling 免公网）。');
console.log('  1) 在 Telegram 里搜索你的 bot 用户名，私聊它');
console.log('  2) 发 /new 创建会话，然后直接派活');
console.log('  3) 危险操作弹审批卡片，点按钮放行/拒绝');
console.log('  4) /status /log 可用');
console.log('  Ctrl+C 退出。');
console.log('='.repeat(60));

let lastStatus = '';
const tick = setInterval(() => {
  const ch = im.channels.get('telegram');
  if (ch?.status) {
    const st = ch.status;
    const line = `📡 Telegram 连接: ${st.connected ? '✅ ' + (st.detail ?? 'polling') : '❌ ' + (st.detail ?? '')}`;
    if (line !== lastStatus) {
      lastStatus = line;
      console.log(line);
    }
  }
}, 2000);
tick.unref?.();

process.on('SIGINT', async () => {
  clearInterval(tick);
  try { await tgHandle.dispose(); } catch { /* 忽略 */ }
  await core.dispose();
  process.exit(0);
});

await new Promise(() => {});
