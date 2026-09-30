/**
 * types.ts — 后端 API 契约类型定义（集中管理）
 */

export interface ApiEnvelope<T> {
  code: number | string;
  message: string;
  data: T;
  details?: unknown;
}

/* ---------------- 智能体 ---------------- */

export type AgentStatus = 'enabled' | 'disabled';

/** harness 底座：智能体执行所用的运行时，每个智能体各自选择 */
export type HarnessKind = 'opencode' | 'dsh';

export interface Agent {
  id: string;
  name: string;
  role: string | null;
  avatar: string | null;
  systemPrompt: string;
  model: string | null;
  harness: HarnessKind;
  status: AgentStatus;
  maxConcurrency: number;
  timeoutSec: number | null;
  isBuiltin: boolean;
  tools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentInput {
  name: string;
  role?: string | null;
  systemPrompt: string;
  model?: string | null;
  harness?: HarnessKind;
  maxConcurrency?: number;
  timeoutSec?: number | null;
  tools?: string[];
}

/** 各 harness 底座的可用性（底座由每个智能体各自选择） */
export interface HarnessDescriptor {
  kind: HarnessKind;
  bin: string;
  available: boolean;
  note?: string;
}

/** 某底座当前可用的模型清单 */
export interface HarnessModelList {
  kind: HarnessKind;
  models: string[];
  /** cli = 调用底座命令实时拉取；builtin = 底座内置目录 */
  source: 'cli' | 'builtin';
  note?: string;
}

export interface Memory {
  id: string;
  agent_id: string;
  content: string;
  source_task_id: string | null;
  status: string;
  created_at: number;
}

export interface ToolCatalogItem {
  name: string;
  label: string;
  risk: string;
}

/* ---------------- 项目与成员 ---------------- */

export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  defaultWorkspace: string | null;
  status: ProjectStatus;
  autoScheduleEnabled: boolean;
  memberCount: number;
  taskCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Member {
  id: string;
  projectId: string;
  agentId: string;
  roleInProject: string | null;
  joinedAt: number;
  agentName: string;
  agentRole: string | null;
  agentStatus: AgentStatus;
  openTaskCount: number;
}

/* ---------------- 任务 ---------------- */

export type TaskStatus = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type Priority = 'low' | 'medium' | 'high';
export type TriggerMode = 'manual' | 'auto' | 'scheduled' | 'dependency';
export type RetryBackoff = 'fixed' | 'exponential';

export interface Task {
  id: string;
  projectId: string;
  projectName: string | null;
  agentId: string;
  agentName: string | null;
  parentId: string | null;
  name: string;
  description: string;
  workspace: string | null;
  status: TaskStatus;
  priority: Priority;
  result: string | null;
  triggerMode: TriggerMode;
  scheduledAt: number | null;
  cronExpr: string | null;
  nextRunAt: number | null;
  notBefore: number | null;
  retryMax: number;
  retryInterval: number;
  retryBackoff: RetryBackoff;
  retryNo: number;
  scheduleEnabled: boolean;
  queuedAt: number | null;
  enqueueReason: string | null;
  pendingFire: boolean;
  timeoutSec: number | null;
  lastDispatchError: string | null;
  dependencyIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskInput {
  projectId: string;
  agentId: string;
  name: string;
  description: string;
  workspace?: string | null;
  priority?: Priority;
  triggerMode?: TriggerMode;
  scheduledAt?: number | null;
  cronExpr?: string | null;
  retryMax?: number;
  retryInterval?: number;
  retryBackoff?: RetryBackoff;
  timeoutSec?: number | null;
  parentId?: string | null;
  dependencyIds?: string[];
}

export interface StatusLog {
  from_status: string | null;
  to_status: string;
  actor_type: string;
  actor_id: string | null;
  reason: string | null;
  created_at: number;
}

/* ---------------- 执行记录 ---------------- */

export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface Execution {
  id: string;
  task_id: string;
  agent_id: string;
  trigger_type: 'manual' | 'scheduler' | string;
  retry_no: number;
  status: ExecutionStatus;
  session_id: string | null;
  workspace: string | null;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  result: string | null;
  log_path: string | null;
}

export interface TaskLogResponse {
  executionId: string;
  content: string;
}

/* ---------------- 调度与系统 ---------------- */

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  tickMs: number;
  queued: number;
  runningExecutions: number;
  globalMaxConcurrency: number;
  lastTickAt: number | null;
}

export interface HealthStatus {
  ok: boolean;
  version: string;
  uptimeSec: number;
  wsClients: number;
  /** 各 harness 底座的可用性（旧版后端可能不返回，故为可选） */
  harnesses?: HarnessDescriptor[];
}

export type SystemConfig = Record<string, unknown>;

export interface ToolAudit {
  id: string;
  execution_id: string;
  task_id: string;
  agent_id: string;
  tool_name: string;
  input: string | null;
  decision: string;
  reason: string | null;
  created_at: number;
}

/* ---------------- WebSocket 事件 ---------------- */

export interface WsEvent {
  type: string;
  taskId?: string;
  projectId?: string;
  payload?: unknown;
  at?: number;
}

export interface RuntimeLogEvent {
  type: string;
  text?: string;
  tool?: string;
  /** type = prompt 时的角色（system / user） */
  role?: string;
  detail?: unknown;
  at?: number;
}
