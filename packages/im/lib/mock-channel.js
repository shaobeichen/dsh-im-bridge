// MockChannel（PRD NFR-7：内置 Mock 适配器，支持无网络 e2e 测试）
//
// 不接任何真实平台：入站消息由测试（或用户脚本）调用 `sendFromUser()` 注入，
// 出站消息记录到 `sent[]`（可断言），按钮回调可模拟为 `pressButton()`。

import { chatKey } from './message.js';

export class MockChannel {
  constructor({ platform = 'mock', displayName = 'Mock Channel' } = {}) {
    this.platform = platform;
    this.displayName = displayName;
    this.sent = [];
    this.status = { connected: true, detail: 'mock: always connected' };
    this._runtime = null;
  }

  /** 由核心在 registerChannel 时注入。 */
  attach(runtime) {
    this._runtime = runtime;
  }

  /** 模拟用户发消息（测试入口）。 */
  sendFromUser({ chatId = 'chat-1', userId = 'user-1', userName = 'Tester', text, msgId, chatType = 'private', attachments } = {}) {
    if (!this._runtime) throw new Error('MockChannel not attached to a runtime');
    return this._runtime.dispatchInbound({
      platform: this.platform,
      chatId,
      userId,
      userName,
      text: text ?? '',
      msgId: msgId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chatType,
      attachments,
    });
  }

  /** 模拟用户点按钮。 */
  pressButton(data, { chatId, userId, userName } = {}) {
    if (!this._runtime) throw new Error('MockChannel not attached to a runtime');
    return this._runtime.handleCallback({
      platform: this.platform,
      chatId: chatId ?? 'chat-1',
      userId: userId ?? 'user-1',
      userName: userName ?? 'Tester',
      data,
    });
  }

  /** 渠道契约：send()。 */
  async send(out) {
    const messageId = `mock-${this.sent.length + 1}`;
    const record = { ...out, platform: this.platform, messageId, at: Date.now() };
    this.sent.push(record);
    return { messageId };
  }

  /** 渠道契约：edit() —— 原地更新（替换记录内容，保留时间戳与 messageId）。 */
  async edit(messageId, out) {
    const idx = this.sent.findIndex((m) => m.messageId === messageId);
    if (idx < 0) return {};
    this.sent[idx] = { ...this.sent[idx], ...out, messageId, editedAt: Date.now() };
    return { messageId };
  }

  /** 测试断言辅助：发给某 chat 的所有消息文本。 */
  textsTo(chatId) {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }

  /** 测试断言辅助：发给某 chat 的带按钮消息。 */
  cardsTo(chatId) {
    return this.sent.filter((m) => m.chatId === chatId && m.buttons?.length);
  }

  reset() {
    this.sent = [];
  }
}

export { chatKey };
