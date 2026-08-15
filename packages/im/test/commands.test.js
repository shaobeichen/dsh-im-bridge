import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, canRun, commands, registerCommand } from '../lib/commands.js';

test('解析 /cmd args', () => {
  assert.deepEqual(parseCommand('/new'), { name: 'new', args: [], raw: '/new' });
  assert.deepEqual(parseCommand('  /status  '), { name: 'status', args: [], raw: '/status' });
  assert.deepEqual(parseCommand('/approve a1b2 yes'), { name: 'approve', args: ['a1b2', 'yes'], raw: '/approve a1b2 yes' });
  assert.deepEqual(parseCommand('/resume abc-123'), { name: 'resume', args: ['abc-123'], raw: '/resume abc-123' });
});

test('解析群聊 @bot 后缀（Telegram）', () => {
  assert.deepEqual(parseCommand('/new@MyImBot'), { name: 'new', args: [], raw: '/new@MyImBot' });
  assert.deepEqual(parseCommand('/approve@MyImBot a1 yes'), { name: 'approve', args: ['a1', 'yes'], raw: '/approve@MyImBot a1 yes' });
});

test('普通文本不算命令', () => {
  assert.equal(parseCommand('跑一下 pytest'), null);
  assert.equal(parseCommand('1/2 的价格'), null);
  assert.equal(parseCommand(''), null);
});

test('权限分层（FR-4.2）：admin 命令需要 admin 身份', () => {
  const trustDef = { perm: 'admin' };
  const statusDef = { perm: 'user' };
  assert.ok(canRun(statusDef, { isAllowed: true, isAdmin: false }));
  assert.ok(!canRun(statusDef, { isAllowed: false, isAdmin: false }));
  assert.ok(canRun(trustDef, { isAllowed: true, isAdmin: true }));
  assert.ok(!canRun(trustDef, { isAllowed: true, isAdmin: false }));
});
