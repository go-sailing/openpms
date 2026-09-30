/**
 * runtime/dsh.ts — DeepSeek Harness 运行时适配实现（SDD 4.1）
 *
 * 集成方式：`dsh --profile headless --json`（NDJSON 事件流，一次性任务）。
 * 与 opencode 适配层的差异（均为实测确认）：
 *   - System Prompt 与模型经运行时生成的 `--patch` YAML 注入（opencode 用环境变量 config）
 *   - 任务文本走 **stdin**（opencode 走命令行位置参数），避免超长参数与引号转义问题
 *   - 成功判定以退出码为主：`turn/end` 为 completed 才返回 0
 *   - 事件为「步骤提交级」而非逐 token 流式，实时性弱于 opencode
 *   - 工具授权不由运行时强制（见 README「已知限制」），仅任务管理工具在服务端强制
 *
 * dsh 为外部 CLI（不进入 npm 依赖），路径由 config.dshBin / DSH_BIN 配置。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config, DATA_DIR, ROOT_DIR } from '../platform/config.js';
import { assembleMessage, assembleSystemPrompt } from './prompt.js';
import { AsyncQueue, extractMemoryCandidates } from './common.js';
import { buildDshPatchYaml } from './dsh-patch.js';
import type {
  AgentEvent,
  AgentRuntime,
  ExecutionResult,
  SessionHandle,
  StartSessionOptions,
} from './types.js';

export interface DshBin {
  /** 可执行文件（或 npx 等命令） */
  command: string;
  /** 前置参数（如 npx 形态的 ['-y','@deepseek-ai/dsh']） */
  args: string[];
  /** 是否定位到一个真实存在的可执行文件 */
  exists: boolean;
  source: 'config-path' | 'config-argv' | 'sibling' | 'repo-local-bin' | 'path' | 'bare';
}

/**
 * 解析 dsh 可执行文件。
 * 与 resolveOpencodeBin 的差异：必须支持「命令 + 参数」的空格形式，以覆盖
 * `npx -y @deepseek-ai/dsh` 这类形态（npx 形态必须带 -y，否则会因交互式确认挂住）。
 */
export function resolveDshBin(): DshBin {
  const raw = (config.dshBin ?? '').trim() || 'dsh';

  // 含空白 → 视为「命令 + 参数」
  if (/\s/.test(raw)) {
    const [command, ...args] = raw.split(/\s+/);
    return { command, args, exists: true, source: 'config-argv' };
  }
  // 显式路径
  if (raw.includes('/')) {
    return { command: raw, args: [], exists: existsSync(raw), source: 'config-path' };
  }
  // 与当前 node 同目录（npm 全局 bin shim 的常见位置）
  const sibling = join(dirname(process.execPath), raw);
  if (existsSync(sibling)) return { command: sibling, args: [], exists: true, source: 'sibling' };
  // 仓库内 node_modules/.bin（开发态）
  const localBin = resolve(ROOT_DIR, 'node_modules', '.bin', raw);
  if (existsSync(localBin)) return { command: localBin, args: [], exists: true, source: 'repo-local-bin' };
  // PATH
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = join(dir, raw);
    if (existsSync(p)) return { command: p, args: [], exists: true, source: 'path' };
  }
  return { command: raw, args: [], exists: false, source: 'bare' };
}

/** 结构性错误：重试无意义，不消耗重试预算 */
const NON_RETRYABLE_PATTERNS = [
  /MISSING_CREDENTIAL/i,
  /INVALID_CREDENTIAL/i,
  /\bAUTH\b/,
  /Authentication Fails/i,
  /unknown model/i,
  /model.*not (?:found|available)/i,
  /\bENOENT\b/,
  /No such file/i,
  /\bEACCES\b/,
  /cannot find module/i,
  /Failed to (?:load|resolve) plugin/i,
  /ValidationError/i,
];

/** 瞬时错误：可重试（网络抖动、上游限流/5xx） */
const RETRYABLE_PATTERNS = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/i,
  /socket hang up/i,
  /fetch failed|network error/i,
  /upstream/i,
  /overloaded/i,
  /too many requests|rate.?limit/i,
  /\b(?:429|500|502|503|504)\b/,
  /timed? ?out/i,
];

