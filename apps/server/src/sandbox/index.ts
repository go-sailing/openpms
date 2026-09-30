/**
 * sandbox/index.ts — 工作目录校验（SDD 4.3）
 *
 * 说明：任务执行前校验工作目录（存在、是目录、位于允许根目录之下），这是 OpenPMS 侧
 * **唯一的执行前边界检查**。harness 原生工具（文件读写、命令、网络）由各底座自身提供，
 * OpenPMS 不做裁剪、也不在执行期拦截命令；目录内约束通过 System Prompt 提示模型自律。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../platform/config.js';
import { badRequest } from '../platform/errors.js';

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
