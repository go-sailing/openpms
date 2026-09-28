/**
 * task/service.ts — 任务 CRUD、指派校验、依赖、状态机、队列
 * 对应需求：F-T-01、F-T-02、F-T-04、F-T-05（配置部分）
 */
import type { Db } from '../platform/db.js';
import { idGen } from '../platform/ids.js';
import { now } from '../platform/time.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import { bus } from '../platform/events.js';
import { isValidCron, nextCronTime } from '../platform/cron.js';
import { validateWorkspace } from '../sandbox/index.js';
import { deleteExecutionLogs } from '../execution/logs.js';
import type {
  DependencyRow,
  TaskPriority,
  TaskRow,
  TaskStatus,
  TriggerMode,
  ActorType,
} from '../platform/types.js';
import { nextStatus, type TaskEvent } from './state.js';

export interface TaskDTO {
  id: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  parentId: string | null;
  name: string;
  description: string;
  workspace: string;
  status: TaskStatus;
  priority: TaskPriority;
  result: string | null;
  triggerMode: TriggerMode;
  scheduledAt: number | null;
  cronExpr: string | null;
  nextRunAt: number | null;
  notBefore: number | null;
  retryMax: number;
  retryInterval: number;
  retryBackoff: string;
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
  priority?: TaskPriority;
  triggerMode?: TriggerMode;
  scheduledAt?: number | null;
  cronExpr?: string | null;
  retryMax?: number;
  retryInterval?: number;
  retryBackoff?: 'fixed' | 'exponential';
  timeoutSec?: number | null;
  parentId?: string | null;
  dependencyIds?: string[];
  createdBy?: string | null;
}

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus;
  agentId?: string;
  keyword?: string;
  limit?: number;
}

const PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";

export class TaskService {
  /** 任务进入终态后的回调（由调度器注入，用于依赖传播） */
  onSettled: ((taskId: string) => void) | null = null;

  constructor(private readonly db: Db) {}

  // ---------- 查询 ----------

  private dependenciesOf(taskId: string): string[] {
    return this.db
      .all<{ depends_on_task_id: string }>(
        'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?',
        taskId,
      )
      .map((r) => r.depends_on_task_id);
  }