/**
 * 判断 dsh 失败是否可重试。
 *
 * 优先使用 dsh 的结构化错误码（`turn_end.reason.error.code` / `status`，实测形状），
 * 拿不到时回退到错误文本分类；无法归类一律视为不可重试（与 SDD 4.1 表述一致）。
 */
export function isRetryableDshError(
  error: string | undefined,
  meta?: { code?: string | null; status?: number | null },
): boolean {
  const code = meta?.code ?? '';
  const status = meta?.status ?? null;

  // 结构化判定优先
  if (status !== null) {
    if (status === 429 || status >= 500) return true; // 限流 / 上游故障
    if (status >= 400 && status < 500) return false; // 4xx 多为请求或凭据问题
  }
  if (code) {
    if (/MISSING_CREDENTIAL|INVALID_CREDENTIAL|AUTH|NOT_FOUND|VALIDATION|BAD_REQUEST|UNSUPPORTED/i.test(code)) {
      return false;
    }
    if (/RATE_LIMIT|TIMEOUT|UNAVAILABLE|OVERLOADED|SERVER_ERROR|INTERNAL/i.test(code)) return true;
  }

  if (!error) return false;
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(error))) return false;
  if (RETRYABLE_PATTERNS.some((re) => re.test(error))) return true;
  return false;
}

/** dsh --json 事件（形状经实测确认；未识别字段一律保留在 detail 中以便排查） */
interface DshEvent {
  type?: string;
  sessionId?: string;
  cwd?: string;
  phase?: string;
  turn?: number;
  step?: number;
  text?: string;
  reason?: {
    kind?: string;
    error?: { message?: string; code?: string; status?: number };
  };
  // tool_call / tool_result 的字段名由多候选回退读取，避免依赖未验证的形状
  name?: string;
  tool?: string;
  toolName?: string;
  callId?: string;
  callID?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  content?: unknown;
  isError?: boolean;
  message?: string;
  error?: unknown;
}

