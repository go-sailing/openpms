/**
 * platform/config.ts
 * 全局配置。默认值来自 SDD 第 13 章，可被 data/config.json 与环境变量覆盖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OpenPmsConfig {
  /** HTTP 服务端口 */
  port: number;
  /** 数据库文件路径 */
  dbPath: string;
  /** 执行日志目录 */
  logDir: string;
  /** 全局最大并发执行数 */
  globalMaxConcurrency: number;
  /** 新建智能体默认并发 */
  defaultAgentConcurrency: number;
  /** 调度 tick 间隔（毫秒） */
  schedulerTickMs: number;
  /** 派发前置校验失败后的最小重试间隔（毫秒），避免忙等刷屏 */
  dispatchErrorBackoffMs: number;
  /** 单任务执行超时（秒），0 表示不限制 */
  executionTimeoutSec: number;
  /**
   * 未配置重试策略的任务（retry_max=0）遇到可重试的瞬时错误
   * （网络不可达、上游 5xx/限流等）时的兜底重试次数
   */
  transientRetryMax: number;
  /** 兜底重试的间隔（秒），仅当任务自身未配置重试间隔时生效 */
  transientRetryIntervalSec: number;
  /** 是否启用默认命令黑名单 */
  commandBlacklistEnabled: boolean;
  /** 额外新增的命令黑名单规则（正则字符串） */
  commandBlacklistExtra: string[];
  /** 命令黑名单豁免规则（正则字符串，优先于黑名单） */
  commandWhitelist: string[];
  /** 允许作为工作目录的根路径白名单；为空表示不限制（仅校验存在性） */
  workspaceRoots: string[];
  /** 记忆沉淀模式：auto 自动沉淀 */
  memorySinkMode: 'auto' | 'manual';
  /** 单次任务最多自动沉淀的记忆条数 */
  memoryMaxPerTask: number;
  /** 记忆注入上限 */
  memoryInjectMax: number;
  memoryInjectTokenBudget: number;
  /** 项目已完成历史任务注入上限 */
  completedTaskInjectMax: number;
  completedTaskInjectTokenBudget: number;
  /** 单个执行日志文件大小上限（MB），超过后轮转 */
  logFileMaxMB: number;
  /** opencode 可执行文件 */
  opencodeBin: string;
  /** 未指定模型时使用的默认模型 */
  defaultModel: string;
  /** 是否自动调度（系统级开关的初始值） */
  autoScheduleDefault: boolean;
  /** 启动时是否播种默认智能体 */
  seedDefaultAgents: boolean;
}

/** 仓库根目录（相对本模块解析，避免依赖进程 cwd） */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const DATA_DIR = process.env.OPENPMS_DATA_DIR
  ? resolve(process.env.OPENPMS_DATA_DIR)
  : resolve(ROOT_DIR, 'data');

const DEFAULTS: OpenPmsConfig = {
  port: 4517,
  dbPath: resolve(DATA_DIR, 'openpms.db'),
  logDir: resolve(DATA_DIR, 'logs'),
  globalMaxConcurrency: 4,
  defaultAgentConcurrency: 1,
  schedulerTickMs: 2000,
  dispatchErrorBackoffMs: 30_000,
  executionTimeoutSec: 1800,
  transientRetryMax: 2,
  transientRetryIntervalSec: 30,
  commandBlacklistEnabled: true,
  commandBlacklistExtra: [],
  commandWhitelist: [],
  workspaceRoots: [],
  memorySinkMode: 'auto',
  memoryMaxPerTask: 5,
  memoryInjectMax: 20,
  memoryInjectTokenBudget: 2000,
  completedTaskInjectMax: 20,
  completedTaskInjectTokenBudget: 2000,
  logFileMaxMB: 10,
  opencodeBin: process.env.OPENCODE_BIN ?? 'opencode',
  defaultModel: 'opencode/mimo-v2.6-flash-free',
  autoScheduleDefault: true,
  seedDefaultAgents: true,
};

function readConfigFile(): Partial<OpenPmsConfig> {
  const candidates = [
    process.env.OPENPMS_CONFIG,
    resolve(ROOT_DIR, 'openpms.config.json'),
    resolve(DATA_DIR, 'config.json'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as Partial<OpenPmsConfig>;
      } catch (err) {
        throw new Error(`配置文件解析失败: ${p} -> ${(err as Error).message}`);
      }
    }
  }
  return {};
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const config: OpenPmsConfig = (() => {
  const file = readConfigFile();
  const merged: OpenPmsConfig = { ...DEFAULTS, ...file };
  if (process.env.OPENPMS_PORT) merged.port = num(process.env.OPENPMS_PORT, merged.port);
  if (process.env.OPENPMS_DB) merged.dbPath = process.env.OPENPMS_DB;
  if (process.env.OPENPMS_OC_TIMEOUT) {
    merged.executionTimeoutSec = num(process.env.OPENPMS_OC_TIMEOUT, merged.executionTimeoutSec);
  }
  if (process.env.OPENPMS_GLOBAL_CONCURRENCY) {
    merged.globalMaxConcurrency = num(
      process.env.OPENPMS_GLOBAL_CONCURRENCY,
      merged.globalMaxConcurrency,
    );
  }
  if (process.env.OPENPMS_AUTO_SCHEDULE) {
    merged.autoScheduleDefault = bool(process.env.OPENPMS_AUTO_SCHEDULE, merged.autoScheduleDefault);
  }
  if (process.env.OPENPMS_WORKSPACE_ROOTS) {
    merged.workspaceRoots = process.env.OPENPMS_WORKSPACE_ROOTS.split(':').filter(Boolean);
  }
  return merged;
})();
