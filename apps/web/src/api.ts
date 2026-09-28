/**
 * api.ts — 统一 fetch 封装与后端接口方法
 * 后端统一响应体 { code, message, data }，code === 0 表示成功。
 */
import type {
  Agent,
  AgentInput,
  Execution,
  HealthStatus,
  Member,
  Memory,
  Project,
  SchedulerStatus,
  StatusLog,
  SystemConfig,
  Task,
  TaskInput,
  TaskLogResponse,
  ToolAudit,
  ToolCatalogItem,
} from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type QueryValue = string | number | boolean | null | undefined;

function buildQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // 无 body 的请求（如 DELETE）不携带 content-type，避免服务端按空 JSON 解析报错
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (e) {
    throw new ApiError(`网络请求失败：${(e as Error).message}`, 'NETWORK', 0);
  }

  const raw = await res.text();
  let body: { code?: number | string; message?: string; data?: unknown; details?: unknown } | null = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!body || body.code === undefined) {
    if (!res.ok) {
      throw new ApiError(`请求失败（HTTP ${res.status}）`, `HTTP_${res.status}`, res.status);
    }
    return undefined as T;
  }

  if (body.code !== 0) {
    throw new ApiError(body.message || '请求失败', String(body.code), res.status, body.details);
  }
  return body.data as T;
}

const get = <T>(path: string, params: Record<string, QueryValue> = {}) =>
  request<T>(`${path}${buildQuery(params)}`);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
const del = <T>(path: string, params: Record<string, QueryValue> = {}) =>
  request<T>(`${path}${buildQuery(params)}`, { method: 'DELETE' });

/* ---------------- 智能体 ---------------- */

export const api = {
  listAgents: () => get<Agent[]>('/agents'),
  createAgent: (input: AgentInput) => post<Agent>('/agents', input),
  updateAgent: (id: string, input: Partial<AgentInput>) => patch<Agent>(`/agents/${id}`, input),
  deleteAgent: (id: string) => del<{ removed: boolean }>(`/agents/${id}`),
  enableAgent: (id: string) => post<Agent>(`/agents/${id}/enable`),
  disableAgent: (id: string) => post<Agent>(`/agents/${id}/disable`),

  listMemories: (agentId: string) => get<Memory[]>(`/agents/${agentId}/memories`),
  deleteMemory: (memoryId: string) => del<{ removed: boolean }>(`/memories/${memoryId}`),

  toolCatalog: () => get<ToolCatalogItem[]>('/tools/catalog'),

  /* ---------------- 项目与成员 ---------------- */

  listProjects: () => get<Project[]>('/projects'),
  createProject: (input: { name: string; description?: string | null; defaultWorkspace?: string | null }) =>
    post<Project>('/projects', input),
  updateProject: (
    id: string,
    input: {
      name?: string;
      description?: string | null;
      defaultWorkspace?: string | null;
      status?: 'active' | 'archived';
      autoScheduleEnabled?: boolean;
    },
  ) => patch<Project>(`/projects/${id}`, input),
  archiveProject: (id: string) => post<Project>(`/projects/${id}/archive`),
  deleteProject: (id: string, opts: { confirm?: boolean } = {}) =>
    del<{ removed: boolean; deletedTasks: number }>(`/projects/${id}`, {
      confirm: opts.confirm ? 'true' : undefined,
    }),
  listMembers: (projectId: string) => get<Member[]>(`/projects/${projectId}/members`),
  addMembers: (projectId: string, agentIds: string[]) =>
    post<Member[]>(`/projects/${projectId}/members`, { agentIds }),
  removeMember: (
    projectId: string,
    agentId: string,
    opts: { confirm?: boolean; strategy?: 'reassign' | 'keep'; reassignToAgentId?: string } = {},
  ) =>
    del<{ removed: boolean; reassigned: number }>(`/projects/${projectId}/members/${agentId}`, {
      confirm: opts.confirm ? 'true' : undefined,
      strategy: opts.strategy,
      reassignToAgentId: opts.reassignToAgentId,
    }),

  /* ---------------- 任务 ---------------- */

  listTasks: (params: { projectId?: string; status?: string; agentId?: string; keyword?: string } = {}) =>
    get<Task[]>('/tasks', params),
  getTask: (id: string) => get<Task>(`/tasks/${id}`),
  createTask: (input: TaskInput) => post<Task>('/tasks', input),
  updateTask: (id: string, input: Partial<TaskInput>) => patch<Task>(`/tasks/${id}`, input),
  deleteTask: (id: string) => del<{ removed: boolean }>(`/tasks/${id}`),
  startTask: (id: string) => post<Execution>(`/tasks/${id}/start`, {}),
  cancelTask: (id: string) => post<Task>(`/tasks/${id}/cancel`),
  retryTask: (id: string) => post<Task>(`/tasks/${id}/retry`),
  pauseSchedule: (id: string) => post<Task>(`/tasks/${id}/schedule/pause`),
  resumeSchedule: (id: string) => post<Task>(`/tasks/${id}/schedule/resume`),
  statusLogs: (id: string) => get<StatusLog[]>(`/tasks/${id}/status-logs`),
  taskExecutions: (id: string) => get<Execution[]>(`/tasks/${id}/executions`),
  queue: () => get<Task[]>('/queue'),

  /* ---------------- 执行与日志 ---------------- */

  recentExecutions: (limit = 50) => get<Execution[]>('/executions', { limit }),
  getExecution: (eid: string) => get<Execution>(`/executions/${eid}`),
  executionLogs: (eid: string, tail = 2000) => get<TaskLogResponse>(`/executions/${eid}/logs`, { tail }),

  /* ---------------- 调度与系统 ---------------- */

  schedulerStatus: () => get<SchedulerStatus>('/system/scheduler'),
  setSchedulerEnabled: (enabled: boolean) => put<SchedulerStatus>('/system/scheduler', { enabled }),
  schedulerTick: () => post<SchedulerStatus>('/system/scheduler/tick'),
  health: () => get<HealthStatus>('/system/health'),
  systemConfig: () => get<SystemConfig>('/system/config'),
  toolAudits: (limit = 100) => get<ToolAudit[]>('/tool-audits', { limit }),
};

export type Api = typeof api;
