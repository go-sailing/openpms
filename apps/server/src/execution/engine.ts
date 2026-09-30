/**
 * execution/engine.ts — 执行引擎（SDD 第 4、5 章）
 *
 * 手动触发与调度触发共用同一执行引擎。
 * 职责：启动 opencode 会话、流式回传日志、执行超时与中止、产出回写、
 *       记忆自动沉淀、失败重试决策、并发槽位占用与释放。
 */
import type { Db } from '../platform/db.js';
import { config } from '../platform/config.js';
import { idGen } from '../platform/ids.js';
import { now } from '../platform/time.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import { bus } from '../platform/events.js';
import { validateWorkspace } from '../sandbox/index.js';
import { normalizeHarness, type AgentRow, type ExecutionRow, type TaskRow } from '../platform/types.js';
import type { AgentService } from '../agent/service.js';
import type { ProjectService } from '../project/service.js';
import type { TaskService } from '../task/service.js';
import { ExecutionLogWriter } from './logs.js';
import type { RuntimeRegistry } from '../runtime/index.js';
import type {
  AgentConfigForRun,
  CompletedTaskSummary,
  ExecutionResult,
  MemoryItem,
  ProjectMemberInfo,
  SessionHandle,
} from '../runtime/types.js';

interface RunningInfo {
  executionId: string;
  taskId: string;
  agentId: string;
  controller: AbortController;
  handle: SessionHandle | null;
  timer: NodeJS.Timeout | null;
  cancelRequested: boolean;
}

export interface StartOptions {
  taskId: string;
  triggerType: 'manual' | 'scheduler';
  actorId?: string | null;
}

export class ExecutionEngine {
  private readonly running = new Map<string, RunningInfo>();

  constructor(
    private readonly db: Db,
    private readonly agents: AgentService,
    private readonly projects: ProjectService,
    private readonly tasks: TaskService,
    private readonly runtimes: RuntimeRegistry,
  ) {}

  // ---------- 槽位与状态 ----------

