/**
 * project/service.ts — 项目与项目成员
 * 对应需求：F-P-01、F-P-02
 */
import type { Db } from '../platform/db.js';
import { idGen } from '../platform/ids.js';
import { now } from '../platform/time.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import { bus } from '../platform/events.js';
import { deleteExecutionLogs } from '../execution/logs.js';
import type { MemberRow, ProjectRow, TaskRow } from '../platform/types.js';

export interface ProjectDTO {
  id: string;
  name: string;
  description: string | null;
  defaultWorkspace: string | null;
  status: string;
  autoScheduleEnabled: boolean;
  memberCount: number;
  taskCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemberDTO {
  id: string;
  projectId: string;
  agentId: string;
  roleInProject: string | null;
  joinedAt: number;
  agentName: string;
  agentRole: string | null;
  agentStatus: string;
  openTaskCount: number;
}

const OPEN_STATUSES = "('pending','queued','running')";

function rowToDTO(r: ProjectRow, memberCount: number, taskCount: number): ProjectDTO {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    defaultWorkspace: r.default_workspace,
    status: r.status,
    autoScheduleEnabled: r.auto_schedule_enabled === 1,
    memberCount,
    taskCount,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProjectService {
  constructor(private readonly db: Db) {}

  private counts(projectId: string): { memberCount: number; taskCount: number } {
    const m = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?', projectId);
    const t = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?', projectId);
    return { memberCount: m?.c ?? 0, taskCount: t?.c ?? 0 };
  }

  private toDTO(r: ProjectRow): ProjectDTO {
    const { memberCount, taskCount } = this.counts(r.id);
    return rowToDTO(r, memberCount, taskCount);
  }

  list(): ProjectDTO[] {
    return this.db
      .all<ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC')
      .map((r) => this.toDTO(r));
  }

  getOrThrow(id: string): ProjectDTO {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
    if (!row) throw notFound(`项目不存在: ${id}`);
    return this.toDTO(row);
  }

  getRow(id: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  }

  create(input: {
    name: string;
    description?: string | null;
    defaultWorkspace?: string | null;
  }): ProjectDTO {
    if (!input.name?.trim()) throw badRequest('VALIDATION_DENIED', '项目名称必填');
    const ts = now();
    const id = idGen.project();
    this.db.run(
      `INSERT INTO projects (id, name, description, default_workspace, status, auto_schedule_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
      id,
      input.name.trim(),
      input.description ?? null,
      input.defaultWorkspace ?? null,
      ts,
      ts,
    );
    bus.emit({ type: 'project.updated', projectId: id, payload: { action: 'created' } });
    return this.getOrThrow(id);
  }

  update(
    id: string,
    input: Partial<{
      name: string;
      description: string | null;
      defaultWorkspace: string | null;
      status: 'active' | 'archived';
      autoScheduleEnabled: boolean;
    }>,
  ): ProjectDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`项目不存在: ${id}`);
    this.db.run(
      `UPDATE projects SET name = ?, description = ?, default_workspace = ?, status = ?,
                           auto_schedule_enabled = ?, updated_at = ?
       WHERE id = ?`,
      input.name?.trim() || row.name,
      input.description !== undefined ? input.description : row.description,
      input.defaultWorkspace !== undefined ? input.defaultWorkspace : row.default_workspace,
      input.status ?? row.status,
      input.autoScheduleEnabled !== undefined ? (input.autoScheduleEnabled ? 1 : 0) : row.auto_schedule_enabled,
      now(),
      id,
    );
    bus.emit({ type: 'project.updated', projectId: id, payload: { action: 'updated' } });
    return this.getOrThrow(id);
  }

  archive(id: string): ProjectDTO {
    return this.update(id, { status: 'archived' });
  }

  // ---- 项目成员（F-P-02） ----

  listMembers(projectId: string): MemberDTO[] {
    return this.db
      .all<MemberRow & { agent_name: string; agent_role: string | null; agent_status: string }>(
        `SELECT pm.*, a.name AS agent_name, a.role AS agent_role, a.status AS agent_status
         FROM project_members pm
         JOIN agents a ON a.id = pm.agent_id
         WHERE pm.project_id = ?
         ORDER BY pm.joined_at ASC`,
        projectId,
      )
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        agentId: r.agent_id,
        roleInProject: r.role_in_project,
        joinedAt: r.joined_at,
        agentName: r.agent_name,
        agentRole: r.agent_role,
        agentStatus: r.agent_status,
        openTaskCount:
          this.db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND agent_id = ? AND status IN ${OPEN_STATUSES}`,
            projectId,
            r.agent_id,
          )?.c ?? 0,
      }));
  }

  isMember(projectId: string, agentId: string): boolean {
    const r = this.db.get<{ id: string }>(
      'SELECT id FROM project_members WHERE project_id = ? AND agent_id = ?',
      projectId,
      agentId,
    );
    return Boolean(r);
  }

  /** 任务指派/调度派发合法性的唯一判定入口。 */
  assertMember(projectId: string, agentId: string): void {
    if (!this.isMember(projectId, agentId)) {
      throw badRequest('NOT_PROJECT_MEMBER', '被指派智能体不是该项目成员，无法指派或执行该项目任务');
    }
  }

  addMembers(projectId: string, agentIds: string[]): MemberDTO[] {
    const project = this.getRow(projectId);
    if (!project) throw notFound(`项目不存在: ${projectId}`);
    if (project.status === 'archived') throw badRequest('VALIDATION_DENIED', '已归档项目不可增减成员');
    if (agentIds.length === 0) throw badRequest('VALIDATION_DENIED', '请至少选择一个智能体');

    const ts = now();
    this.db.tx(() => {
      for (const agentId of agentIds) {
        const agent = this.db.get<{ id: string; status: string; deleted_at: number | null }>(
          'SELECT id, status, deleted_at FROM agents WHERE id = ?',
          agentId,
        );
        if (!agent || agent.deleted_at) throw notFound(`智能体不存在: ${agentId}`);
        if (agent.status !== 'enabled') {
          throw badRequest('AGENT_DISABLED', '已停用的智能体不可加入项目成员');
        }
        if (this.isMember(projectId, agentId)) {
          throw badRequest('CONFLICT', '该智能体已是项目成员');
        }
        this.db.run(
          `INSERT INTO project_members (id, project_id, agent_id, role_in_project, joined_at)
           VALUES (?, ?, ?, NULL, ?)`,
          idGen.member(),
          projectId,
          agentId,
          ts,
        );
      }
    });
    bus.emit({ type: 'project.updated', projectId, payload: { action: 'members-changed' } });
    return this.listMembers(projectId);
  }

  /** 成员在该项目下的未完成任务数 */
  openTasksOfMember(projectId: string, agentId: string): TaskRow[] {
    return this.db.all<TaskRow>(
      `SELECT * FROM tasks WHERE project_id = ? AND agent_id = ? AND status IN ${OPEN_STATUSES}`,
      projectId,
      agentId,
    );
  }

  /**
   * 移除成员。
   * strategy=reassign：把其未完成任务批量改派给 reassignToAgentId；
   * strategy=keep：保留任务，调度派发时会被前置校验拦截。
   */
  removeMember(
    projectId: string,
    agentId: string,
    opts: { confirm?: boolean; strategy?: 'reassign' | 'keep'; reassignToAgentId?: string } = {},
  ): { removed: true; reassigned: number } {
    const project = this.getRow(projectId);
    if (!project) throw notFound(`项目不存在: ${projectId}`);
    if (!this.isMember(projectId, agentId)) throw notFound('该智能体不是项目成员');

    const openTasks = this.openTasksOfMember(projectId, agentId);
    const strategy = opts.strategy ?? 'keep';

    if (openTasks.length > 0 && !opts.confirm) {
      throw badRequest(
        'VALIDATION_DENIED',
        `该成员在项目下还有 ${openTasks.length} 个未完成任务，请确认处理方式后再移除`,
        {
          requiresConfirm: true,
          openTasks: openTasks.map((t) => ({ id: t.id, name: t.name, status: t.status })),
          strategies: ['reassign', 'keep'],
        },
      );
    }

    let reassigned = 0;
    this.db.tx(() => {
      if (strategy === 'reassign' && openTasks.length > 0) {
        const target = opts.reassignToAgentId;
        if (!target) throw badRequest('VALIDATION_DENIED', '改派需要指定目标成员');
        if (target === agentId) throw badRequest('VALIDATION_DENIED', '改派目标不能是本人');
        if (!this.isMember(projectId, target)) {
          throw badRequest('NOT_PROJECT_MEMBER', '改派目标必须是该项目成员');
        }
        const targetAgent = this.db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', target);
        if (targetAgent?.status !== 'enabled') throw badRequest('AGENT_DISABLED', '改派目标智能体已停用');
        for (const t of openTasks) {
          this.db.run('UPDATE tasks SET agent_id = ?, updated_at = ? WHERE id = ?', target, now(), t.id);
          reassigned += 1;
        }
      }
      this.db.run('DELETE FROM project_members WHERE project_id = ? AND agent_id = ?', projectId, agentId);
    });

    bus.emit({ type: 'project.updated', projectId, payload: { action: 'members-changed' } });
    return { removed: true, reassigned };
  }

  /**
   * 删除项目（级联删除其任务、依赖、执行记录、成员关系）。
   * 存在执行中的任务时拒绝；项目下已有任务或成员时需显式 confirm。
   */
  remove(projectId: string, opts: { confirm?: boolean } = {}): { removed: true; deletedTasks: number } {
    const project = this.getRow(projectId);
    if (!project) throw notFound(`项目不存在: ${projectId}`);

    const running = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM tasks t
       JOIN task_executions e ON e.task_id = t.id
       WHERE t.project_id = ? AND e.status = 'running'`,
      projectId,
    );
    if ((running?.c ?? 0) > 0) {
      throw new AppError('CONFLICT', '项目下存在正在执行的任务，请先取消后再删除', 409);
    }

    const { memberCount, taskCount } = this.counts(projectId);
    if (!opts.confirm && (taskCount > 0 || memberCount > 0)) {
      throw badRequest('VALIDATION_DENIED', '删除项目将同时删除其任务与成员关系，请确认后再操作', {
        requiresConfirm: true,
        taskCount,
        memberCount,
      });
    }

    const tasks = this.db.all<{ id: string }>('SELECT id FROM tasks WHERE project_id = ?', projectId);
    const taskIds = tasks.map((t) => t.id);
    const executionIds = taskIds.length
      ? this.db
          .all<{ id: string }>(
            `SELECT id FROM task_executions WHERE task_id IN (${taskIds.map(() => '?').join(',')})`,
            ...taskIds,
          )
          .map((r) => r.id)
      : [];

    this.db.tx(() => {
      if (taskIds.length > 0) {
        const ph = taskIds.map(() => '?').join(',');
        this.db.run(
          `DELETE FROM task_dependencies WHERE task_id IN (${ph}) OR depends_on_task_id IN (${ph})`,
          ...taskIds,
          ...taskIds,
        );
        this.db.run(`DELETE FROM task_status_logs WHERE task_id IN (${ph})`, ...taskIds);
        this.db.run(`DELETE FROM task_executions WHERE task_id IN (${ph})`, ...taskIds);
        this.db.run(`DELETE FROM tool_audits WHERE task_id IN (${ph})`, ...taskIds);
        this.db.run(`DELETE FROM tasks WHERE project_id = ?`, projectId);
      }
      this.db.run('DELETE FROM project_members WHERE project_id = ?', projectId);
      this.db.run('DELETE FROM projects WHERE id = ?', projectId);
    });

    for (const eid of executionIds) {
      try {
        deleteExecutionLogs(eid);
      } catch {
        /* 日志文件删除失败不影响主流程 */
      }
    }

    bus.emit({ type: 'project.updated', projectId, payload: { action: 'deleted' } });
    bus.emit({ type: 'queue.updated', projectId, payload: { action: 'project-deleted' } });
    return { removed: true, deletedTasks: taskIds.length };
  }
}
