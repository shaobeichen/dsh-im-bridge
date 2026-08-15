// dsh-im-telegram 渠道适配器（PRD FR-1.2/1.3/1.4/1.5）
//
// 只做「Telegram Bot API ⇄ 统一模型」转换，不含业务逻辑：
//   - polling 长连接（getUpdates long-poll，NAT 友好，免公网）——FR-1.3
//   - 消息/按钮回调 → ImMessage / handleCallback
//   - 出站 sendMessage / sendDocument，内联按钮（审批卡片，FR-6.2）
//   - 断线指数退避 + 心跳（getMe）+ /status 可见的连接状态——FR-1.5
//
// 密钥：botToken 支持 "env:TELEGRAM_BOT_TOKEN" 引用（§9 配置原则：密钥不落明文）。

import z from '@deepseek-ai/schemastery';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const name = 'im-telegram';
const inject = ['im'];

/** Telegram Bot API 根地址（apiBase 可覆盖，用于代理/测试）。 */
const TELEGRAM_API = 'https://api.telegram.org';

const Config = z.object({
  token: z.string().default('env:TELEGRAM_BOT_TOKEN'),
  mode: z.union([z.const('polling'), z.const('webhook')]).default('polling'),
  pollIntervalMs: z.number().default(1000),
  webhookUrl: z.string().default(''),
  downloadDir: z.string().default(''),
  apiBase: z.string().default(TELEGRAM_API), // 测试/代理用；默认官方 API
});


/** 解析密钥引用：'env:NAME' → process.env.NAME；否则原样返回。 */
export function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const key = value.slice(4);
    const v = process.env[key];
    if (!v) return '';
    return v;
  }
  return value;
}

