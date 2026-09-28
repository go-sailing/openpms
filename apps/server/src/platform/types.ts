/**
 * platform/types.ts — 领域类型定义
 */
export type AgentStatus = 'enabled' | 'disabled';
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

/** 可授权工具清单（对应 opencode 权限键） */
export const TOOL_CATALOG = [
  { name: 'fs.read', label: '读取文件', risk: 'low', permissionKey: 'read' },
  { name: 'fs.edit', label: '写入/编辑文件', risk: 'high', permissionKey: 'edit' },
  { name: 'fs.glob', label: '按模式查找文件', risk: 'low', permissionKey: 'glob' },
  { name: 'fs.grep', label: '内容检索', risk: 'low', permissionKey: 'grep' },
  { name: 'fs.list', label: '列目录', risk: 'low', permissionKey: 'list' },
  { name: 'shell', label: '执行 Shell 命令', risk: 'high', permissionKey: 'bash' },
  { name: 'webfetch', label: '抓取网页', risk: 'medium', permissionKey: 'webfetch' },
  { name: 'websearch', label: '网络搜索', risk: 'medium', permissionKey: 'websearch' },
  { name: 'task.list_my', label: '查询我的任务', risk: 'low', permissionKey: 'mcp' },
  { name: 'task.update_status', label: '更新任务状态', risk: 'medium', permissionKey: 'mcp' },
  { name: 'task.submit_result', label: '回写任务产出', risk: 'medium', permissionKey: 'mcp' },
  { name: 'task.create_subtask', label: '拆解子任务', risk: 'high', permissionKey: 'mcp' },
  { name: 'task.reassign', label: '改派任务', risk: 'high', permissionKey: 'mcp' },
] as const;

export type ToolName = (typeof TOOL_CATALOG)[number]['name'];

export const DEFAULT_AGENT_TOOLS: Record<string, string[]> = {
  '项目经理': [
    'fs.read',
    'fs.glob',
    'fs.grep',
    'fs.list',
    'task.list_my',
    'task.update_status',
    'task.submit_result',
    'task.create_subtask',
    'task.reassign',
  ],
  '产品经理': [
    'fs.read',
    'fs.edit',
    'fs.glob',
    'fs.grep',
    'fs.list',
    'webfetch',
    'websearch',
    'task.list_my',
    'task.update_status',
    'task.submit_result',
  ],
  '开发工程师': [
    'fs.read',
    'fs.edit',
    'fs.glob',
    'fs.grep',
    'fs.list',
    'shell',
    'task.list_my',
    'task.update_status',
    'task.submit_result',
    'task.create_subtask',
  ],
  '测试工程师': [
    'fs.read',
    'fs.edit',
    'fs.glob',
    'fs.grep',
    'fs.list',
    'shell',
    'task.list_my',
    'task.update_status',
    'task.submit_result',
  ],
};