  runningCount(): number {
    const r = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM task_executions WHERE status = 'running'",
    );
    return r?.c ?? 0;
  }

  agentRunningCount(agentId: string): number {
    const r = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM task_executions WHERE status = 'running' AND agent_id = ?",
      agentId,
    );
    return r?.c ?? 0;
  }

  isTaskRunning(taskId: string): boolean {
    const r = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM task_executions WHERE task_id = ? AND status = 'running'",
      taskId,
    );
    return (r?.c ?? 0) > 0;
  }

  isAgentSaturated(agent: AgentRow): boolean {
    return this.agentRunningCount(agent.id) >= Math.max(1, agent.max_concurrency);
  }

  // ---------- 启动 ----------

  /**
   * 启动一次执行。scheduler 调用前已完成 CAS 占用（任务已置 running）；
   * manual 调用则由本方法完成校验与状态迁移。
   */
  async start(opts: StartOptions): Promise<ExecutionRow> {
    const task = this.tasks.getRow(opts.taskId);
    if (!task) throw notFound(`任务不存在: ${opts.taskId}`);
    const agent = this.agents.getRow(task.agent_id);
    if (!agent) throw notFound(`智能体不存在: ${task.agent_id}`);

    if (this.isTaskRunning(task.id)) {
      throw new AppError('CONFLICT', '该任务已有正在进行的执行', 409);
    }

    if (opts.triggerType === 'manual') {
      if (task.status !== 'pending' && task.status !== 'queued' && task.status !== 'cancelled') {
        throw badRequest('VALIDATION_DENIED', `当前状态（${task.status}）不可执行`);
      }
      const project = this.projects.getRow(task.project_id);
      if (!project) throw notFound(`项目不存在: ${task.project_id}`);
      if (project.status === 'archived') throw badRequest('VALIDATION_DENIED', '项目已归档，不可执行任务');
      this.projects.assertMember(task.project_id, task.agent_id);
      if (agent.status !== 'enabled') throw badRequest('AGENT_DISABLED', '被指派智能体已停用');
      validateWorkspace(task.workspace);
      if (this.isAgentSaturated(agent)) {
        throw new AppError('AGENT_BUSY', `智能体「${agent.name}」正在执行其他任务，请稍后重试`, 409);
      }
      if (this.runningCount() >= config.globalMaxConcurrency) {
        throw new AppError('AGENT_BUSY', '已达到全局并发上限，请稍后重试', 409);
      }
      // 手动启动：pending → running（start_manual）；queued → running（用户强制派发）
      // 已取消任务：先重新入队（cancelled → queued）再派发（queued → running）
      if (task.status === 'cancelled') {
        // 「重新执行已取消的任务」同样接续上次执行（复用其执行记录与会话）
        this.tasks.setResumeExecution(task.id, this.tasks.latestResumableExecution(task.id)?.executionId ?? null);
        this.tasks.transition(task.id, 'retry', 'user', opts.actorId ?? null, '重新执行已取消的任务');
        this.tasks.resetRetryState(task.id);
        this.tasks.transition(task.id, 'dispatch', 'user', opts.actorId ?? null, '用户手动启动');
      } else if (task.status === 'pending') {
        this.tasks.transition(task.id, 'start_manual', 'user', opts.actorId ?? null, '用户手动启动');
      } else {
        this.tasks.transition(task.id, 'dispatch', 'user', opts.actorId ?? null, '用户从队列强制启动');
      }
    }

    // 执行记录：重试被中断的任务时**复用那次执行的记录**（同一 execution、同一日志文件），
    // 否则新建一条。复用与否由 tasks.resume_execution_id 决定，这里消费一次。
    const ts = now();
    const resume = this.tasks.takeResumeExecution(task.id);
    const executionId = resume?.executionId ?? idGen.execution();
    if (resume) {
      // 回到 running 并清掉上一次的结束信息；started_at / log_path / 会话 id 保持不变，
      // 这样执行历史里仍是「同一次执行」，日志也接在同一份文件后面。
      this.db.run(
        `UPDATE task_executions
         SET status = 'running', finished_at = NULL, error = NULL, result = NULL, workspace = ?
         WHERE id = ?`,
        task.workspace,
        executionId,
      );
    } else {
      this.db.run(
        `INSERT INTO task_executions (id, task_id, agent_id, trigger_type, retry_no, status,
                                      workspace, started_at, log_path)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL)`,
        executionId,
        task.id,
        task.agent_id,
        opts.triggerType,
        task.retry_no,
        task.workspace,
        ts,
      );
      const logPath = new ExecutionLogWriter(executionId).path;
      this.db.run('UPDATE task_executions SET log_path = ? WHERE id = ?', logPath, executionId);
    }
    this.db.run('UPDATE tasks SET locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?',
      opts.triggerType, ts, ts, task.id);

    bus.emit({
      type: 'execution.started',
      taskId: task.id,
      projectId: task.project_id,
      payload: {
        executionId,
        agentId: task.agent_id,
        triggerType: opts.triggerType,
        resumed: Boolean(resume),
      },
    });

    // 异步执行，不阻塞调用方
    void this.run(task, agent, executionId, opts, resume?.sessionId ?? null).catch((err) => {
      this.finalizeError(task.id, executionId, err as Error);
    });

    return this.getExecution(executionId)!;
  }

  /** 执行入口：任何异常都转为执行失败，保证不出现悬挂的 running 记录 */
  private async run(
    task: TaskRow,
    agent: AgentRow,
    executionId: string,
    opts: StartOptions,
    resumeSessionId: string | null,
  ): Promise<void> {
    try {
      await this.runInner(task, agent, executionId, opts, resumeSessionId);
    } catch (err) {
      const msg = (err as Error).message;
      const writer = new ExecutionLogWriter(executionId);
      writer.append({ type: 'system', text: `执行准备/运行异常: ${msg}` });
      this.finish(task, agent, executionId, {
        status: 'failed',
        output: '',
        error: msg,
        memoryCandidates: [],
      });
    }
  }

  private async runInner(
    task: TaskRow,
    agent: AgentRow,
    executionId: string,
    opts: StartOptions,
    resumeSessionId: string | null,
  ): Promise<void> {
    const controller = new AbortController();
    const info: RunningInfo = {
      executionId,
      taskId: task.id,
      agentId: agent.id,
      controller,
      handle: null,
      timer: null,
      cancelRequested: false,
    };
    this.running.set(executionId, info);

    const writer = new ExecutionLogWriter(executionId);
    const timeoutSec =
      task.timeout_sec ?? agent.timeout_sec ?? config.executionTimeoutSec ?? 0;
    if (timeoutSec > 0) {
      info.timer = setTimeout(() => {
        writer.append({ type: 'system', text: `执行超时（${timeoutSec}s），已中止` });
        controller.abort();
      }, timeoutSec * 1000);
    }

    const agentDto = this.agents.getOrThrow(agent.id);
    const agentConfig: AgentConfigForRun = {
      id: agent.id,
      name: agent.name,
      systemPrompt: agent.system_prompt,
      model: agentDto.model,
      tools: agentDto.tools,
      timeoutSec,
    };

    const project = this.projects.getRow(task.project_id);
    const memories: MemoryItem[] = this.agents
      .listMemories(agent.id)
      .slice(0, 50)
      .map((m) => ({
        id: m.id,
        content: m.content,
        createdAt: m.created_at,
        sourceTaskId: m.source_task_id,
      }));

    const completedTasks = this.completedTasksOfProject(task.project_id);
    const members = this.assignableMembers(task.project_id, agent.id);

    // 底座由智能体自身决定（agents.harness），同一次服务内不同智能体可各走各的运行时
    const harness = normalizeHarness(agent.harness);
    const runtime = this.runtimes.get(harness);

    // 接续运行：复用同一条执行记录，日志也接在同一份文件后面，这里打一条分隔说明
    if (resumeSessionId) {
      writer.append({
        type: 'system',
        text: `接续执行：复用执行记录 ${executionId}，在其会话 ${resumeSessionId} 上继续`,
      });
    }

    writer.append({
      type: 'system',
      text: '开始执行',
      task: { id: task.id, name: task.name },
      agent: { id: agent.id, name: agent.name },
      harness,
      // 有值表示本次在既有会话上接续运行，而非新建会话
      resumeSessionId: resumeSessionId ?? null,
      workspace: task.workspace,
      triggerType: opts.triggerType,
      memoryCount: memories.length,
      completedTaskCount: completedTasks.length,
    });

    let handle: SessionHandle;
    try {
      handle = await runtime.startSession({
        agent: agentConfig,
        workspace: task.workspace,
        input: {
          taskName: task.name,
          taskDescription: task.description,
          projectName: project?.name ?? '',
          projectDescription: project?.description ?? null,
          members,
          memories,
          completedTasks,
          workspace: task.workspace,
        },
        executionId,
        taskId: task.id,
        toolToken: executionId,
        resumeSessionId,
        signal: controller.signal,
      });
      info.handle = handle;
    } catch (err) {
      this.finish(task, agent, executionId, {
        status: 'failed',
        output: '',
        error: (err as Error).message,
        memoryCandidates: [],
      });
      return;
    }

    // 流式消费事件
    let sessionPersisted = false;
    try {
      for await (const ev of handle.events) {
        writer.append(ev as unknown as Record<string, unknown>);
        bus.emit({
          type: 'task.log',
          taskId: task.id,
          projectId: task.project_id,
          payload: { executionId, event: ev },
        });
        // 会话 id 一旦确定就落库（只写一次）：这样即使进程被杀/服务重启，
        // 中断后的重试仍能在这个会话上接续。
        if (!sessionPersisted && handle.sessionId) {
          sessionPersisted = true;
          this.db.run('UPDATE task_executions SET session_id = ? WHERE id = ?', handle.sessionId, executionId);
        }
      }
    } catch (err) {
      writer.append({ type: 'system', text: `事件流异常: ${(err as Error).message}` });
    }

    const result = await handle.wait();
    this.finish(task, agent, executionId, result);
  }

  /** 项目成员中可被指派的智能体（供智能体了解可指派对象与可用 agentId） */
  private assignableMembers(projectId: string, selfAgentId: string): ProjectMemberInfo[] {
    const rows = this.db.all<{ agent_id: string; name: string; role: string | null }>(
      `SELECT pm.agent_id, a.name, a.role
       FROM project_members pm
       JOIN agents a ON a.id = pm.agent_id
       WHERE pm.project_id = ? AND a.status = 'enabled' AND a.deleted_at IS NULL
       ORDER BY pm.joined_at ASC`,
      projectId,
    );
    return rows.map((r) => ({
      agentId: r.agent_id,
      name: r.name,
      role: r.role,
      isSelf: r.agent_id === selfAgentId,
    }));
  }

  private completedTasksOfProject(projectId: string): CompletedTaskSummary[] {
    const rows = this.db.all<{
      id: string;
      name: string;
      description: string;
      result: string | null;
      completed_at: number | null;
      updated_at: number;
    }>(
      // 先取最近完成的 50 条（内层倒序 + LIMIT），再按完成时间正序返回，
      // 使注入到运行时上下文的历史任务按"完成先后"由前到后排列
      `SELECT * FROM (
         SELECT t.id AS id, t.name AS name, t.description AS description, t.result AS result,
                (SELECT MAX(l.created_at) FROM task_status_logs l
                  WHERE l.task_id = t.id AND l.to_status = 'done') AS completed_at,
                t.updated_at AS updated_at
         FROM tasks t
         WHERE t.project_id = ? AND t.status = 'done'
         ORDER BY COALESCE(completed_at, t.updated_at) DESC
         LIMIT 50
       )
       ORDER BY COALESCE(completed_at, updated_at) ASC`,
      projectId,
    );
    return rows.map((r) => ({
      taskId: r.id,
      name: r.name,
      description: r.description,
      result: r.result,
      completedAt: r.completed_at ?? r.updated_at,
    }));
  }

  // ---------- 结束处理 ----------

  private finish(
    task: TaskRow,
    agent: AgentRow,
    executionId: string,
    result: ExecutionResult,
  ): void {
    const info = this.running.get(executionId);
    if (info?.timer) clearTimeout(info.timer);
    this.running.delete(executionId);

    // 幂等保护：执行记录已被处理过则直接返回，避免重复迁移任务状态
    const current = this.db.get<{ status: string }>(
      'SELECT status FROM task_executions WHERE id = ?',
      executionId,
    );
    if (!current || current.status !== 'running') return;

    const ts = now();
    const submitted = this.db.get<{ result: string | null }>('SELECT result FROM tasks WHERE id = ?', task.id);
    const finalResult =
      result.status === 'succeeded'
        ? (submitted?.result ?? null) ?? result.output.slice(0, 20000)
        : null;

    this.db.run(
      `UPDATE task_executions SET status = ?, finished_at = ?, error = ?, result = ?, session_id = ?
       WHERE id = ?`,
      result.status,
      ts,
      result.error ?? null,
      finalResult,
      result.sessionId ?? null,
      executionId,
    );

    const fresh = this.tasks.getRow(task.id);
    const writer = new ExecutionLogWriter(executionId);
    writer.append({
      type: 'system',
      text: `执行结束：${result.status}`,
      error: result.error ?? null,
    });

    if (!fresh) return;

    if (result.status === 'cancelled' || info?.cancelRequested) {
      if (fresh.status === 'running') {
        this.tasks.transition(task.id, 'cancel', 'user', null, '用户中止执行');
      }
      bus.emit({
        type: 'execution.finished',
        taskId: task.id,
        projectId: task.project_id,
        payload: { executionId, status: 'cancelled' },
      });
      return;
    }

    if (result.status === 'succeeded') {
      this.db.run(
        'UPDATE tasks SET result = ?, locked_by = NULL, locked_at = NULL, retry_no = 0, updated_at = ? WHERE id = ?',
        finalResult,
        ts,
        task.id,
      );
      if (fresh.status === 'running') {
        this.tasks.transition(task.id, 'finish', 'system', null, '执行成功');
      }
      const sunk = this.agents.sinkMemories(agent.id, task.id, result.memoryCandidates);
      if (sunk > 0) writer.append({ type: 'system', text: `自动沉淀经验记忆 ${sunk} 条` });
      bus.emit({
        type: 'execution.finished',
        taskId: task.id,
        projectId: task.project_id,
        payload: { executionId, status: 'succeeded', memorySunk: sunk },
      });
      return;
    }

    // 失败：按重试策略处理
    // 任务未配置重试策略（retry_max=0）时，可重试的瞬时错误（网络不可达、上游 5xx/限流等）
    // 仍按系统兜底策略重试，避免因网络抖动直接判定任务失败。
    const fallback = result.retryable === true;
    const maxRetries = fresh.retry_max > 0 ? fresh.retry_max : fallback ? config.transientRetryMax : 0;
    const intervalSec =
      fresh.retry_interval > 0
        ? fresh.retry_interval
        : fallback
          ? config.transientRetryIntervalSec
          : 0;
    const canRetry = fresh.retry_no < maxRetries;
    if (canRetry) {
      const delayMs =
        fresh.retry_backoff === 'exponential'
          ? intervalSec * 1000 * Math.pow(2, fresh.retry_no)
          : intervalSec * 1000;
      // 自动重试同样接续本次执行：复用这条执行记录并在其会话上继续
      this.tasks.setResumeExecution(task.id, result.sessionId ? executionId : null);
      if (fresh.status === 'running') {
        const note = result.retryable ? '（可重试错误）' : '';
        this.tasks.transition(task.id, 'fail_retryable', 'system', null,
          `执行失败${note}，自动重试（第 ${fresh.retry_no + 1}/${maxRetries} 次）`);
      }
      this.db.run(
        `UPDATE tasks SET retry_no = retry_no + 1, not_before = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
         WHERE id = ?`,
        now() + delayMs,
        now(),
        task.id,
      );
      bus.emit({
        type: 'execution.failed',
        taskId: task.id,
        projectId: task.project_id,
        payload: { executionId, retryNo: fresh.retry_no + 1, retryMax: maxRetries, retryable: fallback },
      });
    } else {
      if (fresh.status === 'running') {
        this.tasks.transition(task.id, 'fail_final', 'system', null, '执行失败且重试次数已耗尽');
      }
      this.db.run('UPDATE tasks SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?', now(), task.id);
      bus.emit({
        type: 'execution.failed',
        taskId: task.id,
        projectId: task.project_id,
        payload: { executionId, final: true },
      });
    }
  }

  private finalizeError(taskId: string, executionId: string, err: Error): void {
    const ts = now();
    try {
      this.db.run(
        "UPDATE task_executions SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
        ts,
        err.message,
        executionId,
      );
      const task = this.tasks.getRow(taskId);
      if (task && task.status === 'running') {
        this.tasks.transition(taskId, 'fail_final', 'system', null, `执行引擎异常: ${err.message}`);
      }
      this.db.run('UPDATE tasks SET locked_by = NULL, locked_at = NULL WHERE id = ?', taskId);
    } catch {
      /* ignore */
    } finally {
      const info = this.running.get(executionId);
      if (info?.timer) clearTimeout(info.timer);
      this.running.delete(executionId);
    }
  }

  // ---------- 中止 ----------

  async cancel(taskId: string, actorId?: string | null): Promise<void> {
    const task = this.tasks.getRow(taskId);
    if (!task) throw notFound(`任务不存在: ${taskId}`);
    if (task.status !== 'running' && task.status !== 'queued' && task.status !== 'pending') {
      throw badRequest('VALIDATION_DENIED', `当前状态（${task.status}）不可取消`);
    }
    // 清空待接续意图：取消后该次尝试已作废，避免被后续（如周期任务下一轮）误用
    this.tasks.setResumeExecution(taskId, null);
    if (task.status === 'running') {
      const info = [...this.running.values()].find((i) => i.taskId === taskId);
      if (info) {
        info.cancelRequested = true;
        await info.handle?.abort();
        info.controller.abort();
      } else {
        // 进程外残留：直接修正状态
        this.db.run(
          "UPDATE task_executions SET status = 'interrupted', finished_at = ?, error = '进程重启导致中断' WHERE task_id = ? AND status = 'running'",
          now(),
          taskId,
        );
        this.tasks.transition(taskId, 'cancel', 'user', actorId ?? null, '用户取消（无活动执行）');
      }
      return;
    }
    this.tasks.transition(taskId, 'cancel', 'user', actorId ?? null, '用户取消排队/待处理任务');
  }

  // ---------- 重启恢复 ----------

  /** 启动时调用：把残留的 running 执行标记为中断，并按重试策略重入队或置失败。 */
  recoverInterrupted(): number {
    const rows = this.db.all<ExecutionRow>(
      "SELECT * FROM task_executions WHERE status = 'running'",
    );
    for (const ex of rows) {
      this.db.run(
        "UPDATE task_executions SET status = 'interrupted', finished_at = ?, error = '服务重启导致执行中断' WHERE id = ?",
        now(),
        ex.id,
      );
      const task = this.tasks.getRow(ex.task_id);
      if (!task) continue;
      this.db.run('UPDATE tasks SET locked_by = NULL, locked_at = NULL WHERE id = ?', task.id);
      if (task.status !== 'running') continue;

      if (task.retry_no < task.retry_max) {
        // 重启中断后的自动重试，同样复用该执行记录并在其会话上接续
        // （会话 id 在事件流开始时即已落库，因此这里能用）
        this.tasks.setResumeExecution(task.id, ex.session_id ? ex.id : null);
        this.tasks.transition(task.id, 'fail_retryable', 'system', null, '服务重启中断，自动重试');
        this.db.run(
          'UPDATE tasks SET retry_no = retry_no + 1, not_before = ?, updated_at = ? WHERE id = ?',
          now() + task.retry_interval * 1000,
          now(),
          task.id,
        );
      } else {
        this.tasks.transition(task.id, 'fail_final', 'system', null, '服务重启中断且无重试余量');
      }
    }
    return rows.length;
  }

  // ---------- 查询 ----------

  getExecution(id: string): ExecutionRow | undefined {
    return this.db.get<ExecutionRow>('SELECT * FROM task_executions WHERE id = ?', id);
  }

  listExecutions(taskId: string): ExecutionRow[] {
    return this.db.all<ExecutionRow>(
      'SELECT * FROM task_executions WHERE task_id = ? ORDER BY started_at DESC',
      taskId,
    );
  }

  recentExecutions(limit = 50): ExecutionRow[] {
    return this.db.all<ExecutionRow>(
      'SELECT * FROM task_executions ORDER BY started_at DESC LIMIT ?',
      limit,
    );
  }
}
