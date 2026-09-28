/**
 * tools/service.ts — 面向智能体的任务管理工具（F-A-05）
 *
 * 以 MCP server 形式暴露给 opencode（见 tools/mcp-server.ts），
 * 内部走与人类用户相同的应用服务与状态机，不做旁路写入。
 * 三重鉴权：执行身份（token）→ 是否项目成员 → 是否拥有该工具。
 */
import type { Db } from '../platform/db.js';
import { idGen } from '../platform/ids.js';
import { now } from '../platform/time.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import type { AgentService } from '../agent/service.js';
import type { ProjectService } from '../project/service.js';
import type { TaskService } from '../task/service.js';
import { validateWorkspace } from '../sandbox/index.js';
import type { ExecutionRow, TaskRow, TaskStatus } from '../platform/types.js';
import { nextStatus, type TaskEvent } from '../task/state.js';

export interface ToolContext {
  execution: ExecutionRow;
  task: TaskRow;
  agentId: string;
}

export class ToolService {
  constructor(
    private readonly db: Db,
    private readonly agents: AgentService,
    private readonly projects: ProjectService,
    private readonly tasks: TaskService,
  ) {}

  /** 校验执行令牌（token = executionId，仅执行中有效） */
  authenticate(executionId: string): ToolContext {
    if (!executionId) throw badRequest('VALIDATION_DENIED', '缺少执行令牌');
    const execution = this.db.get<ExecutionRow>('SELECT * FROM task_executions WHERE id = ?', executionId);
    if (!execution) throw notFound('执行记录不存在');
    if (execution.status !== 'running') {
      throw badRequest('VALIDATION_DENIED', '该执行已结束，工具不可用');
    }
    const task = this.tasks.getRow(execution.task_id);
    if (!task) throw notFound('任务不存在');
    const agentId = execution.agent_id;

    // 必须仍是项目成员
    this.projects.assertMember(task.project_id, agentId);

    return { execution, task, agentId };
  }

  private assertTool(ctx: ToolContext, toolName: string): void {
    const agent = this.agents.getOrThrow(ctx.agentId);
    if (!agent.tools.includes(toolName)) {
      this.audit(ctx, toolName, 'denied', '未授权该工具');
      throw new AppError('VALIDATION_DENIED', `智能体未被授权使用工具 ${toolName}`, 403);
    }
  }

