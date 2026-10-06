// dsh-im-dingtalk 渠道适配器（PRD FR-1.2/1.3/1.4/1.5）
//
// 只做「钉钉 Stream Mode ⇄ 统一模型」转换，不含业务逻辑：
//   - Stream 模式长连接（WebSocket，官方 SDK dingtalk-stream）——免公网，无需回调 URL（FR-1.3）
//   - 机器人消息 → ImMessage；卡片回调 → handleCallback
//   - 出站：优先 sessionWebhook（机器人回复），降级为企业机器人主动推送 API
//   - 断线由官方 SDK 自动重连；本适配器维护状态 + 最近事件心跳（可观测三件套）
//
// 密钥：clientId/clientSecret 支持 "env:DINGTALK_CLIENT_ID" 引用（规则 #6：密钥不落明文）。
// SDK 可注入（internals.sdk），测试用 stub，CI 不碰真实凭据（规则 #3）。

import z from '@deepseek-ai/schemastery';

const name = 'im-dingtalk';
const inject = ['im'];

/** 钉钉 Stream 消息 topic（官方常量，见 dingtalk-stream/dist/constants）。 */
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';
export const TOPIC_CARD = '/v1.0/card/instances/callback';

/**
 * 单条 markdown 消息的字节预算（含代码围栏与标题）。与 channel.maxMessageBytes 一致。
 * 🔴 必须是**模块作用域**常量：放进 apply() 内部时，一旦 apply 提前 return，
 * 该 const 会停留在 TDZ，之后调用 sendFile 抛 `Cannot access before initialization`
 * （实测踩过：/log 因此在无 webhook 场景外也整条失败）。
 */
const MAX_BYTES_FOR_CODE = 3000;

/**
 * 把**展示用**文件名缩短到 ≤ maxBytes UTF-8 字节（只影响标题显示，不影响正文）。
 *
 * 为什么需要：`/log` 的文件名含 `binding.sessionId`，长度不受限；标题本身要占用
 * 单条消息的字节预算，标题一旦膨胀到吃光预算，正文就被 `Math.max(1, …)` 钳成
 * 1 字节，最终整条仍会超限（round-5 发现 3）。
 * 缩短策略：保留**首尾**（可辨认是哪个会话），中间用 `…` 省略；按码点截断，
 * 不会切坏多字节字符。
 */
function shortenForDisplay(name, maxBytes) {
  const s = String(name ?? '');
  // 🔴 严格尊重传入上限：此前 `Math.max(8, …)` 会把 <8 的请求悄悄放大到 8，
  // 违反"结果不超过 maxBytes"的语义（round-6 P3）。
  const limit = Math.max(1, Math.floor(maxBytes));
  if (Buffer.byteLength(s, 'utf8') <= limit) return s;
  const ELLIPSIS = '…';
  const ellBytes = Buffer.byteLength(ELLIPSIS, 'utf8');
  if (limit <= ellBytes) {
    // 连省略号都放不下：尽量放进第一个码点；放不下就返回空串
    const first = [...s][0] ?? '';
    return Buffer.byteLength(first, 'utf8') <= limit ? first : '';
  }
  const chars = [...s];
  const head = [];
  const tail = [];
  let used = 0;
  const budget = limit - ellBytes;
  // 先各留一半预算，再从尾部补足
  for (const ch of chars) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget / 2) break;
    head.push(ch);
    used += n;
  }
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    tail.unshift(ch);
    used += n;
  }
  return `${head.join('')}${ELLIPSIS}${tail.join('')}`;
}

const Config = z.object({
  clientId: z.string().default('env:DINGTALK_CLIENT_ID'),
  clientSecret: z.string().default('env:DINGTALK_CLIENT_SECRET'),
  // 企业机器人主动推送（outbound 回退路径）；未配置时仅能通过 sessionWebhook 回复。
  // 实测：Stream 模式机器人的 robotCode 就是 Client ID（传 AgentId 会报 robotCode.notExsit）。
  robotCode: z.string().default('env:DINGTALK_ROBOT_CODE'),
  apiBase: z.string().default('https://api.dingtalk.com'), // 测试/代理用
  debug: z.boolean().default(false),
});

