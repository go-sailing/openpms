/**
 * sandbox/index.ts — 工作目录约束与命令黑名单（SDD 4.3）
 *
 * 说明：本模块提供 OpenPMS 侧的校验实现；实际命令拦截通过 opencode 的
 * permission.bash 规则下发（见 runtime/opencode.ts），两者使用同一份规则集。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../platform/config.js';
import { badRequest } from '../platform/errors.js';

/** 默认命令黑名单（M1 内置启用，可配置追加） */
export const DEFAULT_COMMAND_BLACKLIST: { pattern: string; reason: string }[] = [
  { pattern: 'sudo', reason: '提权命令被禁止' },
  { pattern: 'su', reason: '提权命令被禁止' },
  { pattern: 'doas', reason: '提权命令被禁止' },
  { pattern: 'pkexec', reason: '提权命令被禁止' },
  { pattern: 'shutdown', reason: '电源/系统管理命令被禁止' },
  { pattern: 'reboot', reason: '电源/系统管理命令被禁止' },
  { pattern: 'halt', reason: '电源/系统管理命令被禁止' },
  { pattern: 'poweroff', reason: '电源/系统管理命令被禁止' },
  { pattern: 'systemctl', reason: '电源/系统管理命令被禁止' },
  { pattern: 'mkfs', reason: '磁盘格式化命令被禁止' },
  { pattern: 'fdisk', reason: '磁盘分区命令被禁止' },
  { pattern: 'parted', reason: '磁盘分区命令被禁止' },
  { pattern: 'wipefs', reason: '磁盘破坏命令被禁止' },
  { pattern: 'shred', reason: '磁盘破坏命令被禁止' },
  { pattern: 'dd', reason: '裸设备写入被禁止' },
  { pattern: 'rm -rf /', reason: '危险删除被禁止' },
  { pattern: 'rm -rf /*', reason: '危险删除被禁止' },
  { pattern: ':(){', reason: 'fork bomb 被禁止' },
  { pattern: 'kill -9 -1', reason: '大范围杀进程被禁止' },
  { pattern: 'killall', reason: '大范围杀进程被禁止' },
];

/**
 * 下载直执行模式：curl/wget 等下载命令通过管道直接交给解释器执行。
 * M1 只拦截该模式，不做网络完全封禁，以保证智能体能正常拉取依赖。
 */
const PIPE_EXEC_RE =
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b|\b(curl|wget|fetch)\b[^|]*\|\s*(python|python3|node|perl|ruby)\b/i;

function matches(cmd: string, rule: string): boolean {
  // 交互式/危险命令按子串匹配（命令名前后须为边界或空白）
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s;&|(])${escaped}([\\s;&|)]|$)`, 'i');
  return re.test(cmd);
}

export interface CommandCheck {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

export function checkCommand(command: string): CommandCheck {
  if (!config.commandBlacklistEnabled) return { allowed: true };
  const cmd = command.trim();
  if (!cmd) return { allowed: true };

  for (const w of config.commandWhitelist) {
    if (matches(cmd, w)) return { allowed: true };
  }
  if (PIPE_EXEC_RE.test(cmd)) {
    return { allowed: false, reason: '禁止下载内容直执行（如 curl|sh、wget|bash）', rule: 'pipe-exec' };
  }
  for (const rule of DEFAULT_COMMAND_BLACKLIST) {
    if (matches(cmd, rule.pattern)) {
      return { allowed: false, reason: rule.reason, rule: rule.pattern };
    }
  }
  for (const extra of config.commandBlacklistExtra) {
    if (matches(cmd, extra)) {
      return { allowed: false, reason: '命中自定义命令黑名单', rule: extra };
    }
  }
  return { allowed: true };
}

/** 生成给 opencode permission.bash 的规则表 */
export function bashPermissionRules(): Record<string, 'allow' | 'deny'> {
  const rules: Record<string, 'allow' | 'deny'> = {};
  if (!config.commandBlacklistEnabled) return { '*': 'allow' };
  for (const r of DEFAULT_COMMAND_BLACKLIST) {
    rules[`${r.pattern}*`] = 'deny';
  }
  for (const extra of config.commandBlacklistExtra) {
    rules[`${extra}*`] = 'deny';
  }
  for (const w of config.commandWhitelist) {
    rules[`${w}*`] = 'allow';
  }
  // 下载直执行管道模式：以通配形式下发（opencode permission 按模式匹配）
  for (const p of ['*| sh*', '*|sh*', '*| bash*', '*|bash*', '*| zsh*', '*| python*', '*| node*']) {
    rules[p] = 'deny';
  }
  rules['*'] = 'allow';
  return rules;
}

export interface WorkspaceCheck {
  path: string;
  realPath: string;
}

/**
 * 校验工作目录：必须存在、是目录，且（当配置了 workspaceRoots 时）位于允许的根目录之下。
 */
export function validateWorkspace(input: string): WorkspaceCheck {
  if (!input?.trim()) throw badRequest('WORKSPACE_INVALID', '工作目录必填');
  const abs = resolve(input);
  if (!existsSync(abs)) {
    throw badRequest('WORKSPACE_INVALID', `工作目录不存在: ${abs}`);
  }
  const real = realpathSync(abs);
  if (!statSync(real).isDirectory()) {
    throw badRequest('WORKSPACE_INVALID', `工作目录不是目录: ${real}`);
  }
  const roots = config.workspaceRoots;
  if (roots.length > 0) {
    const ok = roots.some((root) => {
      const r = realpathSync(resolve(root));
      return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
    });
    if (!ok) {
      throw badRequest(
        'WORKSPACE_INVALID',
        `工作目录不在允许的根目录内: ${real}（允许: ${roots.join(', ')}）`,
      );
    }
  }
  return { path: abs, realPath: real };
}

/** 判断路径是否位于工作目录内（用于审计与工具入参校验） */
export function isInsideWorkspace(workspace: string, target: string): boolean {
  const w = realpathSync(resolve(workspace));
  let t: string;
  try {
    t = realpathSync(resolve(target));
  } catch {
    t = resolve(target);
  }
  return t === w || t.startsWith(w.endsWith(sep) ? w : w + sep);
}
