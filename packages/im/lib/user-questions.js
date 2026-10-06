// 用户提问应答者（user-questions answerer，PRD 扩展）
//
// 背景：DSH 的 `ask_user_question` 工具通过 `ctx.userQuestions` 这个「能力接缝」
// 提问，由**调用方提供应答 UI**。GUI 有 dsh-client-ui-user-questions 弹选择框；
// 而 IM 渠道此前没有任何应答者，于是 waterfall 落到 noAnswerer，抛：
//     UserQuestionError: no user-questions answerer accepted the request (NO_PROVIDER)
// 表现就是「agent 在钉钉里提问，用户什么都看不到，任务直接失败」。
//
// 本模块把提问转成 IM 消息（选项做成按钮，复用审批卡片那套回调机制），
// 等用户在 IM 里回答后把结果回传给 waterfall。
//
// 应答通道与审批一致：
//   1) 按钮回调 → adapter → ctx.im.handleCallback({ data: 'q:<id>:<idx>' })
//   2) 文字命令 → /answer <id> <编号，逗号分隔>   （按钮不可用时的降级路径）

/** 用户提问的应答状态。 */
const STATE = {
  WAITING: 'waiting',
  ANSWERED: 'answered',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  CONTINUED: 'continued',
  UNAVAILABLE: 'unavailable',
};

export class UserQuestionAnswerer {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx
   * @param {object} deps.map   会话映射器（chatId → binding）
   * @param {(chat: {platform: string, chatId: string}, out: object) => Promise<any>} deps.send
   * @param {(line: string) => void} [deps.logLine]
   * @param {object} [deps.cfg] { enabled, timeoutSec }
   */
  constructor({ ctx, map, send, logLine, cfg = {} }) {
    this.ctx = ctx;
    this.map = map;
    this.send = send;
    this.logLine = logLine ?? (() => {});
    this.cfg = {
      enabled: cfg.enabled ?? true,
      // 0 = 无限等待（与 ask_user_question 的默认语义一致：默认等待）
      timeoutSec: cfg.timeoutSec ?? 0,
      // 🔴 发送阶段看门狗（新计轮 round-7 F04）：卡片推送挂起（send 既不
      // resolve 也不 reject）时 fail closed 的时限。默认 60s，与
      // approvals.js 的发送看门狗同口径。
      sendTimeoutSec: cfg.sendTimeoutSec ?? 60,
    };
    /** @type {Map<string, object>} questionId → record */
    this.records = new Map();
    /**
     * 已挂起（timed 超时）但仍可续答的提问，id → record。
     * DSH 的 `askTimed` 在前台等待超时后会以 `{pending:true}` 放行 agent，
     * 用户的迟答需要经 `userQuestions.answer(agent, callId, answers)` 送回
     * （user-questions/src/index.ts:165）。若此处直接删记录，迟答就永远找不到入口
     * —— round-2 发现 5。
     * @type {Map<string, object>}
     */
    this.continued = new Map();
    this._seq = 0;
    this._dispose = [];
  }

  /** 挂接 waterfall。注册即 effect（cordis 约定）。 */
  mount() {
    if (!this.cfg.enabled) {
      this.logLine('answerer NOT mounted: userQuestions.enabled=false');
      return;
    }
    this._dispose.push(
      // prepend: true 是关键。GUI 桥（api/remotes）也注册了
      // 'user-questions/request' waterfall 监听，把请求转发给浏览器。waterfall 中
      // **先返回者认领**、先注册者先执行——若 GUI 转发器排在前面，它会认领**所有**
      // 请求（含 IM 会话的），IM 应答者永远不被调用，表现就是「钉钉收不到选项」；
      // 而 GUI 侧等不到浏览器回应，几十秒后返回空答案（实测 46s + answers 全空）。
      // 故 IM 应答者必须 prepend：IM 会话自己应答，非 IM 会话 `next()` 委托回去，
      // GUI 行为不变。
      this.ctx.on('user-questions/request', (request, next) => this.answer(request, next), {
        prepend: true,
      }),
    );
    // 挂载即留痕：没有这条日志 = init() 没跑到这里（而非「请求没来」）。
    this.logLine('answerer mounted: listening on user-questions/request');
  }

  dispose() {
    for (const d of this._dispose.splice(0)) {
      try { d(); } catch { /* 卸载失败不影响其他 */ }
    }
    // 卸载时按应答契约（`{answers}`）结算，而不是把状态字符串当结果返回
    // （此前 `rec.resolve(STATE.CANCELLED)` 会把字符串 'cancelled' 交给调用方，
    // 破坏 `AskUserQuestionAnswer` 契约）；同时清掉计时器与 abort 监听，
    // 避免卸载后仍发超时消息或持有旧请求。
    for (const rec of [...this.records.values()]) {
      this._cleanup(rec);
      rec.state = STATE.CANCELLED;
      rec.resolve({ answers: [] });
    }
    this.records.clear();
    this.continued.clear();
  }