export function apply(ctx, config = {}) {
  const token = resolveSecret(config.token);
  const logger = ctx.logger?.(name) ?? console;
  const api = `${config.apiBase ?? TELEGRAM_API}/bot${token}`;
  const pollIntervalMs = config.pollIntervalMs ?? 1000;
  const downloadDir = config.downloadDir || join(tmpdir(), 'dsh-im-telegram');
  let running = false;
  let offset = 0;
  let retryDelay = 1000;
  let botUsername = '';
  let disposed = false;

  const channel = {
    platform: 'telegram',
    displayName: 'Telegram',
    status: {
      connected: false,
      detail: token ? 'starting' : 'missing token (botToken)',
    },
    send,
    sendFile,
    dispose: async () => {
      disposed = true;
      running = false;
    },
  };
  ctx.get('im').registerChannel(channel);

  if (!token) {
    logger.error('dsh-im-telegram: no bot token (set TELEGRAM_BOT_TOKEN or config token); channel stays disconnected');
    return () => channel.dispose();
  }

  // 启动：getMe 校验 token + 记录 bot 用户名（FR-9.3 就绪检查）
  void (async () => {
    try {
      const me = await apiGet('/getMe');
      botUsername = me?.result?.username ?? '';
      channel.status = { connected: true, detail: `@${botUsername}` };
      logger.info(`dsh-im-telegram: connected as @${botUsername}`);
    } catch (err) {
      channel.status = { connected: false, detail: `getMe failed: ${err.message}` };
      logger.error('dsh-im-telegram: %s', err.message);
      return;
    }
    if (config.mode === 'webhook') {
      await setupWebhook(config.webhookUrl);
    } else {
      running = true;
      void pollLoop();
    }
  })();

  return () => channel.dispose();

  // ── 出站 ────────────────────────────────────────────────────────────────

  async function send(out) {
    const chatId = out.chatId;
    if (out.attachments?.length) {
      for (const att of out.attachments) {
        if (att.kind === 'file' && att.text != null) {
          await sendDocument(chatId, att.name ?? 'output.txt', att.text, 'text/plain');
        }
      }
    }
    if (out.text) {
      const payload = {
        chat_id: chatId,
        text: out.text,
        disable_web_page_preview: true,
      };
      if (out.buttons?.length) {
        payload.reply_markup = {
          inline_keyboard: chunk(out.buttons, 2).map((row) => row.map((b) => ({
            text: b.label,
            callback_data: b.id,
          }))),
        };
      }
      if (out.silent) payload.disable_notification = true;
      const result = await apiPost('/sendMessage', payload);
      return { messageId: result?.result?.message_id ? String(result.result.message_id) : undefined };
    }
    return {};
  }

  async function sendFile(chatId, name, text, mime = 'text/plain') {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([text], { type: mime }), name);
    await apiPostForm('/sendDocument', form);
  }

  // ── 入站 polling ─────────────────────────────────────────────────────────

  async function pollLoop() {
    while (running && !disposed) {
      try {
        const updates = await apiGet('/getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: JSON.stringify(['message', 'callback_query']),
        });
        retryDelay = 1000; // 成功恢复
        channel.status = { connected: true, detail: botUsername ? `@${botUsername}` : 'polling' };
        for (const update of updates?.result ?? []) {
          offset = Math.max(offset, update.update_id + 1);
          try {
            await handleUpdate(update);
          } catch (err) {
            logger.warn('dsh-im-telegram: update %d failed: %s', update.update_id, err.message);
          }
        }
      } catch (err) {
        // FR-1.5 断线重连：指数退避（上限 30s）
        if (isFatal(err)) {
          channel.status = { connected: false, detail: `fatal: ${err.message}` };
          logger.error('dsh-im-telegram: fatal polling error, stopping: %s', err.message);
          running = false;
          return;
        }
        channel.status = { connected: false, detail: err.message };
        logger.warn('dsh-im-telegram: polling error: %s (retry in %dms)', err.message, retryDelay);
        await sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    }
  }

  async function handleUpdate(update) {
    const im = ctx.get('im');
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat = cq.message?.chat;
      await im.handleCallback({
        platform: 'telegram',
        chatId: chat ? String(chat.id) : String(cq.from.id),
        userId: String(cq.from.id),
        userName: displayName(cq.from),
        data: cq.data,
      });
      // 应答回调，消除按钮 loading
      await apiPost(`/answerCallbackQuery`, { callback_query_id: cq.id }).catch(() => {});
      return;
    }
    const msg = update.message;
    if (!msg) return;
    const attachments = [];
    if (msg.document) {
      attachments.push({ kind: 'file', ...(await resolveFile(msg.document)) });
    } else if (msg.photo?.length) {
      // 取最大尺寸的 photo
      const photo = msg.photo[msg.photo.length - 1];
      attachments.push({ kind: 'image', ...(await resolveFile(photo)) });
    }
    await im.dispatchInbound({
      platform: 'telegram',
      chatId: String(msg.chat.id),
      userId: String(msg.from.id),
      userName: displayName(msg.from),
      text: msg.text ?? msg.caption ?? '',
      msgId: String(msg.message_id),
      chatType: msg.chat.type === 'private' ? 'private' : 'group',
      attachments,
    });
  }

  /** 解析 Telegram file_id → 本地临时文件（FR-7.1 落盘路径）。 */
  async function resolveFile(file) {
    const fileInfo = await apiGet(`/getFile`, { file_id: file.file_id });
    const filePath = fileInfo?.result?.file_path;
    if (!filePath) return { name: file.file_name ?? 'file' };
    const resp = await fetch(`${config.apiBase ?? TELEGRAM_API}/file/bot${token}/${filePath}`);
    if (!resp.ok) throw new Error(`file download failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const tmpDir = await mkdtemp(join(downloadDir, ''));
    const localPath = join(tmpDir, file.file_name ?? filePath.split('/').pop() ?? 'file');
    await writeFile(localPath, buf);
    return { name: file.file_name ?? filePath.split('/').pop() ?? 'file', path: localPath, size: buf.length };
  }

  async function setupWebhook(url) {
    if (!url) {
      logger.error('dsh-im-telegram: mode=webhook requires webhookUrl');
      return;
    }
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    await apiPost('/setWebhook', { url, ...(secret ? { secret_token: secret } : {}) });
    channel.status = { connected: true, detail: `webhook ${url}` };
  }

  // ── HTTP 工具 ────────────────────────────────────────────────────────────

  async function apiGet(method, params) {
    const qs = new URLSearchParams(params ?? {});
    const resp = await fetch(`${api}${method}?${qs}`);
    return parseJson(resp, method);
  }

  async function apiPost(method, body) {
    const resp = await fetch(`${api}${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseJson(resp, method);
  }

  async function apiPostForm(method, form) {
    const resp = await fetch(`${api}${method}`, { method: 'POST', body: form });
    return parseJson(resp, method);
  }

  async function parseJson(resp, method) {
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.ok === false) {
      const desc = data?.description ?? data?.error ?? `HTTP ${resp.status}`;
      const code = data?.error_code ?? resp.status;
      const err = new Error(`Telegram ${method}: ${desc} (${code})`);
      err.code = code;
      throw err;
    }
    return data;
  }
}

/** 致命错误（token 无效/冲突）不再重试。 */
function isFatal(err) {
  const code = err?.code;
  // 401 无效 token；409 同一 token 被另一实例 polling（C4：token 单实例冲突提示）
  return code === 401 || code === 409 || code === 403;
}

function displayName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { name, inject, Config };
export default { name, inject, Config, apply };
// 兼容 `export default function` 形态的 cordis 加载器
export const plugin = { name, inject, Config, apply };
