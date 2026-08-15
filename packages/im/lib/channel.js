// 渠道适配器契约（PRD FR-1.2 / §8.3 扩展点）
//
// 一个渠道 adapter = 一个独立 cordis 插件包：
//   - inject: ['im']
//   - apply(ctx) 中调用 ctx.im.registerChannel(channel)
//   - 入站：收到平台消息后构造 ImMessage 并调用 ctx.im.dispatchInbound(msg)
//   - 出站：实现 send()；支持按钮回调的渠道还要把回调解析为
//     ctx.im.handleCallback({platform, chatId, userId, userName, data})
//
// adapter 不允许包含任何业务逻辑（会话映射/命令/通知/审批都在核心）。
//
// 契约由 validateAdapterContract 在 registerChannel 时强制校验（FR-9.4）：
// 不完整 = 启动即抛错，绝不静默。写新适配器前读 AGENTS.md 与
// docs/adapters-guide.md，并用 scripts/new-adapter.mjs 生成骨架。

/**
 * @typedef {Object} ImChannel
 * @property {string} platform   渠道标识（唯一）
 * @property {string} [displayName]
 * @property {string[]} [formats] 支持的消息格式（预留：'html' | 'markdown'）
 * @property {Object} [status]   连接状态快照：{connected:boolean, detail?:string, lastEventAt?:number}
 *                               lastEventAt = 最近收到事件的时间戳（可观测性：连接活着 ≠ 事件在流）
 * @property {(out: import('./message.js').OutboundMessage) => Promise<import('./message.js').OutboundResult>} send
 * @property {(messageId: string, out: import('./message.js').OutboundMessage) => Promise<import('./message.js').OutboundResult>} [edit]
 * @property {(chatId: string, name: string, text: string, mime?: string) => Promise<import('./message.js').OutboundResult>} [sendFile]
 *                                   按文件名+内容发送文档（/log 全量交付用，FR-3.4）
 * @property {() => Promise<void>|void} [dispose]  插件卸载时断开连接
 */

/** 硬性必需项；缺失即抛错。 */
const REQUIRED = ['platform', 'send'];

/**
 * 校验 adapter 契约。
 * - 硬性缺失 → throw（registerChannel 调用点会失败，FR-9.4 不兼容即报错）
 * - 建议缺失（lastEventAt 等）→ 返回 warnings，由调用方告警
 * @param {ImChannel} channel
 * @returns {{ ok: true, warnings: string[] }}
 */
export function validateAdapterContract(channel) {
  if (!channel || typeof channel !== 'object') {
    throw new Error('im: channel must be an object');
  }
  const warnings = [];
  const name = typeof channel.platform === 'string' && channel.platform ? channel.platform : '(unknown)';
  for (const key of REQUIRED) {
    if (typeof channel[key] !== 'function' && typeof channel[key] !== 'string') {
      throw new Error(`im: channel "${name}" missing required contract member "${key}"`);
    }
  }
  if (typeof channel.platform !== 'string' || !channel.platform) {
    throw new Error('im: channel.platform (string) is required');
  }
  if (typeof channel.send !== 'function') {
    throw new Error(`im: channel "${channel.platform}" must implement send()`);
  }
  // 状态快照：connected 必须存在；lastEventAt 强烈建议（可观测三件套之一）
  if (channel.status && typeof channel.status.connected !== 'boolean') {
    throw new Error(`im: channel "${channel.platform}" status.connected must be a boolean`);
  }
  if (channel.status && !('lastEventAt' in channel.status)) {
    warnings.push(`channel "${channel.platform}" status lacks lastEventAt (最近事件心跳)；收不到事件时将无法在 /status 暴露`);
  }
  if (channel.sendFile !== undefined && typeof channel.sendFile !== 'function') {
    throw new Error(`im: channel "${channel.platform}" sendFile must be a function`);
  }
  if (channel.dispose !== undefined && typeof channel.dispose !== 'function') {
    throw new Error(`im: channel "${channel.platform}" dispose must be a function`);
  }
  return { ok: true, warnings };
}

/** 兼容旧名（内部使用）。 */
export function validateChannel(channel) {
  const r = validateAdapterContract(channel);
  for (const w of r.warnings) {
    console.warn(`[im] ${w}`);
  }
}
