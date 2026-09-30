/**
 * runtime/models.ts — 各 harness 底座的可用模型清单（SDD 4.1）
 *
 * 两个底座的能力不同，取材方式也不同：
 *   - opencode：提供 `opencode models` 子命令，直接调用它拉取**当前环境实际可用**的模型
 *     （含用户自行配置的 provider），输出的是一行一个 `provider/model`。
 *   - dsh：**没有列模型的命令**，只能使用其内置模型目录（与 `@deepseek-ai/dsh-llm-deepseek`
 *     的 `DEFAULT_MODELS` 对齐）；dsh 上游新增模型时需要同步这里的清单。
 *
 * 结果按底座缓存，避免每次打开智能体编辑页都拉起一次子进程。
 */
import { spawn } from 'node:child_process';
import type { HarnessKind } from '../platform/types.js';
import { resolveOpencodeBin } from './opencode.js';

export interface HarnessModels {
  kind: HarnessKind;
  models: string[];
  /** 清单来源：cli = 调用底座命令实时拉取；builtin = 底座内置目录 */
  source: 'cli' | 'builtin';
  /** 拉取失败等需要提示用户的说明 */
  note?: string;
}

/** dsh 内置模型目录（对应 dsh-llm-deepseek 的 DEFAULT_MODELS） */
const DSH_BUILTIN_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

/** 缓存 TTL：模型清单随底座配置变化，但不必每次都重新探测 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<HarnessKind, { at: number; value: HarnessModels }>();

/** 单次探测的超时（opencode 需要加载配置，给足时间但不无限等） */
const PROBE_TIMEOUT_MS = 30_000;

/** 探测 opencode 可用模型：`opencode models` 一行一个模型 */
function probeOpencodeModels(): Promise<HarnessModels> {
  const bin = resolveOpencodeBin();
  return new Promise<HarnessModels>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (value: HarnessModels): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(value);
    };

    const child = spawn(bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ kind: 'opencode', models: [], source: 'cli', note: `列出模型超时（${PROBE_TIMEOUT_MS / 1000}s）` });
    }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      done({ kind: 'opencode', models: [], source: 'cli', note: `无法启动 opencode：${err.message}` });
    });
    child.on('close', (code) => {
      const models = [
        ...new Set(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#')),
        ),
      ];
      if (models.length > 0) {
        done({ kind: 'opencode', models, source: 'cli' });
        return;
      }
      done({
        kind: 'opencode',
        models: [],
        source: 'cli',
        note: `opencode models 未返回模型（退出码 ${code}）${stderr.trim() ? `：${stderr.trim().slice(-200)}` : ''}`,
      });
    });
  });
}

/** 列出某底座的可用模型；结果带缓存 */
export async function listHarnessModels(
  kind: HarnessKind,
  opts: { refresh?: boolean } = {},
): Promise<HarnessModels> {
  const hit = cache.get(kind);
  if (!opts.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value: HarnessModels =
    kind === 'dsh'
      ? { kind: 'dsh', models: [...DSH_BUILTIN_MODELS], source: 'builtin' }
      : await probeOpencodeModels();
  cache.set(kind, { at: Date.now(), value });
  return value;
}
