// 路径策略（权限设计 L2 层）
//
// 用户确认的权限模型（开发模式）：
//   - 读文件：任意目录一律放行（读是低风险，用户自己机器自己负责）
//   - 写/编辑：在【工作根目录】（writeRoots）内 → 直接放行；
//              工作根目录外 → 需要审批（IM 审批卡片）
//   - deny 黑名单：硬拒绝（读写都不行，不给审批机会）
//
// 关键：在工具内部对【解析后的绝对路径】做判定（~/x/../.ssh 之类技巧逃不掉）。

import { homedir } from 'node:os';
import { join, resolve, isAbsolute, normalize, sep } from 'node:path';

export class PathPolicy {
  /**
   * @param {Object} opts
   * @param {string[]} [opts.writeRoots] 写操作免审批的根目录（绝对路径列表；空 = 所有写都要审批）
   * @param {RegExp[]} [opts.deny]       硬拒绝黑名单（读写都不行）
   * @param {string}   [opts.baseDir]    相对路径的基准目录（默认 HOME）
   */
  constructor({ writeRoots = [], deny = [], baseDir = homedir() } = {}) {
    this.writeRoots = writeRoots.map((r) => normalize(resolve(expand(r))));
    this.deny = deny;
    this.baseDir = baseDir;
  }

  /** 解析用户给的路径 → 规范化绝对路径（~ 展开、相对基于 baseDir、.. 折叠）。 */
  resolve(p) {
    const raw = String(p ?? '.').trim();
    const expanded = expand(raw);
    const abs = isAbsolute(expanded) ? expanded : resolve(this.baseDir, expanded);
    return normalize(abs);
  }

  /**
   * 权威判定。
   * @param {string} absPath 已解析的绝对路径
   * @param {object} [opts]
   * @param {'read'|'write'} [opts.op] 操作类型：read=一律放行；write=按 writeRoots 判定
   */
  classify(absPath, { op = 'read' } = {}) {
    const abs = normalize(absPath);
    // 1) 硬拒绝黑名单（读写都不行）
    for (const re of this.deny) {
      if (re.test(abs)) return { action: 'deny', reason: `路径命中黑名单：${abs}` };
    }
    // 2) 读：一律放行
    if (op === 'read') return { action: 'allow', reason: '' };
    // 3) 写：在工作根目录内放行，否则要审批
    const inside = this.writeRoots.some((root) => abs === root || abs.startsWith(root + sep));
    if (inside) return { action: 'allow', reason: '' };
    return { action: 'ask', reason: `写操作在工作根目录外，需要审批：${abs}` };
  }
}

function expand(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