/** 解析密钥引用：'env:NAME' → process.env.NAME；否则原样返回。 */
export function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? '';
  }
  return value;
}

export function apply(ctx, config = {}, internals = {}) {
  const clientId = resolveSecret(config.clientId);
  const clientSecret = resolveSecret(config.clientSecret);
  // 主动推送的 robotCode：显式配置优先；未配置时回退为 clientId。
  // 实测（2026-10-05，真实企业应用）：Stream 机器人的 robotCode == Client ID；
  // 传 AgentId 会得到 invalidParameter.robotCode.notExsit。
  const robotCode = resolveSecret(config.robotCode) || clientId;
  const logger = ctx.logger?.(name) ?? console;
  const apiBase = config.apiBase ?? 'https://api.dingtalk.com';
  const fetchImpl = internals.fetchImpl ?? globalThis.fetch;
  let disposed = false;
  let client = null;
  // access_token 缓存（必须在 send() 首次可达前初始化，否则触发 TDZ）
  let cachedToken = { value: '', expiresAt: 0 };
  // chatId → sessionWebhook（机器人回复用，仅在该会话上下文中有效）
  const sessionWebhooks = new Map();
  // chatId → 钉钉 userId（主动推送时必须用 userId，不能用 conversationId）
  const chatUsers = new Map();

  const channel = {
    platform: 'dingtalk',
    displayName: '钉钉',
    // 单条消息字节上限（保守值）。实测：6546 字节的 markdown 消息会在约 5600
    // 字节处被钉钉截断，用户只看到「输出不完整」。核心据此按字节分段发送。
    maxMessageBytes: 3000,
    // 本渠道渲染不了内联按钮，会把 buttons 降级为正文命令。声明后核心在计算
    // 字节预算时会把这段降级文本一并算进去（否则最终正文仍可能超限被截断）。
    buttonsAsText: true,
    status: {
      connected: false,
      detail: clientId ? 'starting' : 'missing clientId (DINGTALK_CLIENT_ID)',
      lastEventAt: null, // 最近事件心跳（可观测三件套 #2）
    },
    send,
    sendFile,
    dispose: async () => {
      disposed = true;
      try {
        client?.disconnect();
      } catch {
        /* 断开失败不影响卸载 */
      }
    },
  };
  const registration = ctx.get('im').registerChannel(channel);

  if (!clientId || !clientSecret) {
    logger.error(
      'dsh-im-dingtalk: missing credentials — set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET; channel stays disconnected | 缺少凭据，通道保持断开',
    );
    return () => channel.dispose();
  }

  void start();

  return () => channel.dispose();

  // ── 连接（官方 SDK 薄封装） ───────────────────────────────────────────────

  async function start() {
    try {
      const { DWClient, TOPIC_ROBOT: robotTopic = TOPIC_ROBOT, TOPIC_CARD: cardTopic = TOPIC_CARD } = await loadSdk();
      client = createClient(DWClient, clientId, clientSecret);
      // ⚠️ 关键：机器人消息与卡片回调都是 CALLBACK 类型，不是 EVENT。
      // registerAllEventListener 只订阅 EVENT/*（topic:'*' 不含 CALLBACK），
      // 因此必须用 registerCallbackListener 显式注册 topic——否则连得上但永远收不到消息。
      // 依据：官方 Python SDK 对每个 callback handler 都会 push {type:'CALLBACK', topic}。
      client.registerCallbackListener(robotTopic, handleDownstream);
      client.registerCallbackListener(cardTopic, handleDownstream);
      client.registerAllEventListener(handleDownstream);
      await client.connect();
      channel.status = { ...channel.status, connected: true, detail: `stream:${clientId.slice(0, 8)}…${robotTopic}` };
      logger.info('dsh-im-dingtalk: stream connected | Stream 长连接已建立（已订阅 CALLBACK %s）', robotTopic);
    } catch (err) {
      channel.status = { ...channel.status, connected: false, detail: `connect failed: ${err.message}` };
      logger.error('dsh-im-dingtalk: connect failed | 连接失败: %s', err.message);
    }
  }

  /** 延后加载官方 SDK；internals.sdk 允许测试注入 stub（规则 #3）。 */
  async function loadSdk() {
    if (internals.sdk) return internals.sdk;
    return import('dingtalk-stream');
  }

  function createClient(DWClient, id, secret) {
    const c = new DWClient({
      clientId: id,
      clientSecret: secret,
      debug: config.debug ?? false,
      keepAlive: true,
    });
    // 不手动改 subscriptions：SDK 默认订阅 [type:'EVENT', topic:'*']（subscribe-all），
    // 已在真实环境验证可收到机器人消息与卡片回调。手动注入具体 topic 反而可能漏事件。
    return c;
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────

  /** Stream 下行事件统一入口（SDK 的 registerAllEventListener 回调）。 */
  function handleDownstream(downstream) {
    const topic = downstream?.headers?.topic;
    // 心跳：任何事件都更新（连接活着 ≠ 事件在流）
    channel.status = { ...channel.status, connected: true, lastEventAt: Date.now() };
    try {
      // 🔴 必须给这两个 Promise 接 `.catch`：外层 `try` 只能捕获**同步**抛错，
      // `void somePromise` 的异步 rejection 会成为未处理拒绝（可能让进程告警/退出）。
      // 核心 `_dispatch()` 现在会把投递失败转成异常，这条路径因此是可达的。
      if (topic === TOPIC_CARD) {
        void handleCardCallback(downstream).catch((err) => {
          logger.error('dsh-im-dingtalk: card callback failed | 卡片回调处理失败: %s', err?.message ?? err);
        });
      } else {
        void handleRobotMessage(downstream).catch((err) => {
          logger.error('dsh-im-dingtalk: robot message handling failed | 机器人消息处理失败: %s', err?.message ?? err);
        });
      }
    } catch (err) {
      logger.warn('dsh-im-dingtalk: downstream handler failed | 事件处理失败: %s', err.message);
    }
    // 立即 ACK，避免服务端 60s 重推
    return { status: 'SUCCESS' };
  }

  async function handleRobotMessage(downstream) {
    const data = parseJsonSafe(downstream?.data);
    if (!data) return;
    const msg = normalizeRobotMessage(data);
    // 学习 sessionWebhook（供后续主动回复）与真实 userId（供机器人 API 回推）
    if (msg.sessionWebhook) {
      sessionWebhooks.set(msg.chatId, { url: msg.sessionWebhook, expiresAt: msg.sessionWebhookExpiredTime });
    }
    if (msg.userId) chatUsers.set(msg.chatId, msg.userId);
    if (!msg.text && msg.attachments.length === 0) return;
    await ctx.get('im').dispatchInbound({
      platform: 'dingtalk',
      chatId: msg.chatId,
      userId: msg.userId,
      userName: msg.userName,
      text: msg.text,
      msgId: msg.msgId,
      chatType: msg.chatType,
      attachments: msg.attachments,
    });
  }

  async function handleCardCallback(downstream) {
    const data = parseJsonSafe(downstream?.data);
    if (!data) return;
    // 卡片回调载荷：{ userId, outTrackId, ... } 或按钮 value（见 parseCardCallback）
    const cb = parseCardCallback(data);
    if (!cb || !cb.data) return;
    await ctx.get('im').handleCallback({
      platform: 'dingtalk',
      chatId: cb.chatId,
      userId: cb.userId,
      userName: cb.userName,
      data: cb.data,
    });
    // 卡片回调需回执，否则客户端一直转圈
    try {
      const messageId = downstream?.headers?.messageId;
      if (messageId && typeof client?.socketCallBackResponse === 'function') {
        client.socketCallBackResponse(messageId, { status: 'SUCCESS' });
      }
    } catch (err) {
      logger.debug('dsh-im-dingtalk: card ack failed | 卡片回执失败: %s', err.message);
    }
  }

  // ── 出站 ──────────────────────────────────────────────────────────────────

  async function send(out) {
    const chatId = out.chatId;
    // 核心层会带上该会话已知的平台 userId（来自持久化会话映射）。
    // 机器人主动推送必须用它，不能用 conversationId（会 staffId.notExisted）。
    // 同时记进本适配器的内存映射，供后续同进程复用。
    if (out.userId) chatUsers.set(chatId, out.userId);
    if (out.attachments?.length) {
      for (const att of out.attachments) {
        if (att.kind === 'file' && att.text != null) {
          const r = await sendFile(chatId, att.name ?? 'output.txt', att.text);
          // 附件投递失败必须上报，不能静默丢弃（round-2 发现 4）
          if (r && r.failed) return r;
        }
      }
    }
    // 🔴 只有按钮、没有正文时不能直接 return：按钮在文本型渠道要靠正文呈现
    // （核心已把命令拼进 text；若 buttons 仍在，这里降级成命令文本作为兜底）。
    if (!out.text && !out.buttons?.length) return {};
    const text = withButtonsAsText(out);
    if (!text) return {};
    const result = await deliver(chatId, text, out);
    return result ?? {};
  }

  /**
   * 出站投递：优先 sessionWebhook（会话内回复，最简单）；
   * 无 webhook 或已过期时降级为企业机器人主动推送（需 robotCode）。
   *
   * 注意：sessionWebhook 是**会话级短期凭证**（几十分钟即失效）。一旦过期，
   * 回复只能走机器人主动推送——那条路径要求 userId。此前适配器只依赖入站学到的
   * 内存映射，重启后即丢失，于是降级路径拿 conversationId 当 userId 被平台拒绝，
   * 表现为「审批卡片、提问卡片都推不到 IM」且**没有明显报错**。
   */
  async function deliver(chatId, text, out) {
    const hook = sessionWebhooks.get(chatId);
    if (hook && (!hook.expiresAt || hook.expiresAt > Date.now())) {
      try {
        return await postJson(hook.url, buildWebhookBody(text, out));
      } catch (err) {
        logger.warn('dsh-im-dingtalk: sessionWebhook send failed, falling back | sessionWebhook 发送失败，降级: %s', err.message);
      }
    }
    // 最终降级：机器人主动推送。失败必须带平台错误码可见（规则 #5），
    // 并把失败**上报**给核心（`{failed:true}`），由核心决定 fail-closed。
    try {
      return await sendViaRobotApi(chatId, text, out);
    } catch (err) {
      logger.error(
        'dsh-im-dingtalk: robot API send failed | 机器人推送失败: %s (code=%s)',
        err.message,
        err.code ?? 'n/a',
      );
      return { failed: true, reason: err.code ?? 'robot-api-error', error: err.message };
    }
  }

  /** 单条 markdown 消息的字节预算（含代码围栏与标题）。与 channel.maxMessageBytes 一致。 */
  // 注：常量已提到模块作用域（见文件顶部 MAX_BYTES_FOR_CODE）——
  // 放在 apply() 内部会在「apply 提前 return」时停留在 TDZ，
  // 之后调用 sendFile 就会抛 `Cannot access before initialization`。

  /** 钉钉 sessionWebhook 请求体（markdown 以兼容换行与粗体）。 */
  function buildWebhookBody(text, out) {
    // 注意：text 已由 withButtonsAsText() 处理过按钮降级，这里**不能**再追加一次
    // （否则同一份按钮文案会出现两遍）。
    return {
      msgtype: 'markdown',
      markdown: { title: out.title ?? 'DeepSeek Harness', text },
    };
  }

  /** 企业机器人主动推送（oToMessages/batchSend）。
   *
   * ⚠️ 关键：`userIds` 必须传**钉钉 userId（senderStaffId）**，不能传 `conversationId`。
   * conversationId 是会话级不透明串，传给机器人 API 会得到 `staffId.notExisted`。
   * userId 优先取核心层下传的 `out.userId`（来自持久化会话映射），
   * 其次取本适配器入站学到的内存映射；两者都没有时**必须大声报错**——
   * 这里曾静默失败，导致审批卡片与提问卡片都推不到钉钉且无从察觉。
   */
  async function sendViaRobotApi(chatId, text, out) {
    if (!robotCode) {
      logger.error(
        'dsh-im-dingtalk: no sessionWebhook and no robotCode — cannot send | '
        + '无 sessionWebhook 且未配置 robotCode，消息发不出去（检查 DINGTALK_ROBOT_CODE）',
      );
      // 🔴 必须**上报失败**而不是返回空对象：核心据此决定是否 fail-closed。
      // 若这里静默返回 {}，调用方（如提问/审批应答者）会以为送达成功，
      // 于是记录一直停在 waiting —— 用户什么都没收到，agent 也永远等不到答案。
      return { failed: true, reason: 'no-robotCode' };
    }
    // 优先用核心下传的真实 userId（持久），退化到入站学到的内存映射
    const targetUserId = out.userId ?? chatUsers.get(chatId);
    if (!targetUserId || targetUserId === chatId) {
      // conversationId 当 userId 必被平台拒绝；明确报错而不是发一条注定的失败请求
      logger.error(
        'dsh-im-dingtalk: no platform userId for chat %s — cannot push. '
        + 'The sessionWebhook expired and chatId is a conversationId, not a userId. '
        + 'Ask the user to send any message so the mapping is relearned. | '
        + '该会话没有平台 userId，无法主动推送：sessionWebhook 已过期，而 chatId 是 conversationId。'
        + '让用户随便发一条消息即可重新学到映射。',
        chatId,
      );
      return { failed: true, reason: 'no-userId' };
    }
    const token = await getAccessToken();
    const body = {
      robotCode,
      userIds: [targetUserId],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: out.title ?? 'DeepSeek Harness', text: withButtonsAsText(out) }),
    };
    const resp = await postJson(`${apiBase}/v1.0/robot/oToMessages/batchSend`, body, token);
    // batchSend 即使 HTTP 200 也可能把目标放进 invalidStaffIdList —— 必须显式检查
    if (resp?.invalidStaffIdList?.length) {
      const err = new Error(
        `DingTalk rejected target userId "${targetUserId}" | 钉钉拒绝该 userId（invalidStaffIdList）`,
      );
      err.code = 'staffId.notExisted';
      throw err;
    }
    return { messageId: resp?.processQueryKey };
  }

  /**
   * 文件投递（`/log` 全量交付，FR-3.4）：钉钉 webhook 不支持直接 file 上传，
   * 故以 **`msgtype: 'text'` 纯文本消息**按 UTF-8 字节分段送出。
   *
   * 🔴 三条硬约束（round-2/3/5 发现）：
   * 1. **不得改写正文**：`/log` 的语义是"取全文"。此前按**字符**截断，
   *    还把 ``` 替换成 `` ` ` ` `` —— 交付的已不是原文。现在正文逐字节原样送出。
   * 2. **必须用纯 text，不要改回 markdown**：markdown 会解析正文里的 ``` / 链接 /
   *    表格，既可能被正文自身闭合导致渲染错乱，也会让原文在视觉上被改写；
   *    纯 text 不做任何解析，于是"逐字保真"与"可读"同时成立。
   *    （普通出站消息仍走 markdown —— 见 `buildWebhookBody`。）
   * 3. **无投递路径必须上报失败**：没有 sessionWebhook 时此前静默 `return {}`，
   *    调用方以为成功、用户却什么都没收到。
   */
  async function sendFile(chatId, fileName, text, mime = 'text/plain') {
    const hook = sessionWebhooks.get(chatId);
    if (!hook) {
      logger.error(
        'dsh-im-dingtalk: sendFile has no delivery path (no sessionWebhook) | '
        + '无 sessionWebhook，文件/全文无法投递（请让用户先发一条消息以刷新 webhook）',
      );
      return { failed: true, reason: 'no-delivery-path' };
    }
    // 🔴 必须像 deliver() 一样检查过期：sessionWebhook 是**会话级短期凭证**，
    // 过期后仍向旧 URL 投递会失败，而 /log 是用户唯一的"取全文"入口
    // （round-6 P2）。过期就直接如实上报，让用户刷新会话后重试。
    if (hook.expiresAt && hook.expiresAt <= Date.now()) {
      logger.error(
        'dsh-im-dingtalk: sendFile sessionWebhook expired | '
        + 'sessionWebhook 已过期，全文无法投递（让用户随便发一条消息即可刷新）',
      );
      return { failed: true, reason: 'webhook-expired' };
    }
    try {
      const raw = String(text ?? '');
      // 🔴 标题（含文件名）本身会占用单条预算：文件名带 sessionId 时可能很长。
      // 若标题膨胀到吃光预算，`Math.max(1, ...)` 会把正文钳成 1 字节，最终仍超限
      // （round-5 发现 3）。这里对**展示用**文件名做无损缩短（只影响显示，不影响正文）。
      const header = `📎 ${shortenForDisplay(fileName, MAX_BYTES_FOR_CODE / 3)}`;
      const headerBytes = Buffer.byteLength(header, 'utf8');
      // 序号 ` (i/n)\n\n` 的字节数 = 1+1+d_i+1+d_n+1 + 2（换行） = d_i+d_n+6，
      // 最坏取同位数 2d+6。固定 8 字节在 10 段以上就不够（round-4 发现 2）。
      let reserve = 8;
      const splitWith = (r) => splitByBytesLossless(raw, Math.max(1, MAX_BYTES_FOR_CODE - headerBytes - r));
      let parts = splitWith(reserve);
      for (let attempt = 0; attempt < 3; attempt++) {
        const need = String(parts.length).length * 2 + 6;
        if (need <= reserve) break;
        reserve = need;
        parts = splitWith(reserve);
      }
      for (let i = 0; i < parts.length; i++) {
        const seq = parts.length > 1 ? ` (${i + 1}/${parts.length})` : '';
        // 🔴 用 `msgtype: 'text'` 而不是 markdown：/log 的语义是"取全文"，
        // 既要**逐字节保真**（不能改写 ``` 或加缩进），又要**可读**。
        // markdown 会解析正文里的 ``` / 链接 / 表格，既可能被正文自身闭合导致
        // 渲染错乱，也会让原文在视觉上被改写；纯 text 不做任何解析，
        // 两个目标同时满足（round-3 发现）。
        await postJson(hook.url, {
          msgtype: 'text',
          text: { content: `${header}${seq}\n\n${parts[i]}` },
        });
      }
      return {};
    } catch (err) {
      logger.error('dsh-im-dingtalk: sendFile failed | 文件发送失败: %s', err.message);
      return { failed: true, reason: 'sendFile-error', error: err.message };
    }
  }

  /**
   * 按 UTF-8 字节切分且**逐字节无损**（`parts.join('') === text`）。
   * 与核心 `renderer.splitByBytes` 同语义；适配器不依赖核心包，故本地实现一份。
   * 行尾 `\n` 归属该行，保证拼接可还原。
   */
  function splitByBytesLossless(text, maxBytes) {
    const s = String(text ?? '');
    if (!s) return [];
    const limit = Math.max(1, maxBytes);
    if (Buffer.byteLength(s, 'utf8') <= limit) return [s];
    const parts = [];
    let cur = '';
    let curBytes = 0;
    for (const line of s.split(/(?<=\n)/)) {
      const lb = Buffer.byteLength(line, 'utf8');
      if (curBytes + lb <= limit) { cur += line; curBytes += lb; continue; }
      if (cur) { parts.push(cur); cur = ''; curBytes = 0; }
      if (lb <= limit) { cur = line; curBytes = lb; continue; }
      let piece = '';
      let pieceBytes = 0;
      for (const ch of line) {
        const cb = Buffer.byteLength(ch, 'utf8');
        if (piece && pieceBytes + cb > limit) { parts.push(piece); piece = ''; pieceBytes = 0; }
        piece += ch;
        pieceBytes += cb;
      }
      cur = piece;
      curBytes = pieceBytes;
    }
    if (cur) parts.push(cur);
    return parts.length ? parts : [s];
  }

  // ── 凭据 ──────────────────────────────────────────────────────────────────

  async function getAccessToken() {
    if (cachedToken.value && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    // 官方 token 端点用 appkey/appsecret（非 Bearer）
    const qs = new URLSearchParams({ appkey: clientId, appsecret: clientSecret });
    const resp = await fetchImpl(`https://oapi.dingtalk.com/gettoken?${qs}`);
    const data = await resp.json().catch(() => null);
    if (!data || data.errcode !== 0) {
      const err = new Error(`DingTalk gettoken failed: ${data?.errmsg ?? `HTTP ${resp.status}`} (${data?.errcode ?? resp.status})`);
      err.code = data?.errcode ?? resp.status;
      throw err;
    }
    cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 - 60_000 };
    return cachedToken.value;
  }

  async function postJson(url, body, token) {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-acs-dingtalk-access-token': token } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);
    // 钉钉 webhook 与 OpenAPI 的错误码字段不同，统一带码抛出（规则 #5 边界日志带平台错误码）
    const code = data?.errcode ?? data?.code;
    if (!resp.ok || (code !== undefined && code !== 0)) {
      const err = new Error(`DingTalk send failed: ${data?.errmsg ?? data?.message ?? `HTTP ${resp.status}`} (${code ?? resp.status})`);
      err.code = code ?? resp.status;
      throw err;
    }
    return data;
  }
}

