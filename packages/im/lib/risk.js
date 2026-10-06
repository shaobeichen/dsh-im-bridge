// 风险规则（PRD FR-6.6 / §9 approvals.riskRules）
//
// 默认规则贴合真实工作流：npm install / rm -rf node_modules 等常规操作 = low，
// 不触发审批——避免「审批疲劳 → 用户关掉审批 → 反而更不安全」。

export const RISK_LEVELS = ['low', 'medium', 'high'];

/**
 * 风险级别比较：high > medium > low > none。
 * @param {'none'|'low'|'medium'|'high'} a
 * @param {'none'|'low'|'medium'|'high'} b
 */
export function riskAtLeast(a, b) {
  const rank = { none: 0, low: 1, medium: 2, high: 3 };
  return rank[a] >= rank[b];
}

/**
 * @typedef {Object} RiskRule
 * @property {string} tool  工具名（如 'tool-bash'）
 * @property {string} [args] 参数正则（对 arguments JSON 字符串匹配）
 * @property {'low'|'medium'|'high'} risk
 */

/** 默认规则（顺序敏感：先匹配先生效）。 */
export function defaultRiskRules() {
  return [
    // 常规低风险操作 → low，不触发审批（除非 autoApproveRisk=none 也仅对 high/medium ask）
    { tool: 'tool-bash', args: 'rm\\s+-rf\\s+[^|;&]*node_modules', risk: 'low' },
    { tool: 'tool-bash', args: '(npm|pnpm|yarn|bun)\\s+(install|ci|add|remove|update)', risk: 'low' },
    { tool: 'tool-bash', args: 'pip\\s+(install|uninstall)', risk: 'low' },
    { tool: 'tool-bash', args: 'git\\s+(pull|clone|fetch|checkout|merge)|git\\s+push\\s+(?!-f\\b|--force\\b)', risk: 'low' },
    // 高风险
    { tool: 'tool-bash', args: 'rm\\s+-rf\\s+[~/]|rm\\s+-rf\\s+\\*', risk: 'high' },
    { tool: 'tool-bash', args: 'rm\\s+-rf\\s+/(etc|usr|var|boot|home)', risk: 'high' },
    { tool: 'tool-bash', args: '(mkfs|fdisk|dd\\s+if=)', risk: 'high' },
    { tool: 'tool-bash', args: 'curl.*\\|\\s*(ba)?sh|wget.*\\|\\s*(ba)?sh', risk: 'high' },
    { tool: 'tool-bash', args: 'chmod\\s+-R\\s+777', risk: 'high' },
    { tool: 'tool-bash', args: 'sudo\\s+(rm\\s+-rf|shutdown|reboot|poweroff)', risk: 'high' },
    // 中风险
    { tool: 'tool-bash', args: 'rm\\s+-rf', risk: 'medium' },
    { tool: 'tool-bash', args: 'git\\s+push\\s+.*(--force|-f\\b)', risk: 'medium' },
    { tool: 'tool-bash', args: 'sudo', risk: 'medium' },
    { tool: 'tool-bash', args: 'kill\\s+-9', risk: 'medium' },
    { tool: 'tool-fs', args: 'remove', risk: 'medium' },
    { tool: 'tool-str-replace-editor', args: '', risk: 'medium' },
  ];
}

/**
 * 对一次工具调用评估风险级别。
 * @param {string} tool
 * @param {string} argsJson  原始 arguments JSON 字符串
 * @param {RiskRule[]} [rules]
 * @returns {'low'|'medium'|'high'}
 */
export function evaluateRisk(tool, argsJson, rules = defaultRiskRules()) {
  const haystack = argsJson ?? '';
  // 🔴 低风险白名单只对**单一命令**生效。
  //
  // 白名单规则（`npm install`、`rm -rf node_modules`…）故意排在前面，用于避免审批疲劳；
  // 但它们是**子串**匹配，于是复合命令会被降级：
  //   `npm install && rm -rf /` 命中 `npm install`(low) 就直接返回 low ⇒ 审批门对 low
  //   放行 ⇒ 危险命令**完全绕过审批**（round-n1 F02，已实测复现）。
  // 修法：检测到 shell 控制符（复合命令）时跳过 low 规则，让后面的 high/medium 规则接管；
  // 单一命令仍按原顺序取首个命中，白名单语义不变。
  const compound = /(&&|\|\||[;|`]|\$\(|\\n)/.test(haystack);
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (rule.risk === 'low' && compound) continue;
    if (rule.args) {
      let re;
      try {
        re = new RegExp(rule.args, 'i');
      } catch {
        continue;
      }
      if (!re.test(haystack)) continue;
    }
    return rule.risk;
  }
  return 'low';
}