/** 从事件里按候选字段名取第一个字符串值 */
function pickString(ev: DshEvent, keys: (keyof DshEvent)[]): string | null {
  for (const k of keys) {
    const v = ev[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** 从事件里按候选字段名取第一个任意值 */
function pickValue(ev: DshEvent, keys: (keyof DshEvent)[]): unknown {
  for (const k of keys) {
    const v = ev[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export class DshRuntime implements AgentRuntime {
  constructor(private readonly opts: { mcpServerPath?: string } = {}) {}

  /** patch 文件目录：落在 DATA_DIR 下（开发态 <repo>/data，桌面态 userData） */
  private patchDir(): string {
    return join(DATA_DIR, 'dsh', 'patches');
  }

  private patchPath(executionId: string): string {
    return join(this.patchDir(), `${executionId}.yml`);
  }

  /**
   * 任务文本走 stdin（不用位置参数）：运行时上下文含成员列表、最多 20 条历史任务与
   * 约束段，长度可过 10 KB 且含大量换行/引号；dsh 在省略位置参数时从 stdin 读取任务
   * （实测确认可正常读取并进入模型调用）。
   */
  async startSession(o: StartSessionOptions): Promise<SessionHandle> {
    const bin = resolveDshBin();
    const injectLimits = {
      memoryInjectMax: config.memoryInjectMax,
      memoryInjectTokenBudget: config.memoryInjectTokenBudget,
      completedTaskInjectMax: config.completedTaskInjectMax,
      completedTaskInjectTokenBudget: config.completedTaskInjectTokenBudget,
    };
    // System Prompt（角色定义 + 经验记忆）与用户消息（运行时上下文 + 任务）分开组装
    const resume = Boolean(o.resumeSessionId);
    const systemPrompt = assembleSystemPrompt({ agent: o.agent, input: o.input, limits: injectLimits });
    const message = assembleMessage({ agent: o.agent, input: o.input, resume, limits: injectLimits });

    // 生成并落地 patch 覆盖层
    mkdirSync(this.patchDir(), { recursive: true });
    const patchPath = this.patchPath(o.executionId);
    const hasTaskTools = o.agent.tools.some((t) => t.startsWith('task.'));
    const patchYaml = buildDshPatchYaml({
      systemPrompt,
      model: o.agent.model?.trim() || null,
      mcp:
        hasTaskTools && this.opts.mcpServerPath
          ? {
              mcpServerPath: this.opts.mcpServerPath,
              nodeBin: process.execPath,
              apiUrl: `http://127.0.0.1:${config.port}`,
              taskId: o.taskId,
              agentId: o.agent.id,
            }
          : null,
    });
    writeFileSync(patchPath, patchYaml, { mode: 0o600, encoding: 'utf8' });

    const args = [
      ...bin.args,
      '--profile',
      'headless',
      '--patch',
      patchPath,
      // --json / --session-id 是 headless 的 app 参数，必须排在 launcher 级 flag 之后
      '--json',
      // 接续被中断的任务：adopt 该已持久化会话，而不是新建会话
      ...(o.resumeSessionId ? ['--session-id', o.resumeSessionId] : []),
    ];

    const child = spawn(bin.command, args, {
      cwd: o.workspace,
      env: {
        ...process.env,
        // DSH_HOME 只在显式配置时下发：默认留给 dsh 自己的默认目录（~/.dsh），
        // 这样用户在 dsh 侧配置的凭据（$DSH_HOME/.credentials.yaml，含 Web Models 页面写入的
        // DEEPSEEK_API_KEY）才能被找到；强行重定向到空目录会导致 MISSING_CREDENTIAL。
        ...(config.dshHome ? { DSH_HOME: config.dshHome } : {}),
        // 供 patch 里的 !!js 引用；必须是已定义字符串，否则 MCP 行的 env 校验会失败
        OPENPMS_EXECUTION_ID: o.executionId ?? '',
        OPENPMS_TOOL_TOKEN: o.toolToken ?? '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 把任务文本写入 stdin 后关闭，dsh 会将其作为本次任务的用户消息
    child.stdin.on('error', () => {
      /* 子进程提前退出时的 EPIPE 忽略即可 */
    });
    child.stdin.end(message);

    const queue = new AsyncQueue<AgentEvent>();
    const streamedText: string[] = [];
    const stderrChunks: string[] = [];
    let sessionId: string | undefined;
    let finalText: string | null = null;
    let sawError = false;
    let lastError: string | undefined;
    let errorCode: string | null = null;
    let errorStatus: number | null = null;
    let turnEndReason: string | null = null;
    let cancelled = false;

    const emit = (e: AgentEvent): void => queue.push(e);

    // 把本次下发的 System Prompt、用户消息与 patch 内容写入事件流（进而落盘到执行日志）。
    // dsh 把前两者分别藏在 patch 文件与 stdin 里，不落盘就无法回溯上下文。
    // patch 不含任何密钥（敏感值均为 !!js 环境变量引用），可安全整份记录。
    const promptAt = Date.now();
    emit({ type: 'prompt', role: 'system', text: systemPrompt, at: promptAt });
    emit({ type: 'prompt', role: 'user', text: message, at: promptAt });
    emit({ type: 'raw', detail: { kind: 'dsh-config', patchPath, patchYaml }, at: promptAt });

    const mapEvent = (ev: DshEvent): void => {
      if (typeof ev.sessionId === 'string' && !sessionId) sessionId = ev.sessionId;
      const at = Date.now();
      switch (ev.type) {
        case 'session':
          emit({ type: 'step_start', at });
          emit({ type: 'raw', detail: { kind: 'dsh-session', cwd: ev.cwd }, at });
          break;
        case 'status': {
          // phase: turn_start / step_start / step_end / turn_end
          if (ev.phase === 'turn_end') {
            const err = ev.reason?.error;
            turnEndReason = ev.reason?.kind ?? null;
            if (err?.message) {
              lastError = err.message;
              errorCode = err.code ?? null;
              errorStatus = typeof err.status === 'number' ? err.status : null;
            }
            emit({ type: 'step_finish', detail: { phase: ev.phase, reason: ev.reason ?? null }, at });
          } else if (ev.phase === 'turn_start') {
            emit({ type: 'step_start', detail: { phase: ev.phase, turn: ev.turn ?? null }, at });
          } else if (ev.phase === 'step_start') {
            emit({ type: 'step_start', detail: { phase: ev.phase, step: ev.step ?? null }, at });
          } else {
            emit({ type: 'step_finish', detail: { phase: ev.phase ?? null, step: ev.step ?? null }, at });
          }
          break;
        }
        case 'text': {
          const text = ev.text ?? '';
          if (text) {
            streamedText.push(text);
            emit({ type: 'output', text, at });
          }
          break;
        }
        case 'thinking': {
          const text = ev.text ?? '';
          if (text) emit({ type: 'thought', text, at });
          break;
        }
        case 'tool_call': {
          const tool = pickString(ev, ['name', 'tool', 'toolName']) ?? 'tool';
          emit({
            type: 'tool_call',
            tool,
            detail: { callId: pickString(ev, ['callId', 'callID']), input: pickValue(ev, ['input']) },
            at,
          });
          break;
        }
        case 'tool_result': {
          const tool = pickString(ev, ['name', 'tool', 'toolName']) ?? 'tool';
          emit({
            type: 'tool_result',
            tool,
            detail: {
              callId: pickString(ev, ['callId', 'callID']),
              output: pickValue(ev, ['output', 'result', 'content']),
              isError: ev.isError === true,
            },
            at,
          });
          break;
        }
        case 'final':
          // final 不截断，是产出的权威来源；正文已由 text 事件呈现，此处不再重复成 output
          finalText = ev.text ?? '';
          emit({ type: 'step_finish', detail: { final: true }, at });
          break;
        case 'error': {
          sawError = true;
          lastError =
            pickString(ev, ['message', 'text']) ??
            (typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error ?? 'dsh error'));
          emit({ type: 'error', text: lastError, at });
          break;
        }
        default:
          emit({ type: 'raw', detail: ev, at });
      }
    };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('{')) {
        // 非 JSON 输出（如提示信息）作为普通输出记录
        emit({ type: 'output', text: trimmed, at: Date.now() });
        return;
      }
      try {
        mapEvent(JSON.parse(trimmed) as DshEvent);
      } catch {
        emit({ type: 'output', text: trimmed, at: Date.now() });
      }
    });

    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrChunks.push(s);
      emit({ type: 'raw', detail: { stderr: s }, at: Date.now() });
    });

    // 注意：不能 await 子进程退出，否则事件无法实时消费
    const exitCodePromise = new Promise<number>((resolveExit) => {
      child.on('error', (err) => {
        sawError = true;
        lastError = `无法启动 dsh：${err.message}（command=${bin.command}）`;
        emit({ type: 'error', text: lastError, at: Date.now() });
        resolveExit(-1);
      });
      child.on('close', (code) => resolveExit(code ?? -1));
    });

    const onAbort = (): void => {
      cancelled = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      } catch {
        /* ignore */
      }
    };
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });

    // 子进程结束后：清理 patch 文件并关闭事件流
    void exitCodePromise
      .then(() => {
        cleanupPatch(patchPath);
        queue.close();
      })
      .catch(() => {
        cleanupPatch(patchPath);
        queue.close();
      });

    return {
      events: queue,
      get sessionId(): string | undefined {
        return sessionId;
      },
      wait: async (): Promise<ExecutionResult> => {
        const exitCode = await exitCodePromise;
        queue.close();
        const finalOutput =
          finalText !== null && finalText !== ''
            ? finalText.trim()
            : streamedText.join('\n').trim();
        if (cancelled || o.signal.aborted) {
          return { status: 'cancelled', output: finalOutput, sessionId, memoryCandidates: [] };
        }
        const succeeded = exitCode === 0 && !sawError;
        const stderrTail = stderrChunks.join('').slice(-800);
        const error = succeeded
          ? undefined
          : lastError ??
            `dsh 退出码 ${exitCode}${turnEndReason ? `；turn/end: ${turnEndReason}` : ''}${
              stderrTail ? `；stderr: ${stderrTail}` : ''
            }`;
        return {
          status: succeeded ? 'succeeded' : 'failed',
          output: finalOutput,
          sessionId,
          error,
          retryable: !succeeded && isRetryableDshError(error, { code: errorCode, status: errorStatus }),
          memoryCandidates: succeeded ? extractMemoryCandidates(finalOutput) : [],
        };
      },
      abort: async (): Promise<void> => {
        onAbort();
        await new Promise((r) => setTimeout(r, 200));
      },
    };
  }
}

/** 删除本次执行的 patch 文件（内容含工作目录与模型名，不含密钥；失败不影响执行结果） */
function cleanupPatch(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}