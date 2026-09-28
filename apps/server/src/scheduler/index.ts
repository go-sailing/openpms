/**
 * scheduler/index.ts — 调度器（SDD 第 5 章）
 *
 * 原则：队列就是数据库（tasks.status='queued'），状态即真相；
 *       派发用 SQLite 事务 + 条件更新（CAS）保证同一任务同一时刻至多一个执行。
 */
import type { Db } from '../platform/db.js';
import { config } from '../platform/config.js';
import { now } from '../platform/time.js';
import { nextCronTime } from '../platform/cron.js';
import { bus } from '../platform/events.js';
import { validateWorkspace } from '../sandbox/index.js';
import { SettingsRepo, SETTING_KEYS } from '../platform/settings.js';
import type { TaskPriority, TaskRow } from '../platform/types.js';
import type { TaskService } from '../task/service.js';
import type { ProjectService } from '../project/service.js';
import type { AgentService } from '../agent/service.js';
import type { ExecutionEngine } from '../execution/engine.js';
import { handleSettled, sweepDependencyTasks } from './dependency.js';

const PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";
const MAX_DISPATCH_PER_TICK = 20;

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  tickMs: number;
  queued: number;
  runningExecutions: number;
  globalMaxConcurrency: number;
  lastTickAt: number | null;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly projects: ProjectService,
    private readonly agents: AgentService,
    private readonly settings: SettingsRepo,
    private readonly engine: ExecutionEngine,
  ) {
    // 注册任务终态回调：依赖传播 + 周期任务收尾
    this.tasks.onSettled = (taskId: string) => handleSettled(this.db, this.tasks, taskId);
  }

  // ---------- 生命周期 ----------

  start(): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.schedulerTickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 启动恢复：中断执行修正、依赖任务补偿、到期任务立即扫描 */
  recover(): void {
    const interrupted = this.engine.recoverInterrupted();
    const swept = sweepDependencyTasks(this.db, this.tasks);
    this.settings.set(SETTING_KEYS.lastRecoveryAt, String(now()));
    if (interrupted > 0 || swept > 0) {
      // 交给下一轮 tick 立即派发
      setTimeout(() => void this.tick(), 0).unref?.();
    }
  }

  // ---------- 开关 ----------

  isEnabled(): boolean {
    return this.settings.getBool(SETTING_KEYS.autoScheduleEnabled, config.autoScheduleDefault);
  }

  setEnabled(enabled: boolean): void {
    this.settings.setBool(SETTING_KEYS.autoScheduleEnabled, enabled);
    bus.emit({ type: 'scheduler.diagnostic', payload: { action: enabled ? 'enabled' : 'disabled' } });
  }

  status(): SchedulerStatus {
    return {
      enabled: this.isEnabled(),
      running: this.ticking,
      tickMs: config.schedulerTickMs,
      queued: this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE status = 'queued'")?.c ?? 0,
      runningExecutions: this.engine.runningCount(),
      globalMaxConcurrency: config.globalMaxConcurrency,
      lastTickAt: this.lastTickAt,
    };
  }

  // ---------- 主循环 ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = now();
    try {
      this.promoteDueScheduled();
      this.markArrivedPeriods();
      if (this.isEnabled()) {
        await this.dispatch();
      }
    } catch (err) {
      bus.emit({
        type: 'scheduler.diagnostic',
        payload: { action: 'tick-error', error: (err as Error).message },
      });
    } finally {
      this.ticking = false;
    }
  }

  /** 定时任务到达计划时间 → 入队 */
  private promoteDueScheduled(): void {
    const ts = now();
    const rows = this.db.all<TaskRow>(
      `SELECT * FROM tasks
       WHERE status = 'pending' AND trigger_mode = 'scheduled' AND schedule_enabled = 1
         AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      ts,
    );
    for (const r of rows) {
      if (this.tasks.enqueue(r.id, 'scheduled')) {
        bus.emit({
          type: 'scheduler.diagnostic',
          taskId: r.id,
          projectId: r.project_id,
          payload: { action: 'enqueue', reason: 'scheduled' },
        });
      }
    }
  }

  /** 执行期间周期到达 → 标记待补执行（布尔，不堆积） */
  private markArrivedPeriods(): void {
    const ts = now();
    const rows = this.db.all<{ id: string; project_id: string }>(
      `SELECT id, project_id FROM tasks
       WHERE status = 'running' AND trigger_mode = 'scheduled' AND cron_expr IS NOT NULL
         AND schedule_enabled = 1 AND pending_fire = 0
         AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      ts,
    );
    for (const r of rows) {
      this.db.run('UPDATE tasks SET pending_fire = 1, updated_at = ? WHERE id = ?', ts, r.id);
      bus.emit({
        type: 'scheduler.diagnostic',
        taskId: r.id,
        projectId: r.project_id,
        payload: { action: 'period-arrived', note: '执行中，已标记待补执行一次' },
      });
    }
  }

  /** 派发：取可运行任务，前置校验 → 并发槽位 → CAS 占用 → 执行 */
  private async dispatch(): Promise<void> {
    const ts = now();
    const candidates = this.db.all<TaskRow>(
      `SELECT * FROM tasks
       WHERE status = 'queued' AND schedule_enabled = 1
         AND (next_run_at IS NULL OR next_run_at <= ? OR pending_fire = 1)
         AND (not_before IS NULL OR not_before <= ?)
       ORDER BY ${PRIORITY_ORDER}, queued_at ASC
       LIMIT 100`,
      ts,
      ts,
    );

    let dispatched = 0;
    for (const task of candidates) {
      if (dispatched >= MAX_DISPATCH_PER_TICK) break;
      if (this.engine.runningCount() >= config.globalMaxConcurrency) break;

      const reason = this.precheck(task);
      if (reason) {
        this.reportSkip(task, reason);
        continue;
      }

      const agent = this.agents.getRow(task.agent_id);
      if (!agent) {
        this.reportSkip(task, '智能体不存在');
        continue;
      }
      if (this.engine.isAgentSaturated(agent)) {
        // 槽位不足属于正常排队，不记为错误
        continue;
      }

      if (!this.occupy(task.id)) {
        // 被其他流程抢占（如用户手动启动），跳过
        continue;
      }

      this.advanceClock(task, ts);

      try {
        await this.engine.start({ taskId: task.id, triggerType: 'scheduler' });
        dispatched += 1;
        bus.emit({
          type: 'scheduler.diagnostic',
          taskId: task.id,
          projectId: task.project_id,
          payload: { action: 'dispatched', agentId: task.agent_id },
        });
      } catch (err) {
        // 启动失败：回退为排队中并记录原因
        this.db.run(
          `UPDATE tasks SET status = 'queued', locked_by = NULL, locked_at = NULL,
                            last_dispatch_error = ?, last_dispatch_error_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
          `派发失败: ${(err as Error).message}`,
          now(),
          now(),
          task.id,
        );
        this.tasks.logStatus(task.id, 'running', 'queued', 'scheduler', null, `派发失败回退: ${(err as Error).message}`);
      }
    }
  }

  /** 派发前置校验（F-T-05 可靠性要求） */
  private precheck(task: TaskRow): string | null {
    const project = this.projects.getRow(task.project_id);
    if (!project) return '项目不存在';
    if (project.status === 'archived') return '项目已归档';
    if (project.auto_schedule_enabled !== 1) return '项目级调度开关已关闭';

    const member = this.db.get<{ id: string }>(
      'SELECT id FROM project_members WHERE project_id = ? AND agent_id = ?',
      task.project_id,
      task.agent_id,
    );
    if (!member) return '被指派智能体已不是该项目成员';

    const agent = this.agents.getRow(task.agent_id);
    if (!agent) return '智能体不存在';
    if (agent.status !== 'enabled') return '被指派智能体已停用';

    try {
      validateWorkspace(task.workspace);
    } catch (err) {
      return `工作目录无效: ${(err as Error).message}`;
    }

    if (this.engine.isTaskRunning(task.id)) return '该任务已有正在进行的执行';
    return null;
  }

  private reportSkip(task: TaskRow, reason: string): void {
    // 最小重试间隔，避免忙等刷屏
    const last = task.last_dispatch_error_at ?? 0;
    if (task.last_dispatch_error === reason && now() - last < config.dispatchErrorBackoffMs) return;
    this.tasks.markDispatchError(task.id, reason);
    bus.emit({
      type: 'scheduler.diagnostic',
      taskId: task.id,
      projectId: task.project_id,
      payload: { action: 'skip', reason },
    });
  }

  /** CAS 占用：仅排队中且无活动执行时可占用 */
  private occupy(taskId: string): boolean {
    const ts = now();
    const r = this.db.run(
      `UPDATE tasks
       SET status = 'running', locked_by = 'scheduler', locked_at = ?, updated_at = ?,
           not_before = NULL, last_dispatch_error = NULL, last_dispatch_error_at = NULL
       WHERE id = ? AND status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM task_executions
                         WHERE task_id = ? AND status = 'running')`,
      ts,
      ts,
      taskId,
      taskId,
    );
    if (r.changes === 1) {
      this.tasks.logStatus(taskId, 'queued', 'running', 'scheduler', null, '调度器派发');
      return true;
    }
    return false;
  }

  /** 占用成功后处理周期时钟：补执行标记清除；next_run_at 推进到下一次 */
  private advanceClock(task: TaskRow, ts: number): void {
    const isPeriodic = task.trigger_mode === 'scheduled' && Boolean(task.cron_expr);
    if (!isPeriodic) {
      if (task.trigger_mode === 'scheduled') {
        this.db.run('UPDATE tasks SET next_run_at = NULL, pending_fire = 0, updated_at = ? WHERE id = ?', ts, task.id);
      }
      return;
    }
    const next = nextCronTime(task.cron_expr as string);
    this.db.run(
      'UPDATE tasks SET next_run_at = ?, pending_fire = 0, updated_at = ? WHERE id = ?',
      next,
      ts,
      task.id,
    );
  }
}

export type { TaskPriority };
