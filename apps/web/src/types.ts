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

export interface Agent {
  id: string;
  name: string;
  role: string | null;
  avatar: string | null;
  systemPrompt: string;
  model: string | null;
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
  maxConcurrency?: number;
  timeoutSec?: number | null;
  tools?: string[];
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
  permissionKey: string;
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
  opencode: {
    bin: string;
    available: boolean;
    defaultModel: string;
  };
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
