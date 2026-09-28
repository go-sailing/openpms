/**
 * runtime/types.ts — 智能体运行时抽象（SDD 4.1）
 * 上层只依赖该接口，opencode 具体实现被隔离在 runtime/opencode.ts。
 */
export interface AgentConfigForRun {
  /** OpenPMS 智能体 id */
  id: string;
  name: string;
  /** 真正的 System Prompt */
  systemPrompt: string;
  /** 模型，形如 provider/model；为空则用系统默认 */
  model: string | null;
  /** 授权工具名（OpenPMS 语义） */
  tools: string[];
  /** 单任务超时（秒），覆盖全局配置 */
  timeoutSec?: number | null;
}

export interface MemoryItem {
  id: string;
  content: string;
  createdAt: number;
  sourceTaskId: string | null;
}

export interface CompletedTaskSummary {
  taskId: string;
  name: string;
  description: string;
  result: string | null;
  completedAt: number;
}

/** 项目成员（供智能体了解可指派对象） */
export interface ProjectMemberInfo {
  agentId: string;
  name: string;
  role: string | null;
  /** 是否为本次执行者自己 */
  isSelf: boolean;
}

export interface SessionInput {
  taskName: string;
  taskDescription: string;
  projectName: string;
  projectDescription: string | null;
  /** 当前项目成员列表（含 agentId，供 create_subtask / reassign 使用） */
  members: ProjectMemberInfo[];
  memories: MemoryItem[];
  completedTasks: CompletedTaskSummary[];
  workspace: string;
}

export type AgentEventType =
  | 'step_start'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'output'
  | 'step_finish'
  | 'error'
  | 'prompt'
  | 'raw';

export interface AgentEvent {
  type: AgentEventType;
  text?: string;
  tool?: string;
  /** type = prompt 时标记该提示词的角色 */
  role?: 'system' | 'user';
  detail?: unknown;
  at: number;
}

export interface ExecutionResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  /** 智能体最终文本输出（用于产出回写） */
  output: string;
  sessionId?: string;
  error?: string;
  /** 失败是否为可重试的瞬时错误（如网络不可达、上游 5xx/限流） */
  retryable?: boolean;
  /** 智能体显式提交的产出（经 task.submit_result 工具） */
  submittedResult?: string | null;
  /** 智能体沉淀的记忆候选（取其输出中的记忆块） */
  memoryCandidates: string[];
}

export interface SessionHandle {
  events: AsyncIterable<AgentEvent>;
  wait(): Promise<ExecutionResult>;
  abort(): Promise<void>;
  sessionId?: string;
}

export interface StartSessionOptions {
  agent: AgentConfigForRun;
  workspace: string;
  input: SessionInput;
  executionId: string;
  taskId: string;
  /** 用于智能体回调 OpenPMS 工具接口的令牌 */
  toolToken?: string;
  signal: AbortSignal;
}

export interface AgentRuntime {
  startSession(opts: StartSessionOptions): Promise<SessionHandle>;
}