  private audit(ctx: ToolContext | null, toolName: string, decision: string, reason?: string, input?: unknown): void {
    this.db.run(
      `INSERT INTO tool_audits (id, execution_id, task_id, agent_id, tool_name, input, decision, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      idGen.toolAudit(),
      ctx?.execution.id ?? null,
      ctx?.task.id ?? null,
      ctx?.agentId ?? null,
      toolName,
      input ? JSON.stringify(input).slice(0, 4000) : null,
      decision,
      reason ?? null,
      now(),
    );
  }

  /** task.list_my */
  listMy(executionId: string, status?: TaskStatus): unknown[] {
    const ctx = this.authenticate(executionId);
    this.assertTool(ctx, 'task.list_my');
    const rows = this.tasks.list({
      projectId: ctx.task.project_id,
      agentId: ctx.agentId,
      status,
      limit: 100,
    });
    this.audit(ctx, 'task.list_my', 'allowed', undefined, { status });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      priority: t.priority,
      description: t.description.slice(0, 1000),
      result: t.result?.slice(0, 1000) ?? null,
    }));
  }

  /** task.update_status */
  updateStatus(executionId: string, status: TaskStatus, taskId?: string): unknown {
    const ctx = this.authenticate(executionId);
    this.assertTool(ctx, 'task.update_status');
    const targetId = taskId ?? ctx.task.id;
    const task = this.tasks.getRow(targetId);
    if (!task) throw notFound('任务不存在');
    // 只能操作本项目任务，且优先限本任务
    if (task.project_id !== ctx.task.project_id) {
      this.audit(ctx, 'task.update_status', 'denied', '跨项目操作');
      throw badRequest('VALIDATION_DENIED', '只能操作当前项目内的任务');
    }
    if (taskId && taskId !== ctx.task.id) {
      // 操作其他任务需是该项目成员（已校验）且为自己被指派的任务
      if (task.agent_id !== ctx.agentId) {
        this.audit(ctx, 'task.update_status', 'denied', '只能更新指派给自己的任务');
        throw badRequest('VALIDATION_DENIED', '只能更新指派给自己的任务');
      }
    }

    const event = this.eventForStatus(task.status, status);
    if (!event) {
      this.audit(ctx, 'task.update_status', 'denied', `非法流转 ${task.status} -> ${status}`);
      throw new AppError('ILLEGAL_TRANSITION', `非法状态流转：${task.status} → ${status}`, 400);
    }
    this.tasks.transition(targetId, event, 'agent', ctx.agentId, `智能体更新状态为 ${status}`);
    this.audit(ctx, 'task.update_status', 'allowed', undefined, { taskId: targetId, status });
    return { ok: true, taskId: targetId, status };
  }

  private eventForStatus(from: TaskStatus, to: TaskStatus): TaskEvent | null {
    const events: TaskEvent[] = [
      'start_manual',
      'enqueue',
      'requeue',
      'dispatch',
      'finish',
      'fail_retryable',
      'fail_final',
      'cancel',
      'retry',
      'reopen',
    ];
    for (const e of events) {
      if (nextStatus(from, e) === to) return e;
    }
    return null;
  }

  /** task.submit_result */
  submitResult(executionId: string, result: string, taskId?: string): unknown {
    const ctx = this.authenticate(executionId);
    this.assertTool(ctx, 'task.submit_result');
    if (!result?.trim()) throw badRequest('VALIDATION_DENIED', '产出内容不能为空');
    const targetId = taskId ?? ctx.task.id;
    const task = this.tasks.getRow(targetId);
    if (!task) throw notFound('任务不存在');
    if (task.agent_id !== ctx.agentId) {
      this.audit(ctx, 'task.submit_result', 'denied', '只能回写自己的任务');
      throw badRequest('VALIDATION_DENIED', '只能回写指派给自己的任务产出');
    }
    this.db.run('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?', result, now(), targetId);
    this.db.run('UPDATE task_executions SET result = ? WHERE id = ?', result, executionId);
    this.audit(ctx, 'task.submit_result', 'allowed', undefined, { taskId: targetId });
    return { ok: true, taskId: targetId, length: result.length };
  }

  /** 该项目可指派的成员列表文本，用于错误提示，便于智能体自我纠正 */
  private memberHint(projectId: string): string {
    const rows = this.db.all<{ agent_id: string; name: string }>(
      `SELECT pm.agent_id, a.name
       FROM project_members pm
       JOIN agents a ON a.id = pm.agent_id
       WHERE pm.project_id = ? AND a.status = 'enabled' AND a.deleted_at IS NULL
       ORDER BY pm.joined_at ASC`,
      projectId,
    );
    if (rows.length === 0) return '（该项目当前没有可指派的成员）';
    return rows.map((r) => `${r.name}=${r.agent_id}`).join('，');
  }

  /**
   * task.create_subtask
   *
   * 子任务默认自动派发，无需人工启动：
   * - 无前置依赖 → triggerMode = auto（创建即入队）
   * - 有前置依赖 → triggerMode = dependency（前置全部完成后自动入队）
   */
  createSubtask(
    executionId: string,
    input: {
      name: string;
      description: string;
      agentId: string;
      workspace?: string;
      priority?: 'low' | 'medium' | 'high';
      dependencyIds?: string[];
    },
  ): unknown {
    const ctx = this.authenticate(executionId);
    this.assertTool(ctx, 'task.create_subtask');
    const projectId = ctx.task.project_id;

    // 指派人必须是本项目成员（F-P-02）；错误信息附带可选成员，便于智能体自我纠正
    if (!this.projects.isMember(projectId, input.agentId)) {
      this.audit(ctx, 'task.create_subtask', 'denied', `agentId 非项目成员: ${input.agentId}`);
      throw badRequest(
        'NOT_PROJECT_MEMBER',
        `agentId「${input.agentId}」不是该项目的成员。可指派成员：${this.memberHint(projectId)}`,
      );
    }
    const targetAgent = this.agents.getRow(input.agentId);
    if (!targetAgent || targetAgent.status !== 'enabled') {
      this.audit(ctx, 'task.create_subtask', 'denied', '目标智能体不可用');
      throw badRequest(
        'AGENT_DISABLED',
        `智能体「${input.agentId}」已停用，不可指派。可指派成员：${this.memberHint(projectId)}`,
      );
    }

    const workspace = input.workspace ?? ctx.task.workspace;
    validateWorkspace(workspace);

    const dependencyIds = [...new Set(input.dependencyIds ?? [])].filter(Boolean);
    const triggerMode = dependencyIds.length > 0 ? 'dependency' : 'auto';

    const created = this.tasks.create({
      projectId,
      agentId: input.agentId,
      name: input.name,
      description: input.description,
      workspace,
      priority: input.priority ?? 'medium',
      triggerMode,
      dependencyIds,
      parentId: ctx.task.id,
      createdBy: `agent:${ctx.agentId}`,
    });
    this.audit(ctx, 'task.create_subtask', 'allowed', undefined, {
      taskId: created.id,
      agentId: input.agentId,
      triggerMode,
      dependencyIds,
    });
    return { ok: true, taskId: created.id, name: created.name, agentId: created.agentId, triggerMode };
  }

  /** task.reassign */
  reassign(executionId: string, input: { taskId: string; agentId: string }): unknown {
    const ctx = this.authenticate(executionId);
    this.assertTool(ctx, 'task.reassign');
    const task = this.tasks.getRow(input.taskId);
    if (!task) throw notFound('任务不存在');
    if (task.project_id !== ctx.task.project_id) {
      this.audit(ctx, 'task.reassign', 'denied', '跨项目改派');
      throw badRequest('VALIDATION_DENIED', '只能改派当前项目内的任务');
    }
    if (task.status === 'running') {
      throw new AppError('CONFLICT', '执行中的任务不可改派', 409);
    }
    // 目标必须是本项目成员；错误信息附带可选成员
    if (!this.projects.isMember(task.project_id, input.agentId)) {
      this.audit(ctx, 'task.reassign', 'denied', `agentId 非项目成员: ${input.agentId}`);
      throw badRequest(
        'NOT_PROJECT_MEMBER',
        `agentId「${input.agentId}」不是该项目的成员。可指派成员：${this.memberHint(task.project_id)}`,
      );
    }
    const target = this.agents.getRow(input.agentId);
    if (!target || target.status !== 'enabled') {
      this.audit(ctx, 'task.reassign', 'denied', '目标智能体不可用');
      throw badRequest(
        'AGENT_DISABLED',
        `智能体「${input.agentId}」已停用或不存在。可指派成员：${this.memberHint(task.project_id)}`,
      );
    }
    this.tasks.update(task.id, { agentId: input.agentId });
    this.audit(ctx, 'task.reassign', 'allowed', undefined, { taskId: task.id, agentId: input.agentId });
    return { ok: true, taskId: task.id, agentId: input.agentId };
  }
}