// ── 纯函数（平台形状解析，无网络单测） ──────────────────────────────────────

/**
 * 规范化机器人消息 → 统一模型。
 * 钉钉字段：conversationId/conversationType/senderStaffId/senderNick/msgId/text.content/sessionWebhook。
 * @param {object} data Stream 下行 data（已 JSON.parse）
 */
export function normalizeRobotMessage(data) {
  const conversationType = data.conversationType === '2' ? 'group' : 'private';
  const chatId = data.conversationId ?? data.senderStaffId ?? data.senderId ?? '';
  const attachments = [];
  if (data.msgtype === 'picture' && data.content?.downloadCode) {
    attachments.push({ kind: 'image', name: 'image', path: '' });
  } else if (data.msgtype === 'file' && data.content?.downloadCode) {
    attachments.push({ kind: 'file', name: data.content.fileName ?? 'file', path: '' });
  }
  return {
    platform: 'dingtalk',
    chatId: String(chatId),
    userId: String(data.senderStaffId ?? data.senderId ?? chatId),
    userName: data.senderNick ?? String(data.senderStaffId ?? ''),
    text: parseContent(data.msgtype, data),
    msgId: data.msgId ? String(data.msgId) : undefined,
    chatType: conversationType,
    attachments,
    sessionWebhook: data.sessionWebhook ?? '',
    sessionWebhookExpiredTime: data.sessionWebhookExpiredTime ?? 0,
  };
}

