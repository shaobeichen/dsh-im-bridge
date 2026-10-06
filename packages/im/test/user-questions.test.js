// 用户提问应答者测试（无网络、无真实凭据）
//
// 回归点：IM 渠道此前没有任何 user-questions 应答者，agent 的 ask_user_question
// 会落到 noAnswerer 并抛 NO_PROVIDER —— 用户什么都看不到，任务直接失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserQuestionAnswerer } from '../lib/user-questions.js';

/** 构造 answerer + 捕获已推送消息。 */
function makeAnswerer(cfg = {}) {
  const sent = [];
  const logs = [];
  const map = {
    bySessionId: (sid) => (sid === 'im-mock-c1' ? { platform: 'mock', chatId: 'c1' } : null),
  };
  const ctx = { on: () => () => {}, get: () => undefined };
  const a = new UserQuestionAnswerer({
    ctx,
    map,
    send: async (chat, out) => { sent.push({ chat, out }); },
    logLine: (l) => logs.push(l),
    cfg,
  });
  return { a, sent, logs };
}

const REQ = {
  agent: { id: 'im-mock-c1' },
  questions: [
    {
      id: 'q1',
      question: '部署到哪个环境？',
      header: '环境选择',
      options: [
        { label: 'staging', description: '预发' },
        { label: 'production', description: '生产' },
      ],
    },
  ],
};

test('把提问推成 IM 卡片，含编号选项与按钮', async () => {
  const { a, sent } = makeAnswerer();
  const p = a.answer(REQ, async () => { throw new Error('不该委托'); });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(sent.length, 1);
  const card = sent[0].out;
  assert.ok(card.text.includes('部署到哪个环境？'), '卡片包含问题');
  assert.ok(card.text.includes('1. staging'), '卡片包含编号选项');
  assert.ok(card.text.includes('2. production'));
  assert.equal(card.buttons.length, 2, '每个选项一个按钮');
  assert.deepEqual(card.buttons.map((b) => b.id), ['q:01:0:0', 'q:01:0:1']);

  // 用户点第 2 个按钮
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 1 }]), 'answered');
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'q1', selected: ['production'] }]);
});

test('非 IM 会话必须委托给 next()（不能吞掉提问）', async () => {
  const { a, sent } = makeAnswerer();
  let delegated = false;
  const out = await a.answer(
    { agent: { id: 'some-gui-session' }, questions: REQ.questions },
    async () => { delegated = true; return { answers: [] }; },
  );
  assert.equal(delegated, true, '非 IM 会话应调用 next() 委托');
  assert.equal(sent.length, 0, '不应向 IM 推送');
  assert.deepEqual(out, { answers: [] });
});

test('无选项的提问也能应答（自定义文字）', async () => {
  const { a, sent } = makeAnswerer();
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: [{ id: 'q1', question: '项目叫什么？' }] },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent[0].out.text.includes('无预设选项'), '提示直接回复文字');
  assert.equal(sent[0].out.buttons.length, 0);

  assert.equal(a.respond('01', [], 'my-project'), 'answered');
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'q1', selected: [], custom: 'my-project' }]);
});

test('多问题：编号为 q.o，按钮载荷带问题序号', async () => {
  const { a, sent } = makeAnswerer();
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: '环境？', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '是否备份？', options: [{ label: '是' }, { label: '否' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent[0].out;
  assert.ok(card.text.includes('1.1. A'), '多问题时编号为 问题序号.选项序号');
  assert.deepEqual(
    card.buttons.map((b) => b.id),
    ['q:01:0:0', 'q:01:0:1', 'q:01:1:0', 'q:01:1:1'],
  );

  // 分别回答两个问题
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 1 }, { qIndex: 1, oIndex: 0 }]), 'answered');
  const ans = await p;
  assert.deepEqual(ans.answers, [
    { id: 'q1', selected: ['B'] },
    { id: 'q2', selected: ['是'] },
  ]);
});

test('超时（timeoutSec>0）→ 返回空答案并提示，不阻塞', async () => {
  const { a, sent } = makeAnswerer({ timeoutSec: 0.05 });
  const p = a.answer(REQ, async () => { throw new Error('不该委托'); });
  const ans = await p;
  assert.deepEqual(ans.answers, []);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.some((s) => s.out.text.includes('已超时')), '应提示超时');
});

