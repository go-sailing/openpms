/**
 * runtime/opencode.ts — opencode 运行时适配实现（SDD 4.1）
 *
 * 集成方式：`opencode run --format json`（NDJSON 事件流），
 * 通过 OPENCODE_CONFIG_CONTENT 按次注入：
 *   - agent.<name>.prompt  → 智能体 System Prompt
 *   - agent.<name>.model   → 模型
 *   - permission           → 工具授权 + 工作目录/命令黑名单沙箱
 *
 * 选择该方式是为隔离 opencode 版本差异：若后续切换到 `opencode serve` + SDK，
 * 只需替换本文件，AgentRuntime 接口不变。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../platform/config.js';
import { bashPermissionRules } from '../sandbox/index.js';
import { assembleMessage, assembleSystemPrompt } from './prompt.js';
import type {
  AgentEvent,
  AgentRuntime,
  ExecutionResult,
  SessionHandle,
  StartSessionOptions,
} from './types.js';

/** 解析 opencode 可执行文件路径（优先与当前 node 同目录，其次 PATH） */
export function resolveOpencodeBin(): string {
  const bin = config.opencodeBin;
  if (bin.includes('/')) return bin;
  const sibling = join(dirname(process.execPath), bin);
  if (existsSync(sibling)) return sibling;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return bin;
}

/** 简单异步队列，用于把子进程事件流转成 AsyncIterable */
class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buffer.push(v);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: { status?: string; input?: unknown; output?: unknown; title?: string };
    tokens?: unknown;
  };
  error?: unknown;
}

/** 从最终输出中抽取「记忆沉淀」小节 */
export function extractMemoryCandidates(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s*记忆沉淀/.test(line) || /^\*\*?记忆沉淀/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,6}\s/.test(line) && !/记忆沉淀/.test(line)) break;
      const m = /^[-*]\s+(.+)$/.exec(line) || /^\d+[.、]\s*(.+)$/.exec(line);
      if (m && m[1] && !/^（.*）$/.test(m[1])) out.push(m[1].trim());
    }
  }
  return out
    .filter((s) => s.length >= 4 && s.length <= 500)
    .filter((s) => !/^（.*）$/.test(s))
    .slice(0, 20);
}

/**
 * 判断 opencode 上报的错误是否为可重试的瞬时错误。
 * opencode 的错误对象形如 {name, data:{message, isRetryable, metadata}}，
 * 对网络不可达、上游 5xx、限流等会置 isRetryable=true。
 */
export function isRetryableError(message: string | undefined): boolean {
  if (!message) return false;
  try {
    const parsed = JSON.parse(message) as { data?: { isRetryable?: unknown } };
    return parsed?.data?.isRetryable === true;
  } catch {
    return false;
  }
}

export class OpencodeRuntime implements AgentRuntime {
  constructor(private readonly opts: { mcpServerPath?: string } = {}) {}

  private buildConfigContent(o: StartSessionOptions, systemPrompt: string): string {
    const agentKey = `openpms-${o.agent.id}`;
    const tools = new Set(o.agent.tools);

    const permission: Record<string, unknown> = {
      read: tools.has('fs.read') ? 'allow' : 'deny',
      edit: tools.has('fs.edit') ? 'allow' : 'deny',
      glob: tools.has('fs.glob') ? 'allow' : 'deny',
      grep: tools.has('fs.grep') ? 'allow' : 'deny',
      list: tools.has('fs.list') ? 'allow' : 'deny',
      webfetch: tools.has('webfetch') ? 'allow' : 'deny',
      websearch: tools.has('websearch') ? 'allow' : 'deny',
      task: 'deny',
      // 工作目录沙箱：禁止访问项目目录之外的路径
      external_directory: 'deny',
      question: 'deny',
      doom_loop: 'allow',
    };
    permission['bash'] = tools.has('shell') ? bashPermissionRules() : 'deny';

    const cfg: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      permission,
      agent: {
        [agentKey]: {
          mode: 'primary',
          description: `OpenPMS 智能体：${o.agent.name}`,
          prompt: systemPrompt,
          ...(o.agent.model ? { model: o.agent.model } : {}),
        },
      },
    };