/**
 * 消息内容解析（纯函数，规则 #8）。
 * 支持 text / markdown / richText / picture / file；未知类型降级为空串。
 * @param {string} msgType
 * @param {object} msg 原始消息对象
 */
export function parseContent(msgType, msg) {
  if (!msgType) return '';
  switch (msgType) {
    case 'text':
      return stripAt(String(msg.text?.content ?? ''));
    case 'markdown':
      return stripAt(String(msg.markdown?.text ?? ''));
    case 'richText': {
      // richText 是段落数组，每段含 text/picture 等元素
      const parts = msg.content?.richText ?? [];
      return stripAt(
        parts
          .map((para) =>
            Array.isArray(para)
              ? para.map((el) => (el?.text != null ? String(el.text) : el?.type === 'picture' ? '[图片]' : '')).join('')
              : '',
          )
          .join('\n')
          .trim(),
      );
    }
    case 'picture':
      return '[图片]';
    case 'file':
      return `[文件] ${msg.content?.fileName ?? ''}`.trim();
    default:
      return '';
  }
}

/** 去掉钉钉 @机器人 留下的前导空白（@昵称 会被替换为空）。 */
export function stripAt(text) {
  return String(text ?? '').replace(/^[\s\u2005]+/, '').trim();
}

/**
 * 卡片回调 → 中性载荷。
 * 钉钉卡片回调把按钮 value 放在 data.content（JSON 字符串）里；核心约定 approve:<id>:yes|no。
 * @param {object} data Stream 下行 data
 * @returns {{userId:string,userName:string,chatId:string,data:string}|null}
 */
