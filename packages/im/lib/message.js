// dsh-im 统一消息模型（PRD FR-1.1 / §8.1）
//
// 所有渠道 adapter 只做「平台协议 ⇄ 这个统一模型」的转换，不含业务逻辑。
// 入站消息由 adapter 构造 ImMessage 后交给 ctx.im.dispatchInbound()；
// 出站消息由核心构造 OutboundMessage 后交给对应渠道的 send()。

/**
 * 入站消息（IM → agent）。
 * @typedef {Object} ImMessage
 * @property {string} platform    渠道标识（'telegram' | 'feishu' | 'mock' ...）
 * @property {string} chatId      聊天标识（私聊=用户 id；群聊=群 id）
 * @property {string} userId      发送者平台 id
 * @property {string} [userName]  发送者昵称（群聊必备，FR-8.1）
 * @property {string} text        文本内容
 * @property {string} [msgId]     平台消息 id（幂等去重，FR-1.4）
 * @property {'private'|'group'} [chatType] 聊天类型，默认 'private'
 * @property {Array<{kind:'image'|'file', url?:string, path?:string, name?:string, size?:number}>} [attachments]
 * @property {string} [replyTo]   回复的消息 id（预留：群聊话题隔离 FR-8.5）
 */

/**
 * 出站消息（agent → IM）。
 * @typedef {Object} OutboundMessage
 * @property {string} chatId         目标聊天
 * @property {string} text           文本（核心渲染器已转纯文本）
 * @property {Array<{id:string, label:string, style?:'primary'|'danger'|'default'}>} [buttons]
 *                                    内联按钮；id 为不透明回调载荷（审批用 'approve:<id>:yes' 等）
 * @property {string} [title]        卡片标题（有按钮或流式卡片时使用；适配器可忽略）
 * @property {boolean} [stream]      流式增量帧：渠道支持 edit() 时应渲染为可原地更新的
 *                                    消息（如飞书交互卡片），并在 send 结果中返回 messageId；
 *                                    不支持 edit() 的渠道按普通文本发送即可
 * @property {Array<{kind:'file'|'image', name?:string, text?:string, path?:string}>} [attachments]
 *                                    文件/图片（/log 全量交付，FR-3.4）
 * @property {boolean} [silent]       静默推送（通知可选）
 */

/**
 * 出站结果。
 * @typedef {Object} OutboundResult
 * @property {string} [messageId]  平台消息 id（供 edit 使用；渠道必须返回真实 id，
 *                                 否则核心无法原地更新流式消息）
 */

/** 聊天标识（平台+chatId 的唯一键）。 */
export function chatKey(platform, chatId) {
  return `${platform}:${chatId}`;
}

/** 用户标识（平台+userId 的唯一键，对应配置 allowlist 条目）。 */
export function userKey(platform, userId) {
  return `${platform}:${userId}`;
}

/** 从配置条目解析用户键（容忍 "feishu:user_a" 或裸 userId + 平台参数）。 */
export function parseUserKey(raw, platform) {
  if (typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx > 0) {
    const p = raw.slice(0, idx);
    const u = raw.slice(idx + 1);
    if (p && u) return { platform: p, userId: u, key: raw };
  }
  if (platform) return { platform, userId: raw, key: `${platform}:${raw}` };
  return null;
}

/** 会话 id（chat 的确定性映射，保证重启后不变，FR-2.2）。 */
export function sessionIdFor(platform, chatId) {
  const safe = String(chatId).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return `im-${platform}-${safe || 'chat'}`;
}

/** 简单事件总线：核心内部模块间解耦用，避免引入多余依赖。 */
export class MiniBus {
  constructor() {
    this.listeners = new Map();
  }
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }
  emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[dsh-im] listener "${type}" failed:`, err);
      }
    }
  }
}
