import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  markdownToText, splitLongText, summarizeLongOutput,
  resultCard, estimateCost, argsSummary, MAX_MESSAGE_CHARS, splitByBytes,
} from '../lib/renderer.js';

// ── splitByBytes：按 UTF-8 字节切，且不丢内容 ──────────────────────────────

test('splitByBytes：每段都不超字节上限，且拼回等于原文（无损）', () => {
  // 中文 3 字节/字：按字符切会严重超限，必须按字节
  const zh = '中文测试'.repeat(500);            // 2000 字 ≈ 6000 字节
  const parts = splitByBytes(zh, 1000);
  assert.ok(parts.length > 1, '超限时必须分段');
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p, 'utf8') <= 1000, `每段必须 ≤1000 字节（实际 ${Buffer.byteLength(p, 'utf8')}）`);
  }
  assert.equal(parts.join(''), zh, '分段必须无损');
});

test('splitByBytes：未超限时原样返回单段', () => {
  assert.deepEqual(splitByBytes('短文本', 1000), ['短文本']);
});

test('splitByBytes：超长单行（无换行）也能切开且无损', () => {
  const oneLine = 'A'.repeat(5000);
  const parts = splitByBytes(oneLine, 1000);
  assert.ok(parts.length >= 5);
  for (const p of parts) assert.ok(Buffer.byteLength(p, 'utf8') <= 1000);
  assert.equal(parts.join(''), oneLine);
});

test('splitByBytes：空串返回空数组', () => {
  assert.deepEqual(splitByBytes('', 100), []);
});

test('splitByBytes：优先在换行处断，且拼接无损', () => {
  const text = ['第一行内容', '第二行内容', '第三行内容'].join('\n');
  const firstTwo = '第一行内容\n第二行内容\n';
  const parts = splitByBytes(text, Buffer.byteLength(firstTwo, 'utf8'));
  assert.deepEqual(parts, ['第一行内容\n第二行内容\n', '第三行内容']);
  assert.equal(parts.join(''), text, '拼接必须还原原文（含换行）');
});

test('splitByBytes：多行文本按任意上限切分都无损', () => {
  const text = Array.from({ length: 30 }, (_, i) => `第 ${i} 行内容`).join('\n');
  for (const limit of [20, 50, 100, 300, 1000]) {
    const parts = splitByBytes(text, limit);
    for (const p of parts) {
      assert.ok(Buffer.byteLength(p, 'utf8') <= limit, `limit=${limit} 时每段不得超限`);
    }
    assert.equal(parts.join(''), text, `limit=${limit} 时必须无损`);
  }
});

test('splitByBytes：中文按字节切，不按字符（3 字节/字）', () => {
  const zh = '中文'.repeat(100); // 200 字 = 600 字节
  const parts = splitByBytes(zh, 100);
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p, 'utf8') <= 100, '每段 ≤100 字节');
    assert.ok(p.length <= 33, '100 字节最多约 33 个中文字符');
  }
  assert.equal(parts.join(''), zh);
});

// ── 回归：超过 maxChunks 不得静默丢内容 ───────────────────────────────────

test('回归：超过 maxChunks 时必须显式提示（不得静默丢内容）', () => {
  // 造出远多于 maxChunks 段的文本
  const text = Array.from({ length: 40 }, (_, i) => `段落${i}`.padEnd(200, 'x')).join('\n\n');
  const chunks = splitLongText(text, { maxLen: 300, maxChunks: 6 });
  assert.equal(chunks.length, 7, '保留 6 段 + 1 条提示');
  const last = chunks[chunks.length - 1];
  assert.ok(last.includes('未显示'), '最后一段必须说明还有内容未显示');
  assert.ok(last.includes('/log'), '必须告知如何取全文');
  assert.ok(/\d+ 段/.test(last), '必须给出未显示的段数');
});

test('未超 maxChunks 时不追加提示', () => {
  const text = Array.from({ length: 3 }, (_, i) => `段落${i}`.padEnd(200, 'x')).join('\n\n');
  const chunks = splitLongText(text, { maxLen: 300, maxChunks: 6 });
  assert.ok(!chunks.some((c) => c.includes('未显示')), '没截断就不该提示');
});

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
