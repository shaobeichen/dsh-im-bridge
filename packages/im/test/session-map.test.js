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
  // 非法字符净化（尾部的 - 被剥离）
  assert.match(sessionIdFor('feishu', 'oc_abc!@#'), /^im-feishu-oc_abc$/);
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

test('幂等去重（FR-1.4）', () => {
  const map = new SessionMap(join(tmpdir(), 'im-test'));
  assert.ok(map.dedupe('telegram', 'm1'));
  assert.ok(!map.dedupe('telegram', 'm1'));
  assert.ok(map.dedupe('telegram', 'm2'));
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
