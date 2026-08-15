#!/usr/bin/env node
// 新渠道适配器脚手架（AGENTS.md 规则 #1：写新适配器必须用它生成骨架）
//
// 用法：
//   node scripts/new-adapter.mjs <platform> [--name "显示名"]
//   例：node scripts/new-adapter.mjs wecom
//
// 生成 packages/im-<platform>/：
//   lib/index.js        适配器骨架（契约完整：platform/send/sendFile/status含lastEventAt/dispose）
//   test/contract.test.js  契约测试（registerChannel 能通过 validateAdapterContract）
//   test/adapter.test.js   stub-SDK 接线测试骨架
//   README.md            setup 文档骨架（四件事：凭证/权限/订阅/发布）
//   package.json         包元数据（peerDeps: dsh-im、cordis）
//
// 生成后按 docs/adapters-guide.md 填写：
//   1. 官方 SDK（薄封装，可注入 internals.sdk）
//   2. parseContent 纯函数 + 单测
//   3. 按钮 → 平台原生组件 + 回调 → ctx.im.handleCallback
//   4. 平台 setup 文档（用平台的词）

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const platform = args[0];
if (!platform || !/^[a-z0-9-]+$/.test(platform)) {
  console.error('用法：node scripts/new-adapter.mjs <platform>   （platform 为小写字母/数字/连字符，如 wecom / dingtalk）');
  process.exit(1);
}
const displayName = args.includes('--name') ? args[args.indexOf('--name') + 1] : platform;
const pkgDir = join(root, 'packages', `im-${platform}`);
if (existsSync(pkgDir)) {
  console.error(`❌ ${pkgDir} 已存在，不覆盖。`);
  process.exit(1);
}