  /** 清理一条记录的计时器与 abort 监听（幂等）。 */
  _cleanup(rec) {
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    if (rec.onAbort && rec.signal?.removeEventListener) {
      rec.signal.removeEventListener('abort', rec.onAbort);
    }
    rec.onAbort = null;
  }

  /**
   * waterfall 监听：把提问发到 IM 并等待应答。
   * 不能应答时**必须**调用 next() 委托，不能吞掉请求。
   * @param {object} request AskUserQuestionRequestEvent
   * @param {() => Promise<object>} next
   */
  async answer(request, next) {
    const agent = request.agent ?? this.ctx.get('agents')?.currentInitiator?.();
    const sessionId = agent?.id ?? agent?.session?.id;
    const binding = sessionId ? this.map.bySessionId?.(sessionId) : null;
    // 诊断日志：确认监听是否被调用、binding 是否命中（排查「钉钉收不到提问」）
    this.logLine(
      `request received: session=${sessionId ?? '(none)'} questions=${request.questions?.length ?? 0} `
      + `binding=${binding ? `${binding.platform}:${binding.chatId.slice(0, 12)}…` : 'NONE→delegate'}`,
    );
    // 非 IM 会话（GUI/CLI 等）：交给别的应答者
    if (!binding) return next();

    const questions = request.questions ?? [];
    if (questions.length === 0) return next();

    const id = this._nextId();
    const record = this._createRecord(id, request, binding, questions);
    this.records.set(id, record);

    // 🔴 abort 监听必须在 `await this.send(...)` **之前**注册：
    // 若信号在发送期间就已 abort，之后再 addEventListener 不会补发事件，
    // 记录会永久停在 waiting（默认 timeoutSec=0 时无人能救），agent 侧也拿不到结果。
    //
    // 🔴 abort 必须 **reject**（抛错）而不是返回空答案：
    // DSH 的 `askTimed`（user-questions/src/index.ts:249-263）靠「signal.aborted ⇒
    // throw wait.signal.reason」把前台等待超时转成 `{pending:true}`，让用户稍后的答复
    // 经 `user-question-reply` 消息继续送达（continued 路径）。若我们在这里**成功**
    // 返回 `{answers:[]}`，DSH 会把它当成真实答案，late answer 通道随之关闭。
    // 非 timed 的 `ask()` 也会把 abort 转成 abortedQuestion，语义同样正确。
    const onAbort = () => {
      const err = new Error(
        request.wait?.timed
          ? 'ask_user_question timed out before the user answered'
          : 'user question aborted',
      );
      err.code = request.wait?.timed ? 'ASK_TIMED_OUT' : 'ABORTED';
      if (request.wait?.timed) {
        // timed：前台等待结束，但问题转为可续答（DSH 的 continued 语义）。
        // 保留记录，用户稍后作答时经 userQuestions.answer() 送回。
        this._continue(id, err);
        this.logLine(`question #${id} continued (前台超时，仍可作答)`);
      } else {
        this._fail(id, STATE.CANCELLED, err);
      }
    };
    record.signal = request.signal;
    record.onAbort = onAbort;
    request.signal?.addEventListener?.('abort', onAbort, { once: true });
    // 已经 abort 过（注册前就发生）→ 不要再推送卡片
    if (request.signal?.aborted) {
      onAbort();
      return record.promise;
    }

    // 🔴 卡片推送**不能 await**：若在这里 `await send`，waterfall 监听器本身就被
    // 卡在发送上，abort/取消只能等 send 返回后才被处理 —— 发送一旦挂起就是永久等待。
    // 改为「发起发送、立即返回 record.promise」，让 abort 能即时生效。
    //
    // 🔴 发送阶段看门狗（新计轮 round-7 F04）：send **挂起**（既不 resolve 也不
    // reject，如渠道栈卡死）时上面的 .catch 永远不会触发，而默认 timeoutSec=0
    // 又无 abort 救援——记录永久挂起：agent 任务卡死、会话卡死、用户连卡片
    // 都没收到。加独立超时：到期 fail closed（UNAVAILABLE + 空答案），让 agent
    // 得知投递失败自行决定；若渠道只是慢（卡片迟至送达），用户稍后作答会收到
    // "提问不存在"——可接受：明确知道投递失败好过无声地永久等待。
    // 发送成功（卡片已出）则清除看门狗，恢复"无限等待用户"语义。
    const card = this.renderCard(record);
    const sendTimeoutSec = Number(this.cfg.sendTimeoutSec);
    let sendWatchdog = null;
    if (Number.isFinite(sendTimeoutSec) && sendTimeoutSec > 0) {
      sendWatchdog = setTimeout(() => {
        sendWatchdog = null;
        this.logLine(`question ${id} push watchdog: send 挂起 ${sendTimeoutSec}s → fail closed`);
        this._settle(id, STATE.UNAVAILABLE, { answers: [] });
      }, Math.max(1, Math.round(sendTimeoutSec * 1000)));
      sendWatchdog.unref?.();
    }
    void this.send({ platform: binding.platform, chatId: binding.chatId }, card)
      .then(() => {
        if (sendWatchdog) { clearTimeout(sendWatchdog); sendWatchdog = null; }
      })
      .catch((err) => {
        if (sendWatchdog) { clearTimeout(sendWatchdog); sendWatchdog = null; }
        // 推送失败 → fail closed，不阻塞 agent
        this.logLine(`question ${id} push failed: ${err?.message ?? err}`);
        this._settle(id, STATE.UNAVAILABLE, { answers: [] });
      });

    if (this.cfg.timeoutSec > 0) {
      record.timer = setTimeout(() => {
        if (record.state !== STATE.WAITING) return;
        record.state = STATE.TIMEOUT;
        this.records.delete(id);
        void this.send(
          { platform: binding.platform, chatId: binding.chatId },
          { text: `⏰ 提问 #${id} 已超时（${this.cfg.timeoutSec}s），agent 将继续。` },
        ).catch(() => {});
        this._cleanup(record);
        record.resolve({ answers: [] });
      }, this.cfg.timeoutSec * 1000);
      record.timer.unref?.();
    }

    return record.promise;
  }

