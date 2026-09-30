/**
 * platform/types.ts — 领域类型定义
 */
export type AgentStatus = 'enabled' | 'disabled';

/**
 * harness 底座：智能体执行所用的运行时。
 * **每个智能体各自选择**，系统不再有全局档位。
 */
export type HarnessKind = 'opencode' | 'dsh';

export const HARNESS_CATALOG: readonly { kind: HarnessKind; label: string; description: string }[] = [
  {
    kind: 'opencode',
    label: 'opencode',
    description: 'opencode CLI（逐 token 实时流式；文件/命令类工具授权由运行时强制拦截）',
  },
  {
    kind: 'dsh',
    label: 'DeepSeek Harness',
    description: 'dsh CLI（步骤级事件；工具授权语义见「已知限制」）',
  },
];

/** 归一化底座取值：只认 dsh，其余（含空值、脏数据）一律回退 opencode */
export function normalizeHarness(v: string | null | undefined): HarnessKind {
  return v === 'dsh' ? 'dsh' : 'opencode';
}

export type ProjectStatus = 'active' | 'archived';
export type TaskStatus = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TriggerMode = 'manual' | 'auto' | 'scheduled' | 'dependency';
export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type RetryBackoff = 'fixed' | 'exponential';
export type ActorType = 'user' | 'agent' | 'system' | 'scheduler';

export interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  avatar: string | null;
  system_prompt: string;
  model_config: string | null;
  /** 该智能体执行时使用的 harness 底座 */
  harness: HarnessKind;
  status: AgentStatus;
  max_concurrency: number;
  timeout_sec: number | null;
  is_builtin: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryRow {
  id: string;
  agent_id: string;
  content: string;
  source_task_id: string | null;
  status: string;
  created_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  default_workspace: string | null;
  status: ProjectStatus;
  auto_schedule_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  id: string;
  project_id: string;
  agent_id: string;
  role_in_project: string | null;
  joined_at: number;
}

export interface TaskRow {
  id: string;
  project_id: string;
  agent_id: string;
  parent_id: string | null;
  name: string;
  description: string;
  workspace: string;
  status: TaskStatus;
  priority: TaskPriority;
  result: string | null;
  trigger_mode: TriggerMode;
  scheduled_at: number | null;
  cron_expr: string | null;
  next_run_at: number | null;
  not_before: number | null;
  retry_max: number;
  retry_interval: number;
  retry_backoff: RetryBackoff;
  retry_no: number;
  schedule_enabled: number;
  queued_at: number | null;
  enqueue_reason: string | null;
  pending_fire: number;
  timeout_sec: number | null;
  /** 待接续的执行 id（重试被中断的任务时写入，由执行引擎消费一次并复用该执行记录） */
  resume_execution_id: string | null;
  locked_by: string | null;
  locked_at: number | null;
  last_dispatch_error: string | null;
  last_dispatch_error_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DependencyRow {
  id: string;
  task_id: string;
  depends_on_task_id: string;
}

export interface ExecutionRow {
  id: string;
  task_id: string;
  agent_id: string;
  trigger_type: 'manual' | 'scheduler';
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

/**
 * 可授权的工具清单。
 *
 * **只包含 OpenPMS 自己提供的工具**——它们经 MCP 暴露、由服务端做「执行令牌 → 项目成员 →
 * 工具授权」三重鉴权，因此这套授权语义与 harness 底座完全无关：换任何底座，授权行为一致。
 *
 * harness 自身提供的工具（读写文件、执行命令、网络访问等）**不在授权范围内**，
 * 由各底座按自身默认行为提供，OpenPMS 不做按智能体的裁剪。
 */
export const TOOL_CATALOG = [
  { name: 'task.list_my', label: '查询我的任务', risk: 'low' },
  { name: 'task.update_status', label: '更新任务状态', risk: 'medium' },
  { name: 'task.submit_result', label: '回写任务产出', risk: 'medium' },
  { name: 'task.create_subtask', label: '拆解子任务', risk: 'high' },
  { name: 'task.reassign', label: '改派任务', risk: 'high' },
] as const;

export type ToolName = (typeof TOOL_CATALOG)[number]['name'];

export const DEFAULT_AGENT_TOOLS: Record<string, string[]> = {
  '项目经理': [
    'task.list_my',
    'task.update_status',
    'task.submit_result',
    'task.create_subtask',
    'task.reassign',
  ],
  '产品经理': ['task.list_my', 'task.update_status', 'task.submit_result'],
  '开发工程师': [
    'task.list_my',
    'task.update_status',
    'task.submit_result',
    'task.create_subtask',
  ],
  '测试工程师': ['task.list_my', 'task.update_status', 'task.submit_result'],
};