export function parseCardCallback(data) {
  if (!data) return null;
  let payload = data.content ?? data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      // 裸字符串也可能就是 data 载荷本身
      payload = { action: String(data.content) };
    }
  }
  // 按钮 value 形状：{ action: 'approve:xxx:yes' } 或 { data: 'approve:xxx:yes' }
  const raw = payload?.action ?? payload?.data ?? payload?.value ?? '';
  const action = typeof raw === 'string' ? raw : String(raw?.action ?? '');
  if (!action) return null;
  // 身份字段优先取外层 data（钉钉把操作人放在回调外层），再回退到按钮 value 内层。
  const userId = String(data.userId ?? payload?.userId ?? '');
  const userName = String(data.userName ?? data.nick ?? payload?.userName ?? payload?.nick ?? '');
  const chatId = String(data.conversationId ?? payload?.conversationId ?? data.userId ?? payload?.userId ?? '');
  return { userId, userName, chatId, data: action };
}

/**
 * 按钮 → 文本命令（钉钉 webhook 消息无内联按钮，降级为可复制的文本指令）。
 *
 * 优先用 `b.command`：钉钉 markdown 渲染不了按钮，只能降级为文字，而
 * `approve:abc123:yes` 这种原始 callback 载荷对用户毫无意义、也无法直接发送。
 * 核心为每个按钮提供可直接发送的友好命令（如 `/approve abc123 yes`）。
 *
 * 已在正文出现过的命令不再重复列出——提问卡片正文本身就带编号选项与
 * `/answer` 用法提示，再追加一遍只是噪音（钉钉上尤其明显）。
 */
export function buttonsAsCommands(buttons, text = '') {
  return buttons
    .filter((b) => !text.includes(b.command ?? b.id))
    .map((b) => `• ${b.label} → \`${b.command ?? b.id}\``)
    .join('\n');
}

/** 出站文本统一追加按钮文本（无按钮渠道的降级契约）。 */
function withButtonsAsText(out) {
  let text = out.text ?? '';
  if (out.buttons?.length) {
    const extra = buttonsAsCommands(out.buttons, text);
    if (extra) text += '\n\n' + extra;
  }
  return text;
}

function parseJsonSafe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

// 注：原先的 `truncate(text, max)` 已移除 —— 它按**字符**截断（中文 3 字节/字），
// 且截断提示写着「用 /log 获取全文」，而 `/log` 正是调用它的那条路径（自我指涉，
// 永远拿不到全文）。现改为 sendFile 内按字节分段发完全部内容。

export { name, inject, Config };
export default { name, inject, Config, apply };
export const plugin = { name, inject, Config, apply };