const files = {
  'package.json': `{
  "name": "dsh-im-${platform}",
  "version": "0.1.0-rc.1",
  "description": "${displayName} 渠道适配器（dsh-im 插件家族）。",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": { "default": "./lib/index.js" }, "./package.json": "./package.json" },
  "files": ["lib"],
  "license": "MIT",
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "dsh-im": "^0.1.0-rc.1" },
  "engines": { "node": ">=22" }
}
`,
  'lib/index.js': `// dsh-im-${platform} 渠道适配器（骨架 —— 按 docs/adapters-guide.md 填写）
//
// 契约（AGENTS.md 规则 #4）：platform / send / status(connected+detail+lastEventAt) / dispose
// 入站：ctx.im.dispatchInbound(ImMessage)；按钮回调：ctx.im.handleCallback({platform, chatId, userId, userName, data})
// 密钥：一律 env: 引用，如 token: 'env:${platform.toUpperCase()}_TOKEN'
//
// TODO（按 adapters-guide.md）：
//   1. 官方 SDK 薄封装（可注入 internals.sdk）—— 禁止手写平台协议
//   2. parseContent(msgType, content) 纯函数 + 单测
//   3. buttons → 平台原生交互组件；回调 → 中性 data（approve:<id>:yes）
//   4. 连接模式决策：免公网优先（长轮询/长连接 vs webhook）

import z from '@deepseek-ai/schemastery';

const name = 'im-${platform}';
const inject = ['im'];

const Config = z.object({
  token: z.string().default('env:${platform.toUpperCase()}_TOKEN'),
});

/** 解析密钥引用：'env:NAME' → process.env.NAME。 */
export function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? '';
  }
  return value;
}

export function apply(ctx, config = {}, internals = {}) {
  const token = resolveSecret(config.token);
  const logger = ctx.logger?.(name) ?? console;
  let disposed = false;

  const channel = {
    platform: '${platform}',
    displayName: '${displayName}',
    status: {
      connected: false,
      detail: token ? 'starting' : 'missing token',
      lastEventAt: null, // 最近事件心跳（可观测三件套）
    },
    send,
    sendFile,
    dispose: async () => { disposed = true; /* TODO: 断开平台连接 */ },
  };
  ctx.get('im').registerChannel(channel);

  if (!token) {
    logger.error('dsh-im-${platform}: missing token; channel stays disconnected');
    return () => channel.dispose();
  }

  // TODO: 连接平台（官方 SDK / polling / webhook），连上后更新 channel.status
  void (async () => {
    // channel.status = { connected: true, detail: 'connected' };
  })();

  return () => channel.dispose();

  async function send(out) {
    // TODO: 文本 → 平台消息；out.buttons → 平台原生交互组件（按钮 value 携带
    //   {action, id, answer}，回调原样回传）；out.attachments/sendFile → 平台文件
    channel.status.connected = true;
    return {};
  }

  async function sendFile(chatId, name, text, mime = 'text/plain') {
    // TODO: /log 全量交付：上传文件后发文件消息
    return {};
  }

  // TODO: 平台事件 → 统一模型：
  //   channel.status.lastEventAt = Date.now();
  //   await ctx.get('im').dispatchInbound({ platform: '${platform}', chatId, userId, userName, text, msgId, chatType, attachments });
  // 按钮回调：
  //   await ctx.get('im').handleCallback({ platform: '${platform}', chatId, userId, userName, data });
}

/** 消息内容解析（平台形状各异，纯函数，可单测）。 */
export function parseContent(msgType, content) {
  // TODO: text / post / file / image ... 的 JSON 结构解析
  return String(content ?? '').slice(0, 500);
}

export { name, inject, Config };
export default { name, inject, Config, apply };
export const plugin = { name, inject, Config, apply };
`,
  'test/contract.test.js': `// 契约测试（AGENTS.md 规则 #4 / #9）：适配器必须通过 validateAdapterContract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapterContract } from 'dsh-im/channel';

test('适配器满足核心契约（platform/send/status+lastEventAt/dispose）', () => {
  const channel = {
    platform: '${platform}',
    status: { connected: false, detail: 'test', lastEventAt: null },
    send: async () => ({}),
    sendFile: async () => ({}),
    dispose: async () => {},
  };
  const r = validateAdapterContract(channel);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('契约缺失必须抛错（FR-9.4 不兼容即报错）', () => {
  assert.throws(() => validateAdapterContract({ platform: '${platform}' }));
  assert.throws(() => validateAdapterContract({ send: async () => ({}) }));
  assert.throws(() => validateAdapterContract({ platform: '${platform}', send: 'not-a-fn' }));
});

test('缺少 lastEventAt 心跳 → warnings（可观测性提示）', () => {
  const r = validateAdapterContract({ platform: '${platform}', status: { connected: false }, send: async () => ({}) });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('lastEventAt')));
});
`,
  'test/adapter.test.js': `// 接线测试骨架（AGENTS.md 规则 #3/#9）：stub 官方 SDK，CI 不碰真实凭据
import { test } from 'node:test';
import assert from 'node:assert/strict';
// import { apply } from '../lib/index.js';
// TODO: 用 internals.sdk / internals.fetchImpl / internals.wsImpl 注入 stub，
//   验证：事件 → ImMessage → dispatchInbound；出站 send/sendFile 载荷；
//   parseContent 纯函数；缺凭据 → status 断开并提示。
test('TODO: stub SDK 接线测试', () => {
  assert.ok(true);
});
`,
  'README.md': `# dsh-im-${platform}（${displayName} 适配器）

> 骨架。按 docs/adapters-guide.md 完成实现与文档。

## 平台四件事（setup 文档必须写清）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 凭证（官方后台创建应用，拿 token/密钥） | ⬜ |
| 2 | 权限/作用域（**逐个事件核对官方文档**） | ⬜ |
| 3 | 订阅方式（长连接/轮询 = 免公网优先？webhook？） | ⬜ |
| 4 | 发布生效（改配置后要重新发布/审批？） | ⬜ |

## 实现状态

- [ ] 官方 SDK 薄封装（internals.sdk 可注入）
- [ ] parseContent 纯函数 + 单测
- [ ] buttons → 平台原生交互组件 + 回调 → handleCallback
- [ ] 可观测三件套（连接状态 / lastEventAt 心跳 / 边界日志带错误码）
- [ ] demo 运行器接入（--mode demo|prod）
- [ ] 契约测试 + stub SDK 测试全绿
`,
};

for (const [rel, content] of Object.entries(files)) {
  const f = join(pkgDir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
}

console.log(`✅ 已生成适配器骨架：${pkgDir}`);
console.log('');
console.log('下一步（按 docs/adapters-guide.md）：');
console.log('  1) 查官方 SDK → 写薄封装（lib/index.js 的 TODO）');
console.log('  2) 填四件事 → README.md（凭证/权限/订阅/发布）');
console.log('  3) 写 parseContent + 单测');
console.log('  4) 跑测试：node --test packages/im-' + platform + '/test/');
console.log('  5) npm test 全绿后，在 demo/ 里接入运行器');