    const hasTaskTools = [...tools].some((t) => t.startsWith('task.'));
    if (hasTaskTools && this.opts.mcpServerPath) {
      cfg['mcp'] = {
        openpms: {
          type: 'local',
          command: [process.execPath, this.opts.mcpServerPath],
          enabled: true,
          environment: {
            OPENPMS_API_URL: `http://127.0.0.1:${config.port}`,
            OPENPMS_EXECUTION_ID: o.executionId,
            OPENPMS_TASK_ID: o.taskId,
            OPENPMS_AGENT_ID: o.agent.id,
            OPENPMS_TOOL_TOKEN: o.toolToken ?? '',
          },
        },
      };
    }
    return JSON.stringify(cfg);
  }

  async startSession(o: StartSessionOptions): Promise<SessionHandle> {
    const bin = resolveOpencodeBin();
    const agentKey = `openpms-${o.agent.id}`;
    const injectLimits = {
      memoryInjectMax: config.memoryInjectMax,
      memoryInjectTokenBudget: config.memoryInjectTokenBudget,
      completedTaskInjectMax: config.completedTaskInjectMax,
      completedTaskInjectTokenBudget: config.completedTaskInjectTokenBudget,
    };
    // System Prompt（角色定义 + 经验记忆）与用户消息（运行时上下文 + 任务）分开组装
    const systemPrompt = assembleSystemPrompt({
      agent: o.agent,
      input: o.input,
      limits: injectLimits,
    });
    const message = assembleMessage({
      agent: o.agent,
      input: o.input,
      limits: injectLimits,
    });

    const args = [
      'run',
      '--format',
      'json',
      '--dir',
      o.workspace,
      '--agent',
      agentKey,
      '--model',
      o.agent.model ?? config.defaultModel,
      message,
    ];

    const child = spawn(bin, args, {
      cwd: o.workspace,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: this.buildConfigContent(o, systemPrompt),
        // 关闭自动更新与交互性提示，保证 headless 稳定
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_TERMINAL_TITLE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const queue = new AsyncQueue<AgentEvent>();
    const outputChunks: string[] = [];
    const stderrChunks: string[] = [];
    let sessionId: string | undefined;
    let sawError = false;
    let lastError: string | undefined;
    let cancelled = false;

    const emit = (e: AgentEvent): void => queue.push(e);

    // 把本次下发的 System Prompt 与用户消息写入事件流（进而落盘到执行日志），便于回溯上下文
    const promptAt = Date.now();
    emit({ type: 'prompt', role: 'system', text: systemPrompt, at: promptAt });
    emit({ type: 'prompt', role: 'user', text: message, at: promptAt });

    const mapEvent = (ev: OpencodeEvent): void => {
      if (ev.sessionID && !sessionId) sessionId = ev.sessionID;
      const at = Date.now();
      switch (ev.type) {
        case 'step_start':
          emit({ type: 'step_start', at });
          break;
        case 'text': {
          const text = ev.part?.text ?? '';
          if (text) {
            outputChunks.push(text);
            emit({ type: 'output', text, at });
          }
          break;
        }
        case 'reasoning': {
          const text = ev.part?.text ?? '';
          if (text) emit({ type: 'thought', text, at });
          break;
        }
        case 'tool': {
          const st = ev.part?.state?.status;
          const tool = ev.part?.tool ?? ev.part?.type ?? 'tool';
          if (st === 'running' || st === 'pending') {
            emit({ type: 'tool_call', tool, detail: ev.part?.state?.input, at });
          } else {
            emit({
              type: 'tool_result',
              tool,
              detail: ev.part?.state?.output ?? ev.part?.state,
              at,
            });
          }
          break;
        }
        case 'step_finish':
          emit({ type: 'step_finish', detail: ev.part?.tokens, at });
          break;
        case 'error': {
          sawError = true;
          lastError = typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error ?? 'unknown error');
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
        mapEvent(JSON.parse(trimmed) as OpencodeEvent);
      } catch {
        emit({ type: 'output', text: trimmed, at: Date.now() });
      }
    });

    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrChunks.push(s);
      emit({ type: 'raw', detail: { stderr: s }, at: Date.now() });
    });

    // 注意：这里不能 await 子进程退出，否则事件无法实时消费。
    const exitCodePromise = new Promise<number>((resolve) => {
      child.on('error', (err) => {
        sawError = true;
        lastError = `无法启动 opencode：${err.message}（bin=${bin}）`;
        emit({ type: 'error', text: lastError, at: Date.now() });
        resolve(-1);
      });
      child.on('close', (code) => resolve(code ?? -1));
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

    // 子进程结束后关闭事件流
    void exitCodePromise
      .then(() => queue.close())
      .catch(() => queue.close());

    return {
      events: queue,
      get sessionId(): string | undefined {
        return sessionId;
      },
      wait: async (): Promise<ExecutionResult> => {
        const exitCode = await exitCodePromise;
        queue.close();
        const finalOutput = outputChunks.join('\n').trim();
        if (cancelled || o.signal.aborted) {
          return { status: 'cancelled', output: finalOutput, sessionId, memoryCandidates: [] };
        }
        const succeeded = exitCode === 0 && !sawError;
        const error = succeeded
          ? undefined
          : lastError ??
            `opencode 退出码 ${exitCode}${
              stderrChunks.length ? `；stderr: ${stderrChunks.join('').slice(-800)}` : ''
            }`;
        return {
          status: succeeded ? 'succeeded' : 'failed',
          output: finalOutput,
          sessionId,
          error,
          retryable: !succeeded && isRetryableError(error),
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
