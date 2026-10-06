import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionMap } from '../lib/session-map.js';
import { sessionIdFor, chatKey, parseUserKey } from '../lib/message.js';

test('会话 id 确定性生成（重启不变，FR-2.2）', () => {
  assert.equal(sessionIdFor('telegram', '12345'), sessionIdFor('telegram', '12345'));
  assert.match(sessionIdFor('telegram', '12345'), /^im-telegram-12345$/);
  // 常规 chatId（字母数字 + -_.）编码与旧格式一致 → 既有会话不受影响
  assert.equal(sessionIdFor('dingtalk', '9752'), 'im-dingtalk-9752');
  assert.equal(sessionIdFor('mock', 'chat-1'), 'im-mock-chat-1');
});

test('会话 id 编码单射：不同 chatId 不得碰撞（round-7 F01）', () => {
  // 旧实现把这些 chatId 映射到同一 session id → 跨聊天串会话
  assert.notEqual(sessionIdFor('mock', '12345'), sessionIdFor('mock', '-12345'), '首尾 '-' 差异不得被剥离成同一 id');
  assert.notEqual(sessionIdFor('mock', 'x-'), sessionIdFor('mock', 'x'));
  assert.notEqual(sessionIdFor('mock', 'a/b'), sessionIdFor('mock', 'a-b'), '非法字符替换不得碰撞');
  assert.notEqual(sessionIdFor('mock', 'oc_abc!@#'), sessionIdFor('mock', 'oc_abc'));
  // 编码可逆 → 不同 chatId 必然不同 id
  const samples = ['12345', '-12345', 'a b', 'a_b', 'a.b', 'a/b', 'oc_abc!@#', 'x', 'x-'];
  const ids = new Set(samples.map((c) => sessionIdFor('mock', c)));
  assert.equal(ids.size, samples.length, '任意两个 chatId 的 session id 必须不同');
});

test('chatKey / userKey / parseUserKey', () => {
  assert.equal(chatKey('telegram', '1'), 'telegram:1');
  const p = parseUserKey('feishu:user_a');
  assert.deepEqual(p, { platform: 'feishu', userId: 'user_a', key: 'feishu:user_a' });
  const p2 = parseUserKey('user_a', 'telegram');
  assert.deepEqual(p2, { platform: 'telegram', userId: 'user_a', key: 'telegram:user_a' });
});

test('映射：创建 / 反查 / 删除', () => {
  const map = new SessionMap(join(tmpdir(), 'im-test'));
  const binding = map.create('telegram', '111', { chatType: 'private' });
  assert.equal(map.get('telegram', '111'), binding);
  assert.equal(map.bySessionId(binding.sessionId), binding);
  assert.equal(map.size, 1);
  map.touch('telegram', '111', 'u1', 'Alice');
  assert.equal(binding.users.get('u1').name, 'Alice');
  assert.ok(map.isOnline('telegram', '111', 60_000));
  map.remove('telegram', '111');
  assert.equal(map.size, 0);
});

test('幂等去重（FR-1.4）：键含 chatId，跨聊天同号不误杀（round-7 F02）', () => {
  const map = new SessionMap(join(tmpdir(), 'im-test'));
  assert.ok(map.dedupe('telegram', 'chat-a', 'm1'));
  assert.ok(!map.dedupe('telegram', 'chat-a', 'm1'), '同聊天同号重复必须去重');
  assert.ok(map.dedupe('telegram', 'chat-b', 'm1'), '跨聊天同号不得误去重（平台消息号仅聊天内唯一）');
  assert.ok(map.dedupe('telegram', 'chat-a', 'm2'));
});

test('持久化：保存后新实例可恢复（UC6 断线恢复）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'im-map-'));
  const map = new SessionMap(dir);
  map.create('feishu', 'oc-1', { chatType: 'private' });
  map.addToAllowlist('feishu', 'user_a');
  map.addAdmin('feishu', 'user_a');
  await map.save();

  const map2 = new SessionMap(dir);
  await map2.load();
  assert.ok(map2.get('feishu', 'oc-1'));
  assert.equal(map2.bySessionId(sessionIdFor('feishu', 'oc-1')).chatId, 'oc-1');
  assert.ok(map2.isAllowed('feishu', 'user_a'));
  assert.ok(map2.isAdmin('feishu', 'user_a'));
});

test('allowlist 运行期追加持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'im-map-'));
  const map = new SessionMap(dir);
  map.addToAllowlist('telegram', 'u9');
  map._scheduleSave();
  await new Promise((r) => setTimeout(r, 600));
  const raw = JSON.parse(await readFile(join(dir, 'mappings.json'), 'utf8'));
  assert.ok(raw.allowlist.includes('telegram:u9'));
});

test('admin 隐式放行：只配 admins 不配 allowlist 也能通过 isAllowed', () => {
  const map = new SessionMap(join(tmpdir(), 'im-test'));
  map.addAdmin('feishu', 'owner');
  assert.ok(map.isAllowed('feishu', 'owner'), 'admin 应被隐式放行');
  assert.ok(map.isAdmin('feishu', 'owner'));
  assert.ok(!map.isAllowed('feishu', 'stranger'), '非 admin 非 allowlist 仍被拒绝');
});

// ── /new 回归：确定性 id 复用会与已持久化会话冲突 ──────────────────────────
//
// 症状：/new 永远回「命令执行失败：session "<id>" already exists」。
// 根因：sessionIdFor() 生成的 id 是确定性的，其会话日志已持久化在磁盘上；
//       即使旧 agent 已释放，再用同一 id 去 agents.create() 仍会命中
//       dsh-session 的 store.has() 检查而抛错。
// 修复：create() 支持显式 sessionId，/new 用带后缀的新 id。

test('/new 场景：create 支持显式 sessionId，且不再登记确定性 id', () => {
  const map = new SessionMap(join(tmpdir(), 'im-new-explicit'));
  const explicit = 'im-dingtalk-cid-abc123';
  const binding = map.create('dingtalk', 'cid', { chatType: 'private', sessionId: explicit });

  assert.equal(binding.sessionId, explicit, '必须使用显式传入的 sessionId');
  assert.equal(map.bySessionId(explicit), binding, '反查索引应指向该绑定');
  assert.ok(
    !map.bySessionId(sessionIdFor('dingtalk', 'cid')),
    '确定性 id 不应被登记——否则会与磁盘上的旧会话撞名',
  );
});

test('未传 sessionId 时仍保持确定性（重启不变，FR-2.2 不回归）', () => {
  const map = new SessionMap(join(tmpdir(), 'im-default-id'));
  const b = map.create('telegram', '999', { chatType: 'private' });
  assert.equal(b.sessionId, sessionIdFor('telegram', '999'));
});

test('/new 的新 id 会持久化：重启后映射指向最新会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'im-new-persist-'));
  const map = new SessionMap(dir);

  // 首次消息：确定性 id
  map.create('dingtalk', 'c1', { chatType: 'private' });
  assert.equal(map.get('dingtalk', 'c1').sessionId, sessionIdFor('dingtalk', 'c1'));

  // /new：移除旧绑定后，用新的显式 id 重建
  map.remove('dingtalk', 'c1');
  const fresh = 'im-dingtalk-c1-zz9';
  map.create('dingtalk', 'c1', { chatType: 'private', sessionId: fresh });
  await map.save();

  const map2 = new SessionMap(dir);
  await map2.load();
  assert.equal(
    map2.get('dingtalk', 'c1').sessionId,
    fresh,
    '重启后应 resume 到 /new 建的最新会话，而不是旧会话',
  );
});