  private toDTO(row: TaskRow): TaskDTO {
    const project = this.db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', row.project_id);
    const agent = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', row.agent_id);
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: project?.name ?? '(已删除项目)',
      agentId: row.agent_id,
      agentName: agent?.name ?? '(已删除智能体)',
      parentId: row.parent_id,
      name: row.name,
      description: row.description,
      workspace: row.workspace,
      status: row.status,
      priority: row.priority,
      result: row.result,
      triggerMode: row.trigger_mode,
      scheduledAt: row.scheduled_at,
      cronExpr: row.cron_expr,
      nextRunAt: row.next_run_at,
      notBefore: row.not_before,
      retryMax: row.retry_max,
      retryInterval: row.retry_interval,
      retryBackoff: row.retry_backoff,
      retryNo: row.retry_no,
      scheduleEnabled: row.schedule_enabled === 1,
      queuedAt: row.queued_at,
      enqueueReason: row.enqueue_reason,
      pendingFire: row.pending_fire === 1,
      timeoutSec: row.timeout_sec,
      lastDispatchError: row.last_dispatch_error,
      dependencyIds: this.dependenciesOf(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(filter: TaskFilter = {}): TaskDTO[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.agentId) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.keyword) {
      where.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    params.push(filter.limit ?? 200);
    return this.db.all<TaskRow>(sql, ...params).map((r) => this.toDTO(r));
  }

  /** 调度队列视图：排队中任务，按优先级 + 入队时间排序 */
  queue(): TaskDTO[] {
    return this.db
      .all<TaskRow>(
        `SELECT * FROM tasks WHERE status = 'queued' ORDER BY ${PRIORITY_ORDER}, queued_at ASC`,
      )
      .map((r) => this.toDTO(r));
  }

  getRow(id: string): TaskRow | undefined {
    return this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  }

  getOrThrow(id: string): TaskDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`任务不存在: ${id}`);
    return this.toDTO(row);
  }

  // ---------- 校验 ----------

  private assertAssignable(projectId: string, agentId: string): void {
    const project = this.db.get<{ status: string }>('SELECT status FROM projects WHERE id = ?', projectId);
    if (!project) throw notFound(`项目不存在: ${projectId}`);
    const member = this.db.get<{ id: string }>(
      'SELECT id FROM project_members WHERE project_id = ? AND agent_id = ?',
      projectId,
      agentId,
    );
    if (!member) {
      throw badRequest('NOT_PROJECT_MEMBER', '只能指派给当前项目成员中的智能体');
    }
    const agent = this.db.get<{ status: string; deleted_at: number | null }>(
      'SELECT status, deleted_at FROM agents WHERE id = ?',
      agentId,
    );
    if (!agent || agent.deleted_at) throw notFound(`智能体不存在: ${agentId}`);
    if (agent.status !== 'enabled') throw badRequest('AGENT_DISABLED', '被指派智能体已停用，无法指派');
  }

  private validateSchedule(input: {
    triggerMode: TriggerMode;
    scheduledAt?: number | null;
    cronExpr?: string | null;
    dependencyIds?: string[];
    /** 编辑场景下，计划时间沿用原值（可能已成为历史）时允许通过 */
    allowPastScheduledAt?: boolean;
  }): { nextRunAt: number | null } {
    const { triggerMode } = input;
    if (triggerMode === 'scheduled') {
      if (input.cronExpr) {
        if (!isValidCron(input.cronExpr)) {
          throw badRequest('VALIDATION_DENIED', `重复规则（Cron）非法: ${input.cronExpr}`);
        }
        return { nextRunAt: nextCronTime(input.cronExpr) };
      }
      if (!input.scheduledAt) {
        throw badRequest('VALIDATION_DENIED', '定时任务必须设置计划执行时间或 Cron 重复规则');
      }
      if (!input.allowPastScheduledAt && input.scheduledAt < Date.now() - 1000) {
        throw badRequest('VALIDATION_DENIED', '计划执行时间不能早于当前时间');
      }
      return { nextRunAt: input.scheduledAt };
    }
    if (triggerMode === 'dependency') {
      if (!input.dependencyIds || input.dependencyIds.length === 0) {
        throw badRequest('VALIDATION_DENIED', '依赖触发任务必须设置至少一个前置依赖任务');
      }
      return { nextRunAt: null };
    }
    if (triggerMode === 'auto') return { nextRunAt: null };
    return { nextRunAt: null };
  }

  /** 依赖合法性：同项目、非自身、无环 */
  private assertDependencies(taskId: string, projectId: string, depIds: string[]): void {
    const uniq = [...new Set(depIds)];
    for (const depId of uniq) {
      if (depId === taskId) throw badRequest('VALIDATION_DENIED', '任务不能依赖自身');
      const dep = this.db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', depId);
      if (!dep) throw notFound(`前置依赖任务不存在: ${depId}`);
      if (dep.project_id !== projectId) {
        throw badRequest('VALIDATION_DENIED', '前置依赖任务必须与当前任务属于同一项目');
      }
    }
    // DFS 环检测：把 new edges 合入后检查
    const edges = new Map<string, string[]>();
    const existing = this.db.all<DependencyRow>('SELECT * FROM task_dependencies');
    for (const e of existing) {
      if (e.task_id === taskId) continue; // 旧边将被替换
      const arr = edges.get(e.task_id) ?? [];
      arr.push(e.depends_on_task_id);
      edges.set(e.task_id, arr);
    }
    edges.set(taskId, uniq);

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const visit = (n: string): void => {
      color.set(n, GRAY);
      for (const m of edges.get(n) ?? []) {
        const c = color.get(m) ?? WHITE;
        if (c === GRAY) throw badRequest('VALIDATION_DENIED', '检测到循环依赖，无法保存');
        if (c === WHITE) visit(m);
      }
      color.set(n, BLACK);
    };
    for (const node of edges.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    }
  }

  // ---------- 写操作 ----------

  create(input: TaskInput): TaskDTO {
    if (!input.name?.trim()) throw badRequest('VALIDATION_DENIED', '任务名称必填');
    if (!input.description?.trim()) throw badRequest('VALIDATION_DENIED', '任务描述必填');

    const project = this.db.get<{ default_workspace: string | null; status: string; auto_schedule_enabled: number }>(
      'SELECT default_workspace, status, auto_schedule_enabled FROM projects WHERE id = ?',
      input.projectId,
    );
    if (!project) throw notFound(`项目不存在: ${input.projectId}`);
    if (project.status === 'archived') throw badRequest('VALIDATION_DENIED', '已归档项目不可新建任务');

    const members = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?',
      input.projectId,
    );
    if ((members?.c ?? 0) === 0) {
      throw badRequest('VALIDATION_DENIED', '该项目暂无成员，请先添加项目成员后再创建任务');
    }

    this.assertAssignable(input.projectId, input.agentId);

    const workspaceInput = input.workspace ?? project.default_workspace;
    const ws = validateWorkspace(workspaceInput ?? '');

    const triggerMode: TriggerMode = input.triggerMode ?? 'manual';
    const { nextRunAt } = this.validateSchedule({
      triggerMode,
      scheduledAt: input.scheduledAt,
      cronExpr: input.cronExpr,
      dependencyIds: input.dependencyIds,
    });

    if (input.parentId) {
      const parent = this.db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', input.parentId);
      if (!parent) throw notFound(`父任务不存在: ${input.parentId}`);
      if (parent.project_id !== input.projectId) {
        throw badRequest('VALIDATION_DENIED', '父子任务必须属于同一项目');
      }
    }

    const id = idGen.task();
    const depIds = input.dependencyIds ?? [];
    if (triggerMode === 'dependency') this.assertDependencies(id, input.projectId, depIds);

    const ts = now();
    const isAuto = triggerMode === 'auto';
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO tasks (id, project_id, agent_id, parent_id, name, description, workspace, status,
                            priority, trigger_mode, scheduled_at, cron_expr, next_run_at, not_before,
                            retry_max, retry_interval, retry_backoff, retry_no, schedule_enabled,
                            queued_at, enqueue_reason, pending_fire, timeout_sec, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 1, ?, ?, 0, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.agentId,
        input.parentId ?? null,
        input.name.trim(),
        input.description,
        ws.realPath,
        isAuto ? 'queued' : 'pending',
        input.priority ?? 'medium',
        triggerMode,
        input.scheduledAt ?? null,
        input.cronExpr ?? null,
        nextRunAt,
        input.retryMax ?? 0,
        input.retryInterval ?? 0,
        input.retryBackoff ?? 'fixed',
        isAuto ? ts : null,
        isAuto ? 'auto' : null,
        input.timeoutSec ?? null,
        input.createdBy ?? null,
        ts,
        ts,
      );
      for (const depId of depIds) {
        this.db.run(
          'INSERT INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (?, ?, ?)',
          idGen.dependency(),
          id,
          depId,
        );
      }
      this.logStatus(id, null, isAuto ? 'queued' : 'pending', 'user', input.createdBy ?? null, '创建任务');
    });

    bus.emit({ type: 'task.updated', taskId: id, projectId: input.projectId, payload: { action: 'created' } });
    if (isAuto) bus.emit({ type: 'queue.updated', projectId: input.projectId, payload: { action: 'enqueued', taskId: id } });
    return this.getOrThrow(id);
  }

  update(id: string, input: Partial<TaskInput>): TaskDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`任务不存在: ${id}`);
    if (row.status === 'running') {
      throw new AppError('CONFLICT', '执行中的任务不可编辑', 409);
    }

    const projectId = row.project_id;
    const agentId = input.agentId ?? row.agent_id;
    if (input.agentId && input.agentId !== row.agent_id) {
      // 仅校验成员与启用状态；执行中的任务已在上方统一拒绝编辑
      this.assertAssignable(projectId, input.agentId);
    }

    const workspace = input.workspace !== undefined ? input.workspace : row.workspace;
    const ws = validateWorkspace(workspace ?? '');

    const triggerMode = input.triggerMode ?? row.trigger_mode;
    const scheduledAt = input.scheduledAt !== undefined ? input.scheduledAt : row.scheduled_at;
    const cronExpr = input.cronExpr !== undefined ? input.cronExpr : row.cron_expr;
    const depIds = input.dependencyIds ?? this.dependenciesOf(id);
    const { nextRunAt } = this.validateSchedule({
      triggerMode,
      scheduledAt,
      cronExpr,
      dependencyIds: depIds,
      // 计划时间未改动时允许保留历史值，否则「编辑」会被"不能早于当前时间"卡住
      allowPastScheduledAt: scheduledAt === row.scheduled_at,
    });
    if (triggerMode === 'dependency') this.assertDependencies(id, projectId, depIds);

    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `UPDATE tasks SET agent_id = ?, name = ?, description = ?, workspace = ?, priority = ?,
                          trigger_mode = ?, scheduled_at = ?, cron_expr = ?, next_run_at = ?,
                          retry_max = ?, retry_interval = ?, retry_backoff = ?, timeout_sec = ?, updated_at = ?
         WHERE id = ?`,
        agentId,
        input.name?.trim() || row.name,
        input.description ?? row.description,
        ws.realPath,
        input.priority ?? row.priority,
        triggerMode,
        scheduledAt ?? null,
        cronExpr ?? null,
        nextRunAt,
        input.retryMax ?? row.retry_max,
        input.retryInterval ?? row.retry_interval,
        input.retryBackoff ?? row.retry_backoff,
        input.timeoutSec !== undefined ? input.timeoutSec : row.timeout_sec,
        ts,
        id,
      );
      if (input.dependencyIds) {
        this.db.run('DELETE FROM task_dependencies WHERE task_id = ?', id);
        for (const depId of depIds) {
          this.db.run(
            'INSERT INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (?, ?, ?)',
            idGen.dependency(),
            id,
            depId,
          );
        }
      }
    });

    bus.emit({ type: 'task.updated', taskId: id, projectId, payload: { action: 'updated' } });
    // 触发方式改为「自动派发」且任务仍待处理时，立即入队
    if (triggerMode === 'auto' && row.status === 'pending') {
      this.enqueue(id, 'auto');
    }
    return this.getOrThrow(id);
  }

  remove(id: string): void {
    const row = this.getRow(id);
    if (!row) throw notFound(`任务不存在: ${id}`);
    if (row.status === 'running') throw new AppError('CONFLICT', '执行中的任务不可删除，请先取消执行', 409);
    const running = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM task_executions WHERE task_id = ? AND status = 'running'",
      id,
    );
    if ((running?.c ?? 0) > 0) throw new AppError('CONFLICT', '该任务有正在进行的执行，请先取消', 409);

    const children = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ?', id);
    if ((children?.c ?? 0) > 0) throw new AppError('CONFLICT', '存在子任务，请先删除子任务', 409);

    // 被其他任务依赖时，删除会破坏依赖链，要求先解除依赖
    const dependents = this.db.all<{ name: string }>(
      `SELECT t.name FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ?`,
      id,
    );
    if (dependents.length > 0) {
      throw new AppError(
        'CONFLICT',
        `该任务被其他任务依赖（${dependents.map((d) => d.name).join('、')}），请先移除这些依赖后再删除`,
        409,
      );
    }

    const executionIds = this.db
      .all<{ id: string }>('SELECT id FROM task_executions WHERE task_id = ?', id)
      .map((r) => r.id);

    this.db.tx(() => {
      this.db.run('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?', id, id);
      this.db.run('DELETE FROM task_status_logs WHERE task_id = ?', id);
      this.db.run('DELETE FROM task_executions WHERE task_id = ?', id);
      this.db.run('DELETE FROM tool_audits WHERE task_id = ?', id);
      this.db.run('DELETE FROM tasks WHERE id = ?', id);
    });

    for (const eid of executionIds) {
      try {
        deleteExecutionLogs(eid);
      } catch {
        /* 日志文件删除失败不影响主流程 */
      }
    }

    bus.emit({ type: 'task.updated', taskId: id, projectId: row.project_id, payload: { action: 'deleted' } });
    bus.emit({ type: 'queue.updated', projectId: row.project_id, payload: { action: 'deleted', taskId: id } });
  }

  /** 入队（幂等）：仅当处于可入队状态生效 */
  enqueue(id: string, reason: string): boolean {
    const row = this.getRow(id);
    if (!row) return false;
    const ts = now();
    const r = this.db.run(
      `UPDATE tasks SET status = 'queued', queued_at = ?, enqueue_reason = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending')`,
      ts,
      reason,
      ts,
      id,
    );
    if (r.changes === 1) {
      this.logStatus(id, 'pending', 'queued', 'scheduler', null, `入队：${reason}`);
      bus.emit({ type: 'queue.updated', projectId: row.project_id, payload: { action: 'enqueued', taskId: id, reason } });
      return true;
    }
    return false;
  }

  /** 手动重新执行前的重置：清空重试计数与派发退避，给出全新的重试预算 */
  resetRetryState(id: string): void {
    this.db.run(
      `UPDATE tasks SET retry_no = 0, not_before = NULL,
                        last_dispatch_error = NULL, last_dispatch_error_at = NULL, updated_at = ?
       WHERE id = ?`,
      now(),
      id,
    );
  }

  /** 暂停/恢复单任务调度 */
  setScheduleEnabled(id: string, enabled: boolean): TaskDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`任务不存在: ${id}`);
    this.db.run('UPDATE tasks SET schedule_enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), id);
    bus.emit({ type: 'queue.updated', projectId: row.project_id, payload: { action: enabled ? 'resumed' : 'paused', taskId: id } });
    return this.getOrThrow(id);
  }

  // ---------- 状态机 ----------

  logStatus(
    taskId: string,
    from: TaskStatus | null,
    to: TaskStatus,
    actorType: ActorType,
    actorId: string | null,
    reason: string | null,
  ): void {
    this.db.run(
      `INSERT INTO task_status_logs (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      idGen.statusLog(),
      taskId,
      from,
      to,
      actorType,
      actorId,
      reason,
      now(),
    );
  }

  /**
   * 统一状态迁移入口。非法迁移抛 ILLEGAL_TRANSITION。
   * @param reason 说明，写入审计日志
   */
  transition(
    id: string,
    event: TaskEvent,
    actorType: ActorType,
    actorId: string | null = null,
    reason: string | null = null,
  ): TaskDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`任务不存在: ${id}`);
    const target = nextStatus(row.status, event);
    if (!target) {
      throw new AppError(
        'ILLEGAL_TRANSITION',
        `非法状态流转：${row.status} --${event}--> ?`,
        400,
        { from: row.status, event },
      );
    }
    if (row.schedule_enabled === 0 && (event === 'dispatch' || event === 'start_manual')) {
      throw badRequest('VALIDATION_DENIED', '该任务调度已暂停，请先恢复调度');
    }

    const ts = now();
    this.db.run(
      `UPDATE tasks SET status = ?, updated_at = ?,
                        queued_at = CASE WHEN ? = 'queued' THEN ? ELSE queued_at END,
                        enqueue_reason = CASE WHEN ? = 'queued' THEN COALESCE(?, enqueue_reason) ELSE enqueue_reason END
       WHERE id = ?`,
      target,
      ts,
      target,
      ts,
      target,
      reason,
      id,
    );
    this.logStatus(id, row.status, target, actorType, actorId, reason ?? `事件 ${event}`);

    bus.emit({
      type: 'task.updated',
      taskId: id,
      projectId: row.project_id,
      payload: { action: 'status', from: row.status, to: target, event },
    });

    if (target === 'done' || target === 'failed' || target === 'cancelled') {
      this.onSettled?.(id);
    }
    return this.getOrThrow(id);
  }

  /** 记录派发失败原因 */
  markDispatchError(id: string, message: string): void {
    this.db.run(
      'UPDATE tasks SET last_dispatch_error = ?, last_dispatch_error_at = ?, updated_at = ? WHERE id = ?',
      message,
      now(),
      now(),
      id,
    );
  }

  statusLogs(taskId: string): Record<string, unknown>[] {
    return this.db.all('SELECT * FROM task_status_logs WHERE task_id = ? ORDER BY created_at ASC', taskId);
  }
}
