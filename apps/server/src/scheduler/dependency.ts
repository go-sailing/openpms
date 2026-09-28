/**
 * scheduler/dependency.ts — 依赖传播与周期任务收尾（SDD 5.5、5.6）
 */
import type { Db } from '../platform/db.js';
import { now } from '../platform/time.js';
import { nextCronTime } from '../platform/cron.js';
import { bus } from '../platform/events.js';
import type { TaskRow, TaskStatus } from '../platform/types.js';
import type { TaskService } from '../task/service.js';

/** 后续任务（依赖当前任务） */
function successorsOf(db: Db, taskId: string): string[] {
  return db
    .all<{ task_id: string }>('SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?', taskId)
    .map((r) => r.task_id);
}

function dependenciesOf(db: Db, taskId: string): string[] {
  return db
    .all<{ depends_on_task_id: string }>(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?',
      taskId,
    )
    .map((r) => r.depends_on_task_id);
}

/**
 * 评估一个依赖任务是否可入队：
 * - 全部前置 done → 入队
 * - 任一前置 failed/cancelled → 阻塞并记录原因
 */
export function evaluateDependencyTask(db: Db, tasks: TaskService, taskId: string): 'enqueued' | 'blocked' | 'waiting' {
  const task = tasks.getRow(taskId);
  if (!task) return 'waiting';
  if (task.status !== 'pending') return 'waiting';
  if (task.schedule_enabled !== 1) return 'waiting';

  const deps = dependenciesOf(db, taskId);
  if (deps.length === 0) return 'waiting';

  const statuses = deps.map((d) => db.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', d)?.status);
  const blockedBy = statuses.filter((s) => s === 'failed' || s === 'cancelled');
  if (blockedBy.length > 0) {
    tasks.markDispatchError(taskId, '前置依赖任务失败或已取消，未触发');
    return 'blocked';
  }
  if (statuses.every((s) => s === 'done')) {
    const ok = tasks.enqueue(taskId, 'dependency');
    return ok ? 'enqueued' : 'waiting';
  }
  return 'waiting';
}

/**
 * 周期任务收尾：执行结束后决定是否立即补执行 / 等待下一周期。
 * 由任务的 onSettled 回调触发（done / failed / cancelled）。
 */
export function settlePeriodicTask(db: Db, tasks: TaskService, task: TaskRow): void {
  const isPeriodic = task.trigger_mode === 'scheduled' && Boolean(task.cron_expr);
  if (!isPeriodic) return;
  if (task.status === 'cancelled') {
    db.run('UPDATE tasks SET pending_fire = 0, updated_at = ? WHERE id = ?', now(), task.id);
    return;
  }
  if (task.schedule_enabled !== 1) {
    db.run('UPDATE tasks SET pending_fire = 0, updated_at = ? WHERE id = ?', now(), task.id);
    return;
  }

  const ts = now();
  if (task.pending_fire === 1) {
    // 执行期间有周期到达 → 上一次结束后立即补执行一次
    db.run(
      `UPDATE tasks SET status = 'queued', queued_at = ?, enqueue_reason = 'scheduled_missed',
                         updated_at = ?
       WHERE id = ?`,
      ts,
      ts,
      task.id,
    );
    tasks.logStatus(task.id, task.status, 'queued', 'scheduler', null, '周期到达且上次执行未结束，立即补执行一次');
    bus.emit({
      type: 'scheduler.diagnostic',
      taskId: task.id,
      projectId: task.project_id,
      payload: { action: 'makeup-enqueue', reason: 'scheduled_missed' },
    });
    return;
  }

  // 无补执行需求：按已持久化的 next_run_at 等待下一周期
  const next = task.cron_expr ? nextCronTime(task.cron_expr) : null;
  db.run(
    `UPDATE tasks SET status = 'queued', queued_at = ?, enqueue_reason = 'scheduled',
                       next_run_at = ?, updated_at = ?
     WHERE id = ?`,
    ts,
    next,
    ts,
    task.id,
  );
  tasks.logStatus(task.id, task.status, 'queued', 'scheduler', null, '周期任务等待下一周期');
}

/** 任务进入终态后的统一处理入口 */
export function handleSettled(db: Db, tasks: TaskService, taskId: string): void {
  const task = tasks.getRow(taskId);
  if (!task) return;

  // 1) 依赖传播
  for (const succ of successorsOf(db, taskId)) {
    evaluateDependencyTask(db, tasks, succ);
  }
  // 2) 周期任务收尾
  settlePeriodicTask(db, tasks, task);
}

/** 启动恢复时使用：把所有满足条件的依赖任务补入队 */
export function sweepDependencyTasks(db: Db, tasks: TaskService): number {
  const rows = db.all<{ id: string }>(
    "SELECT id FROM tasks WHERE status = 'pending' AND trigger_mode = 'dependency'",
  );
  let n = 0;
  for (const r of rows) {
    if (evaluateDependencyTask(db, tasks, r.id) === 'enqueued') n += 1;
  }
  return n;
}
