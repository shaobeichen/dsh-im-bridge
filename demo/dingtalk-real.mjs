// dsh-im-bridge × 钉钉 运行器（薄壳：核心逻辑在 demo/bridge-core.mjs）
//
//   # 演示模式（开发自用，首条消息自动信任）
//   DINGTALK_CLIENT_ID=dingxxx DINGTALK_CLIENT_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
//     node demo/dingtalk-real.mjs --mode demo
//     （可选 --mock-llm 不花 token；--debug 看详细日志）
//
//   # 真实部署（必须先配 IM_ALLOWLIST/IM_ADMINS，否则拒绝启动）
//   IM_ALLOWLIST="dingtalk:10001" IM_ADMINS="dingtalk:10001" \
//   DINGTALK_CLIENT_ID=dingxxx DINGTALK_CLIENT_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
//     node demo/dingtalk-real.mjs --mode prod
//
// 环境变量：DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_ROBOT_CODE（可选）/
//   DEEPSEEK_API_KEY
// 其余（IM_ALLOWLIST/ADMINS/ROOTS/DENY/WORKSPACE_DIR）由 bridge-core 统一读取。
//
// 钉钉特点：Stream 模式 WebSocket 长连接，**免公网**（无需回调 URL / 内网穿透）。
// ⚠️ 若收不到消息，先查适配器的 CALLBACK 订阅（见 packages/im-dingtalk/README.md）。

const { default: ImDingtalk } = await import('../packages/im-dingtalk/lib/index.js');
const { bootBridge } = await import('./bridge-core.mjs');

const argv = process.argv;
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'demo';
const MOCK_LLM = argv.includes('--mock-llm');
const DEBUG = argv.includes('--debug');

if (MODE !== 'demo' && MODE !== 'prod') {
  console.error(`Unknown mode ${MODE} (demo | prod) | 未知模式 ${MODE}（支持 demo | prod）`);
  process.exit(1);
}
if (!process.env.DINGTALK_CLIENT_ID || !process.env.DINGTALK_CLIENT_SECRET) {
  console.error(
    'DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET are required (create an Enterprise Internal App on the DingTalk Open Platform) | 需要 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET（钉钉开放平台创建「企业内部应用」获取）。\n' +
      '⚠️ Client Secret 区分大小写，首字母小写时不要写成大写（否则 gettoken 报 40096）。',
  );
  process.exit(1);
}
if (!MOCK_LLM && !process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is required (or use --mock-llm in demo mode) | 需要 DEEPSEEK_API_KEY（或用 --mock-llm 走脚本化模型，仅 demo 模式）。');
  process.exit(1);
}

console.log(`\n===== dsh-im-bridge × 钉钉  模式：${MODE === 'demo' ? '🎛 演示（开发自用）' : '🏭 真实部署（严格安全）'} =====`);
if (MODE === 'demo') {
  console.log('  演示模式特性：首条消息自动信任、工作根写免审批、debug 日志、可用 --mock-llm');
} else {
  console.log(`  生产模式特性：allowlist=${(process.env.IM_ALLOWLIST ?? '').split(',').filter(Boolean).length}人 / admins=${(process.env.IM_ADMINS ?? '').split(',').filter(Boolean).length}人、首接触走管理员确认、持久化存储`);
}
console.log('  通道特性：Stream 模式（WebSocket 长连接，免公网）');

let core;
try {
  core = await bootBridge({ mode: MODE, mockLLM: MOCK_LLM });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const { ctx, im } = core;

const dtHandle = ctx.plugin(ImDingtalk, {
  clientId: 'env:DINGTALK_CLIENT_ID',
  clientSecret: 'env:DINGTALK_CLIENT_SECRET',
  ...(process.env.DINGTALK_ROBOT_CODE ? { robotCode: 'env:DINGTALK_ROBOT_CODE' } : {}),
  debug: DEBUG,
});
await dtHandle.await();

console.log('\n' + '='.repeat(60));
console.log('  钉钉通道已注册（Stream 模式，免公网）。');
console.log('  1) 打开钉钉 → 找到你的机器人应用 → 私聊它');
console.log('  2) 发 /new 创建会话，然后直接派活');
if (MODE === 'prod') {
  console.log('  3) 新用户首次接触 → 管理员收到信任确认，/trust dingtalk:<userId> 授权');
} else {
  console.log('  3) （演示模式：首条消息自动信任）');
}
console.log('  4) 危险操作弹审批卡片；按钮不可用时用 /approve <id> yes|no');
console.log('  5) /status /log /mute 可用');
console.log('  Ctrl+C 退出。');
console.log('='.repeat(60));

// 状态心跳：连接活着 ≠ 事件在流，所以额外显示 lastEventAt
let lastStatus = '';
const tick = setInterval(() => {
  const ch = im.channels.get('dingtalk');
  if (!ch?.status) return;
  const st = ch.status;
  const ago = st.lastEventAt ? `${Math.round((Date.now() - st.lastEventAt) / 1000)}s 前有事件` : '尚未收到事件';
  const line = `📡 钉钉连接: ${st.connected ? '✅ ' + (st.detail ?? 'stream') : '❌ ' + (st.detail ?? '')}｜${ago}`;
  if (line !== lastStatus) {
    lastStatus = line;
    console.log(line);
  }
}, 2000);
tick.unref?.();

process.on('SIGINT', async () => {
  clearInterval(tick);
  try { await dtHandle.dispose(); } catch { /* 忽略 */ }
  await core.dispose();
  process.exit(0);
});

await new Promise(() => {});