test('重复应答：第二次返回 not-found（首答生效）', async () => {
  const { a } = makeAnswerer();
  const p = a.answer(REQ, async () => { throw new Error('不该委托'); });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 0 }]), 'answered');
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 1 }]), 'not-found');
  await p;
});

test('skip：不选任何选项，返回空答案让 agent 自行决定', async () => {
  const { a, sent } = makeAnswerer();
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: '环境？', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '备份？', options: [{ label: '是' }, { label: '否' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));

  // 卡片上必须提示 skip 用法，否则用户不知道该能力存在
  assert.ok(sent[0].out.text.includes('skip'), '卡片应提示 skip 用法');

  assert.equal(a.skip('01'), 'skipped');
  const ans = await p;
  assert.deepEqual(ans.answers, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: [] },
  ], 'skip 语义 = 空选择，agent 自行决定');

  // 跳过后再应答不生效（已结束）
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 0 }]), 'not-found');
  assert.equal(a.skip('01'), 'not-found');
});

test('skip 未知 id 返回 not-found', async () => {
  const { a } = makeAnswerer();
  assert.equal(a.skip('99'), 'not-found');
});

test('未知 id / 无效选项被拒绝', async () => {
  const { a } = makeAnswerer();
  assert.equal(a.respond('99', [{ qIndex: 0, oIndex: 0 }]), 'not-found');

  const p = a.answer(REQ, async () => { throw new Error('不该委托'); });
  await new Promise((r) => setTimeout(r, 10));
  // 回归（P2-7）：越界编号必须**拒绝并保持等待**，不能静默丢弃后照样结题——
  // 否则用户以为选上了，agent 却拿到空选择。
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 99 }]), 'invalid');
  assert.equal(a.respond('01', [{ qIndex: 9, oIndex: 0 }]), 'invalid');
  assert.equal(a.records.size, 1, '无效编号后提问必须仍在等待');
  // 随后给合法编号仍能正常作答
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 1 }]), 'answered');
  const ans = await p;
  assert.deepEqual(ans.answers, [{ id: 'q1', selected: ['production'] }]);
});

test('回归：跨会话代答被拒绝（问题归属校验）', async () => {
  const { a } = makeAnswerer();
  const p = a.answer(REQ, async () => { throw new Error('不该委托'); });
  await new Promise((r) => setTimeout(r, 10));
  // 别的聊天里的用户（即使已授权）不能回答本会话的提问
  assert.equal(
    a.respond('01', [{ qIndex: 0, oIndex: 0 }], undefined, { platform: 'mock', chatId: 'other' }),
    'forbidden',
  );
  assert.equal(a.records.size, 1, '被拒绝后提问必须仍在等待');
  // 本会话可以
  assert.equal(
    a.respond('01', [{ qIndex: 0, oIndex: 0 }], undefined, { platform: 'mock', chatId: 'c1' }),
    'answered',
  );
  await p;
});

test('回归：dispose 按 {answers} 契约结算（不是状态字符串）', async () => {
  const { a } = makeAnswerer();
  const p = a.answer(REQ, async () => { throw new Error('不该委托'); });
  await new Promise((r) => setTimeout(r, 10));
  a.dispose();
  const ans = await p;
  assert.deepEqual(ans, { answers: [] }, 'dispose 必须返回合法应答契约');
  assert.equal(a.records.size, 0);
});

test('回归：id 不回绕复用（旧等待记录不被覆盖）', async () => {
  const { a } = makeAnswerer();
  const p1 = a.answer(REQ, async () => { throw new Error('不该委托'); });
  await new Promise((r) => setTimeout(r, 10));
  const first = [...a.records.keys()][0];
  // 若仍用 %999 回绕，再分配 1200 次后会重新发到 first 并覆盖旧记录
  for (let i = 0; i < 1200; i++) a._nextId();
  const reused = a._nextId();
  assert.notEqual(reused, first, '新 id 不得复用仍在等待的 id');
  assert.equal(a.records.size, 1, '旧等待记录必须仍在');
  assert.equal(a.respond(first, [{ qIndex: 0, oIndex: 0 }]), 'answered');
  await p1;
});

