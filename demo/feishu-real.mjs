// dsh-im-bridge × 飞书 运行器（薄壳：只负责飞书渠道，核心逻辑在 demo/bridge-core.mjs）
//
//   # 演示模式（开发自用，首条消息自动信任）
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
//     node demo/feishu-real.mjs --mode demo
//     （可选 --mock-llm 不花 token；--debug 看详细日志）
//
//   # 真实部署（必须先配 IM_ALLOWLIST/IM_ADMINS，否则拒绝启动）
//   IM_ALLOWLIST="feishu:ou_xxx" IM_ADMINS="feishu:ou_xxx" \
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx DEEPSEEK_API_KEY=sk-xxx \
//     node demo/feishu-real.mjs --mode prod
//
// 环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY /
//   IM_FEISHU_LOG_LEVEL（默认 demo=debug / prod=warn）
// 其余（IM_ALLOWLIST/ADMINS/ROOTS/DENY/WORKSPACE_DIR）由 bridge-core 统一读取。

const { default: ImFeishu } = await import('../packages/im-feishu/lib/index.js');
const { bootBridge } = await import('./bridge-core.mjs');

const argv = process.argv;
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'demo';
const MOCK_LLM = argv.includes('--mock-llm');
const DEBUG = argv.includes('--debug');

if (MODE !== 'demo' && MODE !== 'prod') {
  console.error(`❌ 未知模式 ${MODE}（支持 demo | prod）`);
  process.exit(1);
}
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.error('❌ 需要 FEISHU_APP_ID / FEISHU_APP_SECRET（飞书开放平台自建应用的凭证）。');
  process.exit(1);
}
if (!MOCK_LLM && !process.env.DEEPSEEK_API_KEY) {
  console.error('❌ 需要 DEEPSEEK_API_KEY（或用 --mock-llm 走脚本化模型，仅 demo 模式）。');
  process.exit(1);
}

console.log(`\n===== dsh-im-bridge × 飞书  模式：${MODE === 'demo' ? '🎛 演示（开发自用）' : '🏭 真实部署（严格安全）'} =====`);
if (MODE === 'demo') {
  console.log('  演示模式特性：首条消息自动信任、工作根写免审批、debug 日志、可用 --mock-llm');
} else {
  console.log(`  生产模式特性：allowlist=${(process.env.IM_ALLOWLIST ?? '').split(',').filter(Boolean).length}人 / admins=${(process.env.IM_ADMINS ?? '').split(',').filter(Boolean).length}人、首接触走管理员确认、持久化存储`);
}

let core;
try {
  core = await bootBridge({ mode: MODE, mockLLM: MOCK_LLM });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const { ctx, im } = core;

const feishuHandle = ctx.plugin(ImFeishu, {
  appId: 'env:FEISHU_APP_ID',
  appSecret: 'env:FEISHU_APP_SECRET',
  debug: process.env.IM_FEISHU_DEBUG === '1' || DEBUG,
  logLevel: process.env.IM_FEISHU_LOG_LEVEL ?? (MODE === 'demo' ? 'debug' : 'warn'),
});
await feishuHandle.await();

console.log('\n' + '='.repeat(60));
console.log('  飞书通道已注册。');
console.log('  1) 打开飞书 → 搜索你的机器人应用名 → 私聊');
console.log('  2) 发 /new 创建会话，然后直接派活');
if (MODE === 'prod') {
  console.log('  3) 新用户首次接触 → 管理员收到信任确认，/trust feishu:<open_id> 授权');
} else {
  console.log('  3) （演示模式：首条消息自动信任）');
}
console.log('  4) 写/编辑工作根外文件 → 审批卡片；/status /log 可用');
console.log('  Ctrl+C 退出。');
console.log('='.repeat(60));

let lastStatus = '';
const tick = setInterval(() => {
  const ch = im.channels.get('feishu');
  if (ch?.status) {
    const st = ch.status;
    const ev = st.lastEventAt ? ` · 最近事件 ${Math.round((Date.now() - st.lastEventAt) / 1000)}s 前` : ' · ⚠️ 尚无事件（检查事件订阅/权限/发布）';
    const line = `📡 飞书连接: ${st.connected ? '✅ ' + st.detail : '❌ ' + st.detail}${ev}`;
    if (line !== lastStatus) {
      lastStatus = line;
      console.log(line);
    }
  }
}, 2000);
tick.unref?.();

process.on('SIGINT', async () => {
  clearInterval(tick);
  try { await feishuHandle.dispose(); } catch { /* 忽略 */ }
  await core.dispose();
  process.exit(0);
});

// 保持进程存活（飞书长连接由 SDK 内部维持）
await new Promise(() => {});
