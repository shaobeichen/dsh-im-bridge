// 会话映射器（PRD FR-2）
//
// 私聊：platform+chatId → 一个 DSH SessionId（确定性生成，重启不变）
// 群聊：默认 platform+groupId → 共享 session（v1 完整实现；话题隔离 FR-8.5 预留）
// 持久化：mappings.json（原子写 tmp+rename，变更防抖），DSH 重启后聊天自动回到原 session。
//
// 本模块同时持久化运行期追加的 allowlist / admins（FR-9.2 信任确认的落点）。

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chatKey, sessionIdFor } from './message.js';

const STORE_VERSION = 1;

export class SessionMap {
  /**
   * @param {string} storeDir 持久化目录
   */
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.file = join(storeDir, 'mappings.json');
    /** @type {Map<string, ChatBinding>} key = `${platform}:${chatId}` */
    this.chats = new Map();
    /** @type {Map<string, string>} sessionId → key（反查） */
    this.bySession = new Map();
    /** 运行期追加的 allowlist 用户键（配置之外） */
    this.allowlist = new Set();
    /** 运行期追加的 admin 用户键（配置之外；admin 隐式放行） */
    this.admins = new Set();
    /** 最近处理过的消息 id（幂等去重，FR-1.4），Map 兼做 LRU */
    this.seen = new Map();
    this._saveTimer = null;
    this._saving = null;
  }

  /** 启动时加载（失败则从空开始，不阻断启动）。 */
  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data.version !== STORE_VERSION) return;
      for (const entry of data.chats ?? []) {
        const key = chatKey(entry.platform, entry.chatId);
        const binding = {
          platform: entry.platform,
          chatId: String(entry.chatId),
          chatType: entry.chatType ?? 'private',
          sessionId: entry.sessionId,
          createdAt: entry.createdAt ?? Date.now(),
          lastActivityAt: entry.lastActivityAt ?? 0,
          /** Map<userId, {name, lastActiveAt}> */
          users: new Map(),
        };
        for (const u of entry.users ?? []) {
          binding.users.set(String(u.userId), { name: u.name ?? '', lastActiveAt: u.lastActiveAt ?? 0 });
        }
        this.chats.set(key, binding);
        this.bySession.set(binding.sessionId, key);
      }
      for (const u of data.allowlist ?? []) this.allowlist.add(String(u));
      for (const u of data.admins ?? []) this.admins.add(String(u));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error(`[dsh-im] mappings.json load failed (starting fresh): ${err.message}`);
      }
    }
  }

  /** 找聊天绑定；无则 null。 */
  get(platform, chatId) {
    return this.chats.get(chatKey(platform, chatId)) ?? null;
  }

  /** 按会话 id 反查绑定。 */
  bySessionId(sessionId) {
    const key = this.bySession.get(sessionId);
    return key ? this.chats.get(key) ?? null : null;
  }

  /** 是否已有绑定。 */
  has(platform, chatId) {
    return this.chats.has(chatKey(platform, chatId));
  }

  /** 创建绑定（会话 id 确定性生成）。 */
  create(platform, chatId, { chatType = 'private' } = {}) {
    const key = chatKey(platform, chatId);
    const sessionId = sessionIdFor(platform, chatId);
    if (this.chats.has(key)) return this.chats.get(key);
    const binding = {
      platform,
      chatId: String(chatId),
      chatType,
      sessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      users: new Map(),
    };
    this.chats.set(key, binding);
    this.bySession.set(sessionId, key);
    this._scheduleSave();
    return binding;
  }

  /** 删除绑定。 */
  remove(platform, chatId) {
    const key = chatKey(platform, chatId);
    const binding = this.chats.get(key);
    if (!binding) return;
    this.chats.delete(key);
    this.bySession.delete(binding.sessionId);
    this._scheduleSave();
  }

  /** 记录活跃（FR-5.5 在线判定：最近 N 分钟发过消息）。 */
  touch(platform, chatId, userId, userName) {
    const binding = this.get(platform, chatId);
    if (!binding) return null;
    binding.lastActivityAt = Date.now();
    binding.users.set(String(userId), { name: userName ?? '', lastActiveAt: Date.now() });
    this._scheduleSave();
    return binding;
  }

  /** 在线判定：绑定存在且最近 windowMs 内有该聊天任一用户发过消息。 */
  isOnline(platform, chatId, windowMs) {
    const binding = this.get(platform, chatId);
    if (!binding) return false;
    return Date.now() - binding.lastActivityAt <= windowMs;
  }

  /** 会话总数（FR-2.4 maxSessions 上限用）。 */
  get size() {
    return this.chats.size;
  }

  /** 幂等去重：msgId 已处理过返回 false，否则记录并返回 true。 */
  dedupe(platform, msgId, limit = 1000) {
    if (!msgId) return true;
    const key = `${platform}:${msgId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    if (this.seen.size > limit) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** 是否放行：allowlist 成员，或 admins（管理员隐式放行，FR-8.2 注）。 */
  isAllowed(platform, userId) {
    const key = `${platform}:${userId}`;
    return this.allowlist.has(key) || this.admins.has(key);
  }

  addToAllowlist(platform, userId) {
    this.allowlist.add(`${platform}:${userId}`);
    this._scheduleSave();
  }

  removeFromAllowlist(platform, userId) {
    this.allowlist.delete(`${platform}:${userId}`);
    this._scheduleSave();
  }

  isAdmin(platform, userId) {
    return this.admins.has(`${platform}:${userId}`);
  }

  addAdmin(platform, userId) {
    this.admins.add(`${platform}:${userId}`);
    this._scheduleSave();
  }

  removeAdmin(platform, userId) {
    this.admins.delete(`${platform}:${userId}`);
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this.save();
    }, 500);
  }

  /** 原子写：tmp + rename（§8.4）。 */
  async save() {
    if (this._saving) return this._saving;
    this._saving = (async () => {
      await mkdir(this.storeDir, { recursive: true });
      const payload = {
        version: STORE_VERSION,
        chats: [...this.chats.values()].map((b) => ({
          platform: b.platform,
          chatId: b.chatId,
          chatType: b.chatType,
          sessionId: b.sessionId,
          createdAt: b.createdAt,
          lastActivityAt: b.lastActivityAt,
          users: [...b.users.entries()].map(([userId, u]) => ({ userId, name: u.name, lastActiveAt: u.lastActiveAt })),
        })),
        allowlist: [...this.allowlist],
        admins: [...this.admins],
      };
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await rename(tmp, this.file);
    })().finally(() => {
      this._saving = null;
    });
    return this._saving;
  }

  /** 序列化视图（/status 用）。 */
  list() {
    return [...this.chats.values()].map((b) => ({
      platform: b.platform,
      chatId: b.chatId,
      chatType: b.chatType,
      sessionId: b.sessionId,
      lastActivityAt: b.lastActivityAt,
      userCount: b.users.size,
    }));
  }

  async dispose() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.save();
  }
}

export { dirname };
