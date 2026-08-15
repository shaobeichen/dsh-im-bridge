// PathPolicy 单元测试（权限设计 L2 层）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PathPolicy } from './policy.js';

const HOME = homedir();

test('解析：~ 展开、相对基于 baseDir、.. 折叠', () => {
  const p = new PathPolicy({ baseDir: '/Users/x' });
  assert.equal(p.resolve('~/foo'), join(HOME, 'foo'));
  assert.equal(p.resolve('a/b'), '/Users/x/a/b');
  assert.equal(p.resolve('/etc/passwd'), '/etc/passwd');
  assert.equal(p.resolve('~/a/../b'), join(HOME, 'b'));
});

test('读文件：任意目录（含敏感路径）一律放行', () => {
  const p = new PathPolicy({});
  assert.equal(p.classify('/Users/x/project/main.py').action, 'allow');
  assert.equal(p.classify(p.resolve('~/.ssh/id_rsa')).action, 'allow');
  // 路径技巧也不能改变"读放行"
  assert.equal(p.classify(p.resolve('~/a/../.ssh/config')).action, 'allow');
});

test('写：无 writeRoots 时一律要审批', () => {
  const p = new PathPolicy({});
  assert.equal(p.classify('/Users/x/project/main.py', { op: 'write' }).action, 'ask');
});

test('写：writeRoots 内放行，外要审批（../ 折叠后判定）', () => {
  const p = new PathPolicy({ writeRoots: [join(HOME, 'im-workspace')] });
  assert.equal(p.classify(join(HOME, 'im-workspace', 'a.txt'), { op: 'write' }).action, 'allow');
  assert.equal(p.classify(join(HOME, 'im-workspace', 'sub', 'b.txt'), { op: 'write' }).action, 'allow');
  assert.equal(p.classify(join(HOME, 'Downloads', 'a.txt'), { op: 'write' }).action, 'ask');
  assert.equal(p.classify('/etc/passwd', { op: 'write' }).action, 'ask');
  // 工作根内但通过 ../ 逃出 → 折叠后判定为外 → ask
  assert.equal(p.classify(p.resolve('~/im-workspace/../.ssh/id_rsa'), { op: 'write' }).action, 'ask');
});

test('deny 黑名单：读写都硬拒绝', () => {
  const p = new PathPolicy({ deny: [/\.mp4$/i] });
  assert.equal(p.classify('/Users/x/a.mp4').action, 'deny');
  assert.equal(p.classify('/Users/x/a.mp4', { op: 'write' }).action, 'deny');
  assert.equal(p.classify('/Users/x/a.py').action, 'allow');
});
