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
  /**
   * harness 底座（opencode / dsh）的 CLI 位置。**底座由每个智能体各自选择**
   * （agents.harness），因此这里不再有「全局档位」开关；模型也由智能体各自指定，
   * 未指定时不传，交由底座自身的默认模型决定。
   */
  opencodeBin: string;
  /**
   * dsh 可执行文件或命令行。支持空格形式以覆盖 npx 形态，
   * 如 `npx -y @deepseek-ai/dsh`（npx 形态必须带 -y，否则交互式确认会挂起）。
   */
  dshBin: string;
  /**
   * dsh 的 DSH_HOME（状态、会话、日志与**凭据**的根目录）。
   *
   * **默认为空表示不覆盖**，让 dsh 使用它自己的默认目录（`~/.dsh`）——这样用户在 dsh
   * 侧通过 `dsh auth` 或 Web Models 页面配置的 API Key（存于 `$DSH_HOME/.credentials.yaml`）
   * 才能被找到；若强行重定向到一个新目录，dsh 会因找不到凭据而报 MISSING_CREDENTIAL。
   *
   * 需要与用户既有 dsh 环境隔离时（如 CI、桌面端想独立存放会话）可显式设置。
   */
  dshHome: string;
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
  executionTimeoutSec: 18000,
  transientRetryMax: 2,
  transientRetryIntervalSec: 30,
  workspaceRoots: [],
  memorySinkMode: 'auto',
  memoryMaxPerTask: 5,
  memoryInjectMax: 20,
  memoryInjectTokenBudget: 2000,
  completedTaskInjectMax: 20,
  completedTaskInjectTokenBudget: 2000,
  logFileMaxMB: 10,
  opencodeBin: process.env.OPENCODE_BIN ?? 'opencode',
  dshBin: process.env.DSH_BIN ?? 'dsh',
  // 默认空 = 不覆盖 DSH_HOME，复用用户既有 dsh 配置（含凭据）
  dshHome: process.env.OPENPMS_DSH_HOME ? resolve(process.env.OPENPMS_DSH_HOME) : '',
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