test('回归：卡片发送挂起（无 abort）→ 发送看门狗 fail closed（round-7 F04）', async () => {
  // 默认 timeoutSec=0（无限等用户）+ 非 timed（无 DSH abort 救援）+ send 永不 settle
  // → 旧实现记录永久挂起（agent 任务卡死、用户没收到卡片）。
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: () => new Promise(() => {}), // 永不 resolve/reject
    logLine: () => {},
    cfg: { sendTimeoutSec: 0.05 },
  });
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: REQ.questions },
    async () => { throw new Error('不该委托'); },
  );
  const r = await Promise.race([
    p,
    new Promise((res) => setTimeout(() => res('__timeout__'), 2000)),
  ]);
  assert.notEqual(r, '__timeout__', '看门狗到期必须让 promise 落地，不得挂死');
  assert.deepEqual(r, { answers: [] }, 'fail closed：空答案让 agent 得知投递失败');
  assert.equal(a.records.size, 0, '结算后不得残留等待记录');
});

test('回归：发送成功清除看门狗（慢发送不触发 fail closed）', async () => {
  // send 在 30ms 后成功（早于 50ms 看门狗）→ 必须无限等用户，看门狗被清除
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => { await new Promise((r) => setTimeout(r, 30)); },
    logLine: () => {},
    cfg: { sendTimeoutSec: 0.05 },
  });
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: REQ.questions },
    async () => { throw new Error('不该委托'); },
  );
  // 等过看门狗时限：若看门狗未被清除，p 会在此前 resolve 成 {answers:[]}
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(a.records.size, 1, '发送成功且未超时应继续等待用户（看门狗已清除）');
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 0 }]), 'answered');
  await p;
});

test('回归：发送挂起期间 abort 必须 reject（不得永久等待）', async () => {
  let releaseSend;
  const sendGate = new Promise((r) => { releaseSend = r; });
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => { await sendGate; },   // 发送一直挂起
    logLine: () => {},
    cfg: {},
  });
  const ac = new AbortController();
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: REQ.questions, signal: ac.signal },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();   // 发送仍在挂起时取消
  await assert.rejects(p, (e) => e.code === 'ABORTED', 'abort 必须 reject 而不是挂着');
  assert.equal(a.records.size, 0, 'abort 后不得残留等待记录');
  releaseSend();
});

test('回归：timed 请求 abort 抛 ASK_TIMED_OUT（保留 continued 语义）', async () => {
  const { a } = makeAnswerer();
  const ac = new AbortController();
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: REQ.questions, signal: ac.signal, wait: { callId: 'c1', timed: true } },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  // DSH 靠异常码区分「超时挂起（可续答）」与「用户真答了空」
  await assert.rejects(p, (e) => e.code === 'ASK_TIMED_OUT');
});

test('回归：abort 后不再推送卡片（注册前已 abort）', async () => {
  const { a, sent } = makeAnswerer();
  const ac = new AbortController();
  ac.abort();
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: REQ.questions, signal: ac.signal },
    async () => { throw new Error('不该委托'); },
  );
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, '已 abort 就不该再推卡片');
});

test('回归：多问题卡片按钮逐题累计，答全才结题（不再点一题就提交）', async () => {
  const sent = [];
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async (chat, out) => { sent.push(out); },
    logLine: () => {},
    cfg: {},
  });
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = [...a.records.keys()][0];
  const from = { platform: 'mock', chatId: 'c1' };

  // round-3 发现：点第一题**不能**立刻结题（否则第二题被当成空答案、余下按钮失效）
  const first = a.accumulate(id, [{ qIndex: 0, oIndex: 1 }], from);
  assert.equal(first.status, 'partial', '未答全应保持等待');
  assert.equal(first.answered, 1);
  assert.equal(first.total, 2);
  assert.equal(first.label, 'a2', '应回报已选项，便于用户确认');
  assert.equal(a.records.size, 1, '提问必须仍在等待');

  // 点第二题 → 答全 → 自动提交，且两题都是用户真实选择
  const second = a.accumulate(id, [{ qIndex: 1, oIndex: 0 }], from);
  assert.equal(second.status, 'answered');
  const ans = await p;
  assert.deepEqual(ans.answers, [
    { id: 'q1', selected: ['a2'] },
    { id: 'q2', selected: ['b1'] },
  ], '两题都必须是用户点的，不能被空答案顶替');
});

