// 跨平台 shell 执行器（demo 运行器的真实 shell 工具共用）
//
// - POSIX：/bin/bash -c
// - Windows：优先 pwsh（PowerShell 7，UTF-8 输出）；找不到则回退 powershell.exe
//   （Windows PowerShell 5.1，系统自带）。
//
// 运行器通过它执行工作区命令，避免硬编码 /bin/bash（Windows 上没有）。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** 平台主 shell 可执行文件名。 */
export function shellBinary() {
  return process.platform === 'win32' ? 'pwsh' : '/bin/bash';
}

/** 平台 shell 的命令行参数形式。 */
export function shellArgs(command) {
  return process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
}

/**
 * 在 shell 中执行一条命令，返回 stdout/stderr。
 * Windows 上 pwsh 缺失时自动回退 powershell.exe（ENOENT 才回退，其余错误原样抛出）。
 *
 * @param {string} command
 * @param {{cwd?: string, timeout?: number, maxBuffer?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runShell(command, opts = {}) {
  try {
    return await execFileP(shellBinary(), shellArgs(command), {
      timeout: opts.timeout ?? 60_000,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (process.platform === 'win32' && err?.code === 'ENOENT' && shellBinary() === 'pwsh') {
      // pwsh 未安装：回退系统自带的 Windows PowerShell 5.1
      return execFileP('powershell.exe', ['-NoProfile', '-Command', command], {
        timeout: opts.timeout ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    }
    throw err;
  }
}
