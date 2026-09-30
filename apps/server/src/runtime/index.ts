/**
 * runtime/index.ts — 运行时组合入口（SDD 4.1）
 *
 * 两个运行时实现同一套 AgentRuntime 接口：
 *   - opencode：`opencode run --format json`
 *   - dsh：DeepSeek Harness `dsh --profile headless --json`
 *
 * **底座（harness）由每个智能体各自选择**（agents.harness），因此这里是
 * "按底座取运行时"的注册表，而不是全局档位选择。这里是**唯一**的运行时装配点；
 * 执行引擎只依赖 AgentRuntime / RuntimeRegistry，无需感知具体实现。
 */
import { existsSync } from 'node:fs';
import { config } from '../platform/config.js';
import { normalizeHarness, type HarnessKind } from '../platform/types.js';
import { OpencodeRuntime, resolveOpencodeBin } from './opencode.js';
import { DshRuntime, resolveDshBin } from './dsh.js';
import type { AgentRuntime } from './types.js';

export interface RuntimeDescriptor {
  kind: HarnessKind;
  /** 可执行文件的可读形式（dsh 的 npx 形态会带上前置参数） */
  bin: string;
  /** 是否定位到可执行文件 */
  available: boolean;
  /** 需要提示用户的注意事项（如 npx 形态缺 -y） */
  note?: string;
}

/** 按底座取运行时实例；实例惰性创建并缓存（无状态，可跨执行复用） */
export interface RuntimeRegistry {
  get(kind: HarnessKind): AgentRuntime;
}

export function createRuntimes(opts: { mcpServerPath?: string } = {}): RuntimeRegistry {
  const cache = new Map<HarnessKind, AgentRuntime>();
  return {
    get(kind: HarnessKind): AgentRuntime {
      const k = normalizeHarness(kind);
      let rt = cache.get(k);
      if (!rt) {
        rt = k === 'dsh' ? new DshRuntime(opts) : new OpencodeRuntime(opts);
        cache.set(k, rt);
      }
      return rt;
    },
  };
}

/** 供 health 接口与启动日志使用：各底座的可用性（纯函数，无状态） */
export function describeHarnesses(): RuntimeDescriptor[] {
  return [describeOpencode(), describeDsh()];
}

function describeOpencode(): RuntimeDescriptor {
  const bin = resolveOpencodeBin();
  return {
    kind: 'opencode',
    bin,
    // 与既有 health 语义保持一致：裸名（未解析成路径）时视为可用（交给 PATH 解析）
    available: existsSync(bin) || bin !== config.opencodeBin,
  };
}

function describeDsh(): RuntimeDescriptor {
  const bin = resolveDshBin();
  const commandLine = [bin.command, ...bin.args].join(' ');
  const notes: string[] = [];
  if (bin.args.length > 0 && !bin.args.includes('-y') && bin.command.endsWith('npx')) {
    notes.push('npx 形态建议带 -y，否则交互式确认会挂起');
  }
  if (!bin.exists) {
    notes.push('未找到 dsh，请安装 DeepSeek Harness 或设置 DSH_BIN');
  }
  return {
    kind: 'dsh',
    bin: commandLine,
    available: bin.exists,
    ...(notes.length ? { note: notes.join('；') } : {}),
  };
}
