// 公网隧道（cloudflared quick tunnel）
//
// 企微回调必须公网 HTTPS，本脚本把 localhost:8787 暴露成 https://xxx.trycloudflare.com。
//
// 用法：
//   node demo/tunnel.mjs            只启动隧道（指向 localhost:8787），打印公网 URL
//   node demo/tunnel.mjs --backend  同时在本机 8787 起一个占位服务器（验证隧道连通）
//
// 说明：
//   - 隧道进程要一直开着（和企微桥一起）；关了地址就失效，且每次重启地址会变
//   - 拿到地址后去企微后台「接收消息」填：https://<地址>/wecom
//   - 地址验证：curl https://<地址>/wecom 应返回 200

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLOUDFLARED = process.env.CLOUDFLARED_BIN ?? join(root, '.bin', 'cloudflared');
const BACKEND = process.argv.includes('--backend');
const PORT = Number(process.env.TUNNEL_PORT ?? 8787);

// 占位后端：验证隧道连通用（真实运行时被 wecom-real 替换）
if (BACKEND) {
  createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('tunnel-ok');
  }).listen(PORT, () => console.log(`[backend] localhost:${PORT} 占位服务器已起（tunnel-ok）`));
}

const proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let printedUrl = false;
const onLine = (line) => {
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !printedUrl) {
    printedUrl = true;
    console.log('\n' + '='.repeat(60));
    console.log('  ✅ 公网隧道已就绪：');
    console.log('  ' + m[0]);
    console.log('');
    console.log(`  企微后台「接收消息」回调 URL 填：${m[0]}/wecom`);
    console.log('  隧道进程请保持运行；关闭后地址失效且会变更。');
    console.log('  Ctrl+C 退出。');
    console.log('='.repeat(60));
  }
};
proc.stdout.on('data', (d) => String(d).split('\n').forEach(onLine));
proc.stderr.on('data', (d) => String(d).split('\n').forEach(onLine));
proc.on('exit', (code) => {
  console.log(`[tunnel] cloudflared 退出（code=${code}）`);
  process.exit(code ?? 1);
});

process.on('SIGINT', () => {
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
});
