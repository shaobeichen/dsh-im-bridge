// 跨平台 shell 执行器测试（纯函数部分；runShell 的真实执行在 demo 集成层验证）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shellBinary, shellArgs } from './shell.mjs';

test('shellBinary：平台对应主 shell', () => {
  if (process.platform === 'win32') assert.equal(shellBinary(), 'pwsh');
  else assert.equal(shellBinary(), '/bin/bash');
});

test('shellArgs：POSIX 用 -c，Windows 用 -Command', () => {
  const args = shellArgs('echo hi');
  if (process.platform === 'win32') assert.deepEqual(args, ['-NoProfile', '-Command', 'echo hi']);
  else assert.deepEqual(args, ['-c', 'echo hi']);
});