test('回归：/answer done 提交草稿（未答的题按跳过）', async () => {
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => {},
    logLine: () => {},
    cfg: {},
  });
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = [...a.records.keys()][0];
  const from = { platform: 'mock', chatId: 'c1' };
  a.accumulate(id, [{ qIndex: 0, oIndex: 0 }], from);
  assert.equal(a.commitDraft(id, from), 'answered');
  const ans = await p;
  assert.deepEqual(ans.answers, [
    { id: 'q1', selected: ['a1'] },
    { id: 'q2', selected: [] },
  ], '提交后未答的题按跳过处理');
});

test('回归：无任何选择时 done 被拒（不伪造结题）', async () => {
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => {},
    logLine: () => {},
    cfg: {},
  });
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: [{ id: 'q1', question: 'A?', options: [{ label: 'a1' }] }] },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = [...a.records.keys()][0];
  assert.equal(a.commitDraft(id, { platform: 'mock', chatId: 'c1' }), 'empty');
  assert.equal(a.records.size, 1, '仍应等待');
  a.accumulate(id, [{ qIndex: 0, oIndex: 0 }], { platform: 'mock', chatId: 'c1' });
  await p;
});

test('回归：文字命令路径合法部分答案已记录可续答（round-6 F1）', async () => {
  const { a } = makeAnswerer();
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = [...a.records.keys()][0];
  // 🔴 旧行为：合法部分答案返回 'invalid'（回执"编号越界"），但 _merge 已原子
  // 写入草稿——状态与回执矛盾。现在返回 'partial'（已记录、继续等待），
  // 结算门（答全才自动提交）保持不变。
  assert.equal(
    a.respond(id, [{ qIndex: 0, oIndex: 0 }], undefined, { platform: 'mock', chatId: 'c1' }),
    'partial',
    '文字路径下合法但未答全 → partial（已记录），不再是 invalid',
  );
  assert.equal(a.records.size, 1, '必须仍在等待');
  assert.equal(
    a.respond(id, [{ qIndex: 0, oIndex: 0 }, { qIndex: 1, oIndex: 1 }], undefined, { platform: 'mock', chatId: 'c1' }),
    'answered',
  );
  await p;
});

test('回归：single-select 多选被拒；multiSelect 允许多选', async () => {
  const { a } = makeAnswerer();
  const p = a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [{ id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] }],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = [...a.records.keys()][0];
  assert.equal(
    a.respond(id, [{ qIndex: 0, oIndex: 0 }, { qIndex: 0, oIndex: 1 }], undefined, { platform: 'mock', chatId: 'c1' }),
    'invalid',
    'single-select 选两项必须拒绝',
  );
  assert.equal(a.respond(id, [{ qIndex: 0, oIndex: 0 }], undefined, { platform: 'mock', chatId: 'c1' }), 'answered');
  await p;
});

test('回归：多题卡含多选不得承诺"答全自动提交"（round-2 P2-1）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?（多选）', options: [{ label: 'b1' }, { label: 'b2' }], multiSelect: true },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  // 🔴 多题卡里只要有一题 multiSelect，统一结题门就禁止自动提交——
  // 旧版多题分支无条件写"答全会自动提交"，是错误承诺（用户答完停在 partial）。
  assert.ok(!card.text.includes('答全会自动提交'), '含多选的多题卡不得承诺"答全会自动提交"');
  assert.ok(card.text.includes('不会自动提交'), '应明确"不会自动提交"');
  assert.ok(card.text.includes('/answer'), '应给出 done 提交命令');
  // 🔴 多题示例必须用"题号.选项号"，且从实际题目派生（round-3 P2 → round-5 P2）：
  // 裸 `1,3` 在多题解析下全部映射到第 1 题；硬编码 2.1,2.3 在 q2 只有 2 个选项时越界。
  assert.ok(card.text.includes('2.1,2.2'), '多题多选的编号示例必须取自实际多选题（如 2.1,2.2）');
});

