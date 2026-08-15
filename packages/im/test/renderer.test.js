import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  markdownToText, splitLongText, summarizeLongOutput,
  resultCard, estimateCost, argsSummary, MAX_MESSAGE_CHARS,
} from '../lib/renderer.js';

test('markdown → 纯文本降级', () => {
  const md = '# 标题\n\n**粗体** 和 *斜体* 和 `code`\n\n> 引用\n\n- a\n- b\n\n```js\nconsole.log(1)\n```\n\n[链接](https://example.com)';
  const out = markdownToText(md);
  assert.ok(out.includes('▍ 标题'));
  assert.ok(out.includes('粗体'));
  assert.ok(!out.includes('**'));
  assert.ok(out.includes('console.log(1)'));
  assert.ok(out.includes('链接 (https://example.com)'));
});

test('markdown 表格折叠为文本行', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |';
  const out = markdownToText(md);
  assert.ok(out.includes('a | b'));
  assert.ok(out.includes('1 | 2'));
});

test('HTML 注入被剥离（安全，FR-10）', () => {
  const out = markdownToText('<script>alert(1)</script>hello **x**');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('hello'));
});

test('长文本按段落拆分', () => {
  const long = Array.from({ length: 30 }, (_, i) => `段落${i}：${'x'.repeat(300)}`).join('\n\n');
  const chunks = splitLongText(long);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= MAX_MESSAGE_CHARS);
  assert.equal(chunks.join('\n\n'), long);
});

test('无法拆分时折叠为摘要 + 关键结论（FR-3.4）', () => {
  const huge = 'A'.repeat(2000) + 'CONCLUSION-AT-END';
  const sum = summarizeLongOutput(huge, { head: 100, tail: 40 });
  assert.ok(sum.includes('CONCLUSION-AT-END'));
  assert.ok(sum.includes('/log'));
});

test('结果卡片：状态/耗时/token/成本', () => {
  const card = resultCard({
    status: 'completed',
    summary: '测试通过',
    durationMs: 1234,
    usage: { inputTokens: 100, outputTokens: 50 },
    costText: '$0.0042',
  });
  assert.ok(card.includes('✅'));
  assert.ok(card.includes('测试通过'));
  assert.ok(card.includes('1.2s'));
  assert.ok(card.includes('100 in / 50 out'));
  assert.ok(card.includes('$0.0042'));
});

test('成本估算：无定价返回 null；0 定价返回 null', () => {
  assert.equal(estimateCost({ inputTokens: 100 }, null), null);
  assert.equal(estimateCost({ inputTokens: 100 }, { inputPerM: 0, outputPerM: 0 }), null);
  const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, { inputPerM: 1, outputPerM: 16 });
  assert.ok(cost.startsWith('$'));
});

test('参数摘要：密钥脱敏（FR-6.3）', () => {
  const sum = argsSummary(JSON.stringify({
    command: 'curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.example.com',
    token: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
  }));
  assert.ok(!sum.includes('sk-abcdef1234567890'));
  assert.ok(!sum.includes('ghp_'));
  assert.ok(sum.includes('command'));
});