  _nextId() {
    // 短、可读、可手打（钉钉里要用户回复编号）。
    // 🔴 不能只用 `% 999` 回绕：回绕会复用**仍在等待**的 id，`records.set` 覆盖旧记录，
    // 旧 promise 永不结算，而旧卡片的按钮/文字命令会答到新问题上（串答）；旧 abort
    // 监听也会误取消新问题。改为单调递增，并在 id 被占用时跳过。
    for (let i = 0; i < 1000; i++) {
      this._seq += 1;
      const id = String(this._seq).padStart(2, '0');
      if (!this.records.has(id)) return id;
    }
    // 极端：1000 个并发等待。退化为带时间戳的唯一 id（仍可复制，只是长一些）。
    return `${this._seq + 1}x${Date.now().toString(36).slice(-4)}`;
  }

  _createRecord(id, request, binding, questions) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // 未处理的 rejection 不应让进程崩溃：调用方（waterfall 监听）一定会 await，
    // 但 dispose 等路径可能不再 await，这里兜一个空 catch。
    promise.catch(() => {});
    return {
      id,
      callId: request.wait?.callId ?? request.callId,
      // 保留 agent：DSH 继续协议 `userQuestions.answer(agent, callId, answers)` 需要它
      agent: request.agent,
      binding,
      questions,
      state: STATE.WAITING,
      /** 逐题草稿：qIndex → 已选标签[]。按钮应答按题累计，避免"点一题就结题"。 */
      draft: new Map(),
      /** 逐题**自由文本**草稿：qIndex → 文本。混合题型里文字题必须能单独作答。 */
      draftCustom: new Map(),
      resolve: (v) => {
        if (this.records.has(id)) this.records.delete(id);
        resolve(v);
      },
      reject: (e) => {
        if (this.records.has(id)) this.records.delete(id);
        reject(e);
      },
      promise,
    };
  }

  /** 渲染提问卡片：问题 + 编号选项 + 按钮（按钮 id 复用 handleCallback 的中性载荷）。 */
  renderCard(record) {
    const lines = [`❓ **需要你的确认**  #${record.id}`];
    const buttons = [];
    // 🔴 整卡题型判定（新计轮 round-6 F2）：必须在题目循环**之前**计算——
    // 混合卡（选项题+文字题）下，题目旁"请直接回复文字"的提示与实际行为
    // 矛盾（普通文字会被 dispatchTask 当新任务，答案不进草稿），必须引导
    // 显式 `/answer <id> text` 语法。
    const hasOptions = record.questions.some((q) => (q.options ?? []).length);
    const hasText = record.questions.some((q) => !(q.options ?? []).length);
    const mixed = hasOptions && hasText;

    record.questions.forEach((q, qi) => {
      if (record.questions.length > 1) lines.push('', `**${qi + 1}. ${q.question}**`);
      else lines.push('', q.question);
      if (q.header) lines.push(`_${q.header}_`);
      if (q.detail) lines.push(q.detail);
      if (q.multiSelect === true) lines.push('（可多选）');

      const opts = q.options ?? [];
      opts.forEach((o, oi) => {
        const n = oi + 1;
        // 编号按问题内序号；多问题时前缀问题序号，便于 /answer 手打
        const label = record.questions.length > 1 ? `${qi + 1}.${n}` : String(n);
        lines.push(`  ${label}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
        // 按钮载荷：q:<questionId>:<questionIndex>:<optionIndex>（适配器原样回传）
        // command 供渲染不了按钮的渠道（钉钉 markdown）降级为可直接发送的文字命令。
        buttons.push({
          id: `q:${record.id}:${qi}:${oi}`,
          label: `${label}. ${o.label}`.slice(0, 20),
          style: oi === 0 ? 'primary' : 'default',
          command: `/answer ${record.id} ${label}`,
        });
      });
      if (opts.length === 0) lines.push(mixed
        ? `  （无预设选项：请发 \`/answer ${record.id} text <内容>\` 作答——本卡为混合题型，直接回复文字会被当作新任务）`
        : '  （无预设选项，请直接回复文字）');
    });

    // 🔴 示例必须**从卡片实际题目派生**（新计轮 round-4 P2-1 → round-5 P2）：
    // ① 单选票卡**不得**出现"逗号分隔，如 1,3"——照抄会被 `n>1 && !multiSelect` 拒绝（invalid）；
    // ② 多题卡必须引导点号格式（裸编号在多题解析下全部映射第 1 题）；
    // ③ 示例的题号/选项号必须**真实存在**——硬编码 `1.2`/`1.2,1.3` 在第 1 题
    //    是文字题（越界 invalid）或单选（同题多 pick invalid）时误导用户。
    const isMultiQ = record.questions.length > 1;
    const firstOptQi = record.questions.findIndex((q) => (q.options ?? []).length > 0);
    // 第一个**有 ≥2 个选项**的多选题（逗号示例需要两个真实选项号）
    const firstMultiQi = record.questions.findIndex(
      (q) => q.multiSelect === true && (q.options ?? []).length >= 2,
    );
    const optExample = isMultiQ
      ? `${firstOptQi + 1}.1`
      : ((record.questions[firstOptQi]?.options ?? []).length >= 2 ? '2' : '1');
    const multiExample = firstMultiQi >= 0
      ? (isMultiQ
        ? `；多选逗号分隔，如 \`${firstMultiQi + 1}.1,${firstMultiQi + 1}.2\``
        : '；多选逗号分隔，如 `1,2`')
      : '';
    lines.push(
      '',
      hasOptions
        ? (isMultiQ
          ? `选项题：**直接回"题号.选项号"**（如 \`${optExample}\`${multiExample}），或发 \`/answer ${record.id} ${optExample}\`。`
          : `选项题：**直接回数字**即可（如 \`${optExample}\`${multiExample}），或发 \`/answer ${record.id} ${optExample}\`。`)
        : '',
      hasText
        ? (mixed
          // 混合题型：普通文字**不会**被自动当作答案（否则会吞掉你本想派的新任务），
          // 因此必须用显式语法 —— 卡片必须写清楚，不能只说"直接回复文字"
          ? `文字题：发 \`/answer ${record.id} text <内容>\`（混合题型下普通文字按新任务处理，不会被当作答案）。`
          : '文字题：**直接回复文字**即可（本卡片全部是文字题）。')
        : '',
      `不想选：回 \`skip\`（或 \`/answer ${record.id} skip\`），agent 会自行决定后继续。`,
      // 🔴 多选判定必须**优先于**多题分支（新计轮 round-2 P2-1）：多题卡里只要有一题
      // multiSelect，统一结题门（_mayAutoSettle）就禁止自动提交——旧版多题分支无条件
      // 写"答全会自动提交"，对含多选的卡是错误承诺：用户答完会停在 partial（操作无效）。
      // 🔴 口径与结题门一致（新计轮 round-3）：判定用 `=== true`（同 _hasMultiSelect）。
      // 🔴 示例同样从实际题目派生（round-5 P2）：硬编码 2.1,2.3 / 1,3 在
      // 多选题只有 1 个选项或位于其他题号时误导用户。
      record.questions.some((q) => q.multiSelect === true)
        ? (record.questions.length > 1
          ? `本卡含**多选题**：按钮可逐题点选，但选完**不会自动提交**——请发 \`/answer ${record.id} done\` 提交${firstMultiQi >= 0 ? `（多选编号用"题号.选项号"，如 \`${firstMultiQi + 1}.1,${firstMultiQi + 1}.2\`）` : '（多选编号用"题号.选项号"）'}`
          : `本卡含**多选题**：**不会自动提交**——选完请发 \`/answer ${record.id} done\` 提交（多选可一次逗号分隔${firstMultiQi >= 0 ? '，如 `1,2`' : ''}）。`)
        : record.questions.length > 1
          ? `按钮可逐题点选：答全会自动提交；也可发 \`/answer ${record.id} done\` 提前提交（未答的题按跳过）。`
          : '',
    );

    return { text: lines.join('\n'), buttons };
  }

  /**
   * 跳过提问：不选任何选项，让 agent 自行决定。
   *
   * 语义上等价于「用户未作答」——返回每问 `selected: []`。ask_user_question 的契约是
   * 「空选择 = 没拿到用户意见」，模型据此自行判断或改用默认方案继续，不会卡住。
   * （对比超时：超时也返回空答案，但用户明确 skip 更即时、意图更清楚。）
   * @param {string} questionId
   * @param {{platform?:string, chatId?:string}} [from] 应答来源；给出则校验归属
   * @returns {'skipped'|'not-found'|'forbidden'}
   */
  skip(questionId, from) {
    const rec = this._find(questionId);
    if (!rec) return 'not-found';
    if (from && !this._owns(rec, from)) return 'forbidden';
    const r = this._finish(
      rec,
      rec.questions.map((q) => ({ id: q.id, selected: [] })),
      { skipped: true },
    );
    return r === 'answered' ? 'skipped' : r;
  }

  /**
   * 用户应答（按钮回调 / 文字命令）。
   * @param {string} questionId
   * @param {Array<{qIndex:number, oIndex:number}>} picks
   * @param {string} [custom] 自定义文字
   * @param {{platform?:string, chatId?:string}} [from] 应答来源；给出则校验归属
   * @param {{allowPartial?:boolean}} [opts] `allowPartial`：允许只答一部分
   *        （**按钮路径**必须开：一次点击只携带一个 (q,o)，多问题卡片否则永远
   *        `invalid`、用户无法完成作答 —— round-2 发现 2）；文字命令路径则应答全，
   *        以便用户能明确表达"哪些题我不选"。
   * @returns {'answered'|'incomplete'|'partial'|'not-found'|'invalid'|'forbidden'}
   */
  respond(questionId, picks, custom, from, opts = {}) {
    const rec = this._find(questionId);
    if (!rec) return 'not-found';
    // 归属校验：只有提问所在会话才能作答（否则另一个聊天里的授权用户可跨会话代答）
    if (from && !this._owns(rec, from)) return 'forbidden';
    const err = this._merge(rec, { picks, text: custom });
    if (err) return err;
    // 文字命令路径要求答全才结算（用户能明确表达"哪些题不选"）；
    // 按钮路径（accumulate）才允许部分。
    // 🔴 区分"合法已记录未答全"与"非法输入"（新计轮 round-6 F1）：_merge 已
    // 原子写入——草稿已改变。此处若回 'invalid'，commandAnswer 会回执
    // "编号越界"，用户以为被拒而重答或只答其余题，之前已记录的选择会
    // 与新答案一起提交（状态与回执矛盾）。回 'partial'（已记录，可续答）；
    // 结算门（完整性 + 多选 done）不变，不会提前提交。
    if (!opts.allowPartial && !this._isComplete(rec)) return 'partial';
    // 🔴 含多选题的卡片**任何入口都不自动结题**（统一结题门，round-2 P1-1）：
    // 多选"已有一项"≠"选完了"。此前只堵了 accumulate，`/answer <id> 1` 在单题多选卡
    // 上仍一答即提交、第二项失效。多选卡必须显式 `done`（commitDraft）。
    if (!this._mayAutoSettle(rec)) return 'incomplete';
    const answers = this._answersFromDraft(rec);
    const unanswered = answers.filter((a) => a.selected.length === 0 && !a.custom).length;
    return this._finish(rec, answers, {
      picks: picks.length, custom: !!custom, ...(unanswered ? { unanswered } : {}),
    });
  }

  /**
   * 按钮应答：把本次选择**累计**进草稿，而不是立刻结题。
   *
   * 为什么必须累计（round-3 发现）：一次按钮点击只携带一个 (q,o)，若立刻结题，
   * 多问题卡片点第一题就会把其余题当成"空答案"提交，且余下按钮全部失效。
   * 累计后：答全 → 自动提交；未答全 → 保持等待并回报进度，用户可继续点，
   * 或发 `/answer <id> done` 提前提交（未答的题按跳过处理）。
   *
   * @returns {{status:string, answered?:number, total?:number, label?:string}}
   */
  accumulate(questionId, picks, from) {
    const rec = this._find(questionId);
    if (!rec) return { status: 'not-found' };
    if (from && !this._owns(rec, from)) return { status: 'forbidden' };
    const err = this._merge(rec, { picks });
    if (err) return { status: err };

    const optionQs = this._optionQs(rec);
    const answered = optionQs.filter((qi) => rec.draft.has(qi)).length;
    const lastQ = picks.length ? picks[picks.length - 1].qIndex : 0;
    const label = rec.draft.get(lastQ)?.join('、') ?? '';

    if (this._isComplete(rec) && this._mayAutoSettle(rec)) {
      const r = this._finish(rec, this._answersFromDraft(rec), { accumulated: true });
      return { status: r, answered, total: rec.questions.length, label };
    }
    // 未答全**或含多选题**：保持等待，回报进度（不是结题）
    this.logLine(`question #${rec.id} partial ${answered}/${optionQs.length} (${label})`);
    return {
      status: 'partial',
      answered,
      total: rec.questions.length,
      label,
      // 还有自由文本题没填 → 提示用户用显式语法作答
      needsText: this._textQs(rec).some((qi) => !rec.draftCustom.has(qi)),
      // 含多选题 → 按钮不自动结题，必须显式 done（否则第一次点击就提交，
      // 用户无法再选第二项 —— round-n1 F06）
      needsDone: this._hasMultiSelect(rec),
    };
  }

  /** 卡片里是否有多选题（多选题不能"点一下就自动提交"）。 */
  _hasMultiSelect(rec) {
    return rec.questions.some((q) => q.multiSelect === true);
  }

  /**
   * 统一结题门：这张卡片**允许**在答全后自动结算吗？
   * 🔴 三个作答入口（respond / accumulate / answerText）必须共用这一个判定
   * （round-2 P1-1：此前各入口各带各的条件，多选卡在 respond/answerText
   * 路径仍会提前结题）。含多选题 ⇒ 只能由 `done`（commitDraft）显式结算。
   */
  _mayAutoSettle(rec) {
    return !this._hasMultiSelect(rec);
  }

  /**
   * 自由文本作答：填入**第一道尚未作答的自由文本题**。
   *
   * 混合题型（部分题有选项、部分是自由文本）必须走这条路径才能完成：
   * 此前普通文字只会落进 `dispatchTask()` 变成新任务，卡片却写着"请直接回复文字"
   * —— 提示与实际行为矛盾（round-5 发现 1）。
   * @returns {{status:string, qi?:number, remainingText?:number}}
   */
  answerText(questionId, text, from) {
    const rec = this._find(questionId);
    if (!rec) return { status: 'not-found' };
    if (from && !this._owns(rec, from)) return { status: 'forbidden' };
    const textQs = this._textQs(rec);
    const target = textQs.find((qi) => !rec.draftCustom.has(qi));
    if (target === undefined) {
      // 没有文字题，或文字题都已作答
      return { status: 'invalid', reason: textQs.length === 0 ? 'no-text-question' : 'text-already-answered' };
    }
    const err = this._merge(rec, { text });
    if (err) return { status: err };

    const remainingText = this._textQs(rec).filter((qi) => !rec.draftCustom.has(qi)).length;
    if (this._isComplete(rec) && this._mayAutoSettle(rec)) {
      const r = this._finish(rec, this._answersFromDraft(rec), { text: true });
      return { status: r, qi: target, remainingText: 0 };
    }
    this.logLine(`question #${rec.id} text-filled q${target + 1}, remaining text=${remainingText}`);
    return { status: 'partial', qi: target, remainingText, needsDone: this._hasMultiSelect(rec) };
  }

  /** 用草稿（选项 + 自由文本）组装答案；未答的题保持空。 */
  _answersFromDraft(rec) {
    return rec.questions.map((q, qi) => {
      const item = { id: q.id, selected: rec.draft.get(qi) ?? [] };
      if (rec.draftCustom.has(qi)) item.custom = rec.draftCustom.get(qi);
      return item;
    });
  }

  /**
   * 提交草稿（`/answer <id> done`）：未答的题按跳过（空选择）处理。
   * @returns {'answered'|'not-found'|'forbidden'|'empty'}
   */
  commitDraft(questionId, from) {
    const rec = this._find(questionId);
    if (!rec) return 'not-found';
    if (from && !this._owns(rec, from)) return 'forbidden';
    if (rec.draft.size === 0 && rec.draftCustom.size === 0) return 'empty';
    return this._finish(rec, this._answersFromDraft(rec), { committed: true });
  }

  // ── 统一作答内核（覆盖 WAITING 与 CONTINUED 两种状态） ────────────────────
  //
  // 设计（round-6 重构）：此前「累计 / 文字 / 提交 / 跳过」各自实现一遍，于是
  // continued 状态被反复漏掉、命令路径与入站路径口径不一致。现在全部收敛到
  // `_find` → `_merge` → `_isComplete` → `_finish` 四个原语，
  // 任何入口都自动同时支持「等待中」与「已挂起可续答」。

  /** 取记录：等待中或已挂起可续答（continued）。 */
  _find(id) {
    return this.records.get(id) ?? this.continued.get(id) ?? null;
  }

  /** 有选项的题下标。 */
  _optionQs(rec) {
    return rec.questions.map((q, qi) => ((q.options ?? []).length ? qi : -1)).filter((qi) => qi >= 0);
  }

  /** 无选项（自由文本）的题下标。 */
  _textQs(rec) {
    return rec.questions.map((q, qi) => ((q.options ?? []).length ? -1 : qi)).filter((qi) => qi >= 0);
  }

  /**
   * 把本次作答合并进草稿（**不结算**）。
   * - 选项：单选**替换**该题已选，多选累加；越界返回 `invalid`
   * - 文字：填入**第一道尚未作答的自由文本题**；若整张卡片没有文字题，
   *   则把文字作为附言挂到**第一个已选中的题**上（保持 `/answer <id> 2 附言` 的旧语义）
   * @returns {string|null} 错误码；null 表示已合并
   */
  _merge(rec, { picks = [], text } = {}) {
    // 🔴 **先全量校验、再原子写入**：此前边校验边写，后面的 pick 越界时前面的选择
    // 已经落进草稿 —— 用户看到"被拒绝"，却已经改动了状态，之后可能带着这部分
    // 被拒绝的答案结题（round-n1 F04）。
    const perQ = new Map();
    for (const p of picks) {
      if (!Number.isInteger(p.qIndex) || p.qIndex < 0 || p.qIndex >= rec.questions.length) return 'invalid';
      const opts = rec.questions[p.qIndex].options ?? [];
      if (!Number.isInteger(p.oIndex) || p.oIndex < 0 || p.oIndex >= opts.length) return 'invalid';
      perQ.set(p.qIndex, (perQ.get(p.qIndex) ?? 0) + 1);
    }
    // 单选题目在同一次调用里给了多个选择 → 拒绝（`/answer 01 1,2` 应报错，
    // 不能静默"最后一个生效"）。按钮路径每次只带一个 pick，不受影响。
    for (const [qi, n] of perQ) {
      if (n > 1 && !rec.questions[qi].multiSelect) return 'invalid';
    }
    let textTarget;
    if (text != null) {
      const t = String(text).trim();
      if (!t) return 'invalid';
      const textQs = this._textQs(rec);
      if (textQs.length > 0) {
        textTarget = textQs.find((qi) => !rec.draftCustom.has(qi));
        if (textTarget === undefined) return 'invalid';
      } else {
        // 整张卡片没有文字题 → 文字作为**附言**挂在某个选项题上（`/answer <id> 2 附言` 的旧语义）。
        // 🔴 必须同时看本次 picks：原子化后"先校验后写入"，此时 draft 还没更新，
        // 只看 draft 会取不到目标而误报 invalid（自测踩到）。
        const fromPicks = picks.map((p) => p.qIndex).sort((a, b) => a - b)[0];
        const fromDraft = [...rec.draft.keys()].sort((a, b) => a - b)[0];
        textTarget = fromPicks ?? fromDraft;
        if (textTarget === undefined) return 'invalid';
      }
    }

    // —— 校验全过，开始写入 ——
    for (const p of picks) {
      const opts = rec.questions[p.qIndex].options ?? [];
      if (!rec.questions[p.qIndex].multiSelect) rec.draft.set(p.qIndex, []);
      if (!rec.draft.has(p.qIndex)) rec.draft.set(p.qIndex, []);
      const label = opts[p.oIndex].label;
      if (!rec.draft.get(p.qIndex).includes(label)) rec.draft.get(p.qIndex).push(label);
    }
    if (text != null && textTarget !== undefined) {
      rec.draftCustom.set(textTarget, String(text).trim());
    }
    return null;
  }

  /** 草稿是否已答全：有选项的题都有选择，自由文本题都有文字。 */
  _isComplete(rec) {
    return rec.questions.every((q, qi) => (
      (q.options ?? []).length ? rec.draft.has(qi) : rec.draftCustom.has(qi)
    ));
  }

  /**
   * 统一收尾：**等待中 → 结算**；**已挂起可续答 → 经 DSH 继续协议投递**。
   *
   * 继续协议要求答案批「每题恰好一次」（DSH `index.ts:178-185` 否则抛 BAD_ANSWER），
   * 而 `_answersFromDraft` 恒按 `rec.questions` 生成等长数组，满足该约束。
   * @returns {'answered'|'continued'|'no-continuation'|'delivery-error'}
   */
  _finish(rec, answers, extra) {
    if (rec.state !== STATE.CONTINUED) {
      this._settle(rec.id, STATE.ANSWERED, { answers }, extra);
      return 'answered';
    }
    const delivered = this.deliverContinued(rec, answers);
    if (delivered === 'delivered') {
      this.continued.delete(rec.id);
      return 'continued';
    }
    // 区分「本机没有继续服务」与「投递出错」——后者不是用户答案格式问题，
    // 统一报 invalid 会误导用户（round-6 P3）
    return delivered === 'unavailable' ? 'no-continuation' : 'delivery-error';
  }

  /** 该记录是否属于给定会话。 */
  _owns(rec, { platform, chatId }) {
    return rec.binding?.platform === platform && rec.binding?.chatId === chatId;
  }

  /**
   * timed 前台等待结束：reject 前台 promise（让 DSH 得到 `{pending:true}` 并放行 agent），
   * 但**记录转入 continued**，保留 callId/agent 供迟答转发。
   */
  _continue(id, error) {
    const rec = this.records.get(id);
    if (!rec || rec.state !== STATE.WAITING) return;
    rec.state = STATE.CONTINUED;
    this._cleanup(rec);
    this.records.delete(id);
    rec.reject(error);
    this.continued.set(id, rec);
    // 防无限增长：只保留最近 50 条
    if (this.continued.size > 50) {
      const oldest = this.continued.keys().next().value;
      this.continued.delete(oldest);
    }
  }

  /** 在「等待中」与「可续答」两处查找记录。 */
  findRecord(id) {
    return this.records.get(id) ?? this.continued.get(id) ?? null;
  }

  /**
   * 把迟答转交给 DSH 的继续协议（`userQuestions.answer`）。
   * @returns {'delivered'|'unavailable'|'error'}
   */
  deliverContinued(rec, answers) {
    const svc = this.ctx.get?.('userQuestions');
    if (!svc || typeof svc.answer !== 'function' || !rec.callId || !rec.agent) return 'unavailable';
    try {
      const ok = svc.answer(rec.agent, rec.callId, { answers });
      return ok ? 'delivered' : 'error';
    } catch (err) {
      this.logLine(`continued answer failed: ${err?.message ?? err}`);
      return 'error';
    }
  }

  _settle(id, state, value, extra) {
    const rec = this.records.get(id);
    if (!rec || rec.state !== STATE.WAITING) return;
    rec.state = state;
    this._cleanup(rec);
    this.records.delete(id);
    this.logLine(
      `question #${id} ${state}${extra ? ' ' + JSON.stringify(extra) : ''}`,
    );
    rec.resolve(value);
  }

  /**
   * 以**异常**结束（用于 abort：DSH 依赖异常区分「超时挂起/取消」与「用户真的答了空」）。
   * @param {string} id
   * @param {string} state
   * @param {Error} error
   */
  _fail(id, state, error) {
    const rec = this.records.get(id);
    if (!rec || rec.state !== STATE.WAITING) return;
    rec.state = state;
    this._cleanup(rec);
    this.records.delete(id);
    this.logLine(`question #${id} ${state} (${error.code ?? 'error'})`);
    rec.reject(error);
  }

  /** 该会话是否有待答提问（有则返回最近一个），供「直接回数字即作答」用。 */
  pendingFor(platform, chatId) {
    let found = null;
    for (const rec of this.records.values()) {
      if (rec.state !== STATE.WAITING) continue;
      if (rec.binding?.platform === platform && rec.binding?.chatId === chatId) found = rec;
    }
    return found;
  }

  /** 待回答的提问（/status 用）。 */
  pendingList() {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      count: r.questions.length,
      ageSec: Math.round((Date.now() - (r.createdAt ?? Date.now())) / 1000),
    }));
  }
}