test('回归：多题卡示例取自实际题目，照抄不得 invalid（round-5 P2）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?（多选）', options: [{ label: 'b1' }, { label: 'b2' }, { label: 'b3' }], multiSelect: true },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');

  // 提取卡片里的多选逗号示例，按用户视角解析（点号 → qIndex/oIndex）后照抄提交
  const m = card.text.match(/多选逗号分隔，如 `(\d+\.\d+,\d+\.\d+)`/);
  assert.ok(m, '多题多选的"选项题"行应给出点号逗号示例');
  const picks = m[1].split(',').map((t) => {
    const [q, o] = t.split('.').map(Number);
    return { qIndex: q - 1, oIndex: o - 1 };
  });
  const r = a.accumulate('01', picks, { platform: 'mock', chatId: 'c1' });
  assert.notEqual(r.status, 'invalid', `照抄多选示例不得 invalid（实际: ${r.status}）`);

  // 单个示例（"选项题"行首个点号示例）同样照抄不得 invalid
  const s = card.text.match(/如 `(\d+\.\d+)`/);
  assert.ok(s, '"选项题"行应给出单个点号示例');
  const [sq, so] = s[1].split('.').map(Number);
  const r2 = a.accumulate('01', [{ qIndex: sq - 1, oIndex: so - 1 }], { platform: 'mock', chatId: 'c1' });
  assert.notEqual(r2.status, 'invalid', `照抄单示例不得 invalid（实际: ${r2.status}）`);
});

test('回归：第 1 题为文字题时选项示例必须指向真实选项题（round-5 P2）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: '叫什么名字？' }, // 文字题，无选项
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  const m = card.text.match(/如 `(\d+)\.(\d+)`/);
  assert.ok(m, '多题卡应有点号示例');
  assert.equal(Number(m[1]), 2, '第 1 题是文字题：示例必须指向第 2 题（照抄 1.x 会越界 invalid）');
});

test('回归：respond 合法部分答案返回 partial 而非 invalid（round-6 F1）', async () => {
  const { a } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  // 合法但未答全：草稿已原子记录，状态必须是 partial（已记录、可续答），
  // 不能再是 invalid（旧版回执"编号越界"与草稿实际状态矛盾）。
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 0 }]), 'partial', '合法部分答案应为 partial');
  // 真·非法输入仍为 invalid（且原子性：草稿不被半写）
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 99 }]), 'invalid', '越界 pick 仍 invalid');
  assert.equal(a.respond('01', [{ qIndex: 0, oIndex: 1 }, { qIndex: 0, oIndex: 0 }]), 'invalid', '单选同题多 pick 仍 invalid');
});

test('回归：混合卡题目旁提示指向 text 语法（round-6 F2）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: '选一个', options: [{ label: 'a' }, { label: 'b' }] },
        { id: 'q2', question: '项目叫什么？' }, // 自由文本题
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  // 混合卡下普通文字会被 dispatchTask 当新任务——题目旁提示不得再写"直接回复文字"
  assert.ok(!card.text.includes('请直接回复文字'), '混合卡不得引导"直接回复文字"（会被当作新任务）');
  assert.ok(card.text.includes('/answer 01 text'), '混合卡题目旁提示必须给出 /answer <id> text 语法');
});

test('回归：全文字卡仍引导直接回复文字（round-6 F2 负向对照）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [{ id: 'q1', question: '工单号？' }],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  assert.ok(card.text.includes('请直接回复文字'), '全文字卡保持"直接回复文字"提示');
});

test('回归：单选票卡不得出现逗号多选示例（round-4 P2-1）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [{ id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }, { label: 'a3' }] }],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  // 旧版"选项题"行无条件带"多选逗号分隔，如 1,3"——单选卡照抄会返回 invalid
  assert.ok(!card.text.includes('1,3'), '单选票卡不得出现逗号多选示例（照抄会 invalid）');
});

test('回归：无多选的多题卡提示行只给点号格式（round-4 P2-1）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  assert.ok(card.text.includes('题号.选项号'), '多题卡提示行必须引导"题号.选项号"格式');
  assert.ok(!card.text.includes('1,3'), '无多选的多题卡不得出现裸逗号示例（裸编号多题下全落第 1 题）');
});

