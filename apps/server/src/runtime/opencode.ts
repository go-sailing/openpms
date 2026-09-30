/**
 * runtime/opencode.ts — opencode 运行时适配实现（SDD 4.1）
 *
 * 集成方式：`opencode run --format json`（NDJSON 事件流），
 * 通过 OPENCODE_CONFIG_CONTENT 按次注入：
 *   - agent.<name>.prompt  → 智能体 System Prompt
 *   - agent.<name>.model   → 模型
 *   - mcp.openpms          → OpenPMS 任务管理工具（仅在授权了 task.* 工具时注册）
 *
 * **不下发 permission**：工具授权已通用化，只覆盖 OpenPMS 自己提供的工具（服务端强制），
 * harness 原生工具（读写文件、命令、网络）交由 opencode 自身默认行为，OpenPMS 不做裁剪。
 *
 * 选择该方式是为隔离 opencode 版本差异：若后续切换到 `opencode serve` + SDK，
 * 只需替换本文件，AgentRuntime 接口不变。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../platform/config.js';
import { assembleMessage, assembleSystemPrompt } from './prompt.js';
import { AsyncQueue, extractMemoryCandidates } from './common.js';
import type {
  AgentEvent,
  AgentRuntime,
  ExecutionResult,
  SessionHandle,
  StartSessionOptions,
} from './types.js';

// 共享件由 common.ts 提供，此处回导以保持既有导入面不变
export { extractMemoryCandidates } from './common.js';

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

/** 简单异步队列（AsyncQueue）与「记忆沉淀」解析（extractMemoryCandidates）见 common.ts */

interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      title?: string;
      error?: string;
    };
    tokens?: unknown;
  };
  error?: unknown;
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

    const cfg: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      agent: {
        [agentKey]: {
          mode: 'primary',
          description: `OpenPMS 智能体：${o.agent.name}`,
          prompt: systemPrompt,
          ...(o.agent.model ? { model: o.agent.model } : {}),
        },
      },
    };

    // 只有授权了 OpenPMS 任务管理工具时才挂载 MCP server（未授权则智能体看不到这些工具）
    const hasTaskTools = o.agent.tools.some((t) => t.startsWith('task.'));
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
    const resume = Boolean(o.resumeSessionId);
    const systemPrompt = assembleSystemPrompt({
      agent: o.agent,
      input: o.input,
      limits: injectLimits,
    });
    const message = assembleMessage({
      agent: o.agent,
      input: o.input,
      resume,
      limits: injectLimits,
    });

    // 未指定模型时不传 --model，交给 opencode 自身的默认模型
    const model = o.agent.model?.trim();
    const args = [
      'run',
      '--format',
      'json',
      '--thinking',
      '--dir',
      o.workspace,
      '--agent',
      agentKey,
      ...(model ? ['--model', model] : []),
      // 接续被中断的任务：在该会话上继续，而不是新建会话
      ...(o.resumeSessionId ? ['--session', o.resumeSessionId] : []),
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
        // opencode CLI 的工具事件为 { type: 'tool_use', part: { type: 'tool', tool, callID, state } }，
        // 目标执行期间只发最终态（completed / error），此处两种事件名都兼容。
        case 'tool':
        case 'tool_use': {
          const part = ev.part ?? {};
          const state = part.state ?? {};
          const tool = part.tool ?? part.type ?? 'tool';
          const callId = part.callID ?? null;
          const title = state.title ?? null;
          if (state.status === 'running' || state.status === 'pending') {
            emit({ type: 'tool_call', tool, detail: { callId, title, input: state.input }, at });
          } else {
            emit({
              type: 'tool_result',
              tool,
              detail: {
                callId,
                title,
                status: state.status ?? null,
                input: state.input ?? null,
                output: state.output ?? null,
                error: state.error ?? null,
              },
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