test('回归：无多选的多题卡保留"答全自动提交"口径（round-2 P2-1 负向对照）', async () => {
  const { a, sent } = makeAnswerer();
  a.answer(
    {
      agent: { id: 'im-mock-c1' },
      questions: [
        { id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
        { id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      ],
    },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  const card = sent.find((m) => m.out?.text)?.out;
  assert.ok(card, '提问卡应已推送');
  assert.ok(card.text.includes('答全会自动提交'), '无多选的多题卡应保留"答全会自动提交"');
  assert.ok(!card.text.includes('不会自动提交'), '无多选的卡不得出现多选警示');
});

test('回归：timed 超时后迟答经 DSH 继续协议转交（continued）', async () => {
  const delivered = [];
  const svc = {
    answer: (agent, callId, answer) => { delivered.push({ agent, callId, answer }); return true; },
  };
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: (k) => (k === 'userQuestions' ? svc : undefined) },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => {},
    logLine: () => {},
    cfg: {},
  });
  const ac = new AbortController();
  const agent = { id: 'im-mock-c1' };
  const p = a.answer(
    { agent, questions: REQ.questions, signal: ac.signal, wait: { callId: 'call-9', timed: true } },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'ASK_TIMED_OUT', '前台必须 reject 以便 DSH 得到 pending');
  // 记录转入 continued，迟答仍能找到入口（round-2 发现 5）
  assert.equal(a.records.size, 0);
  assert.equal(a.continued.size, 1, 'timed 超时后记录必须保留在 continued');
  const id = [...a.continued.keys()][0];
  assert.equal(
    a.respond(id, [{ qIndex: 0, oIndex: 1 }], undefined, { platform: 'mock', chatId: 'c1' }),
    'continued',
    '迟答必须经继续协议转交',
  );
  // eslint-disable-next-line no-unused-expressions
  assert.equal(delivered.length, 1, '必须调用 userQuestions.answer(agent, callId, answers)');
  assert.equal(delivered[0].callId, 'call-9');
  assert.equal(delivered[0].agent, agent);
  assert.deepEqual(delivered[0].answer.answers, [{ id: 'q1', selected: ['production'] }]);
  assert.equal(a.continued.size, 0, '转交成功后应清理');
});

test('回归：无 DSH 继续服务时，迟答明确报无法转交（不静默成功）', async () => {
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },   // 服务不可用
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => {},
    logLine: () => {},
    cfg: {},
  });
  const ac = new AbortController();
  const p = a.answer(
    { agent: { id: 'im-mock-c1' }, questions: REQ.questions, signal: ac.signal, wait: { callId: 'c1', timed: true } },
    async () => { throw new Error('不该委托'); },
  );
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p);
  const id = [...a.continued.keys()][0];
  assert.equal(
    a.respond(id, [{ qIndex: 0, oIndex: 0 }], undefined, { platform: 'mock', chatId: 'c1' }),
    'no-continuation',
  );
});

test('推送失败 → 不阻塞 agent（fail closed 返回空答案）', async () => {
  const sent = [];
  const a = new UserQuestionAnswerer({
    ctx: { on: () => () => {}, get: () => undefined },
    map: { bySessionId: () => ({ platform: 'mock', chatId: 'c1' }) },
    send: async () => { throw new Error('channel down'); },
    logLine: () => {},
    cfg: {},
  });
  const ans = await a.answer(REQ, async () => { throw new Error('不该委托'); });
  assert.deepEqual(ans, { answers: [] }, '推送失败应返回空答案而不是卡住');
  assert.equal(sent.length, 0);
});

test('mount() 注册 waterfall 监听；dispose() 清理', () => {
  const handlers = [];
  const a = new UserQuestionAnswerer({
    ctx: { on: (evt, fn, opts) => { handlers.push({ evt, fn, opts }); return () => {}; }, get: () => undefined },
    map: {},
    send: async () => {},
    cfg: {},
  });
  a.mount();
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].evt, 'user-questions/request');
  // prepend 是关键：GUI 桥也会注册同一 waterfall 并转发给浏览器；先注册者先执行、
  // 先返回者认领。不 prepend 就永远轮不到 IM 应答者（症状：IM 收不到选项）。
  assert.equal(
    handlers[0].opts?.prepend,
    true,
    '必须以 prepend 注册，否则会被 GUI 转发器抢先认领',
  );
  a.dispose();
});

test('enabled=false 时不注册（交由其他应答者）', () => {
  const handlers = [];
  const a = new UserQuestionAnswerer({
    ctx: { on: (evt, fn) => { handlers.push({ evt, fn }); return () => {}; }, get: () => undefined },
    map: {},
    send: async () => {},
    cfg: { enabled: false },
  });
  a.mount();
  assert.equal(handlers.length, 0);
});