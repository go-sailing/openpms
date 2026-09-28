/**
 * task/state.ts — 任务状态机（SDD 第 6 章）
 *
 * pending   ──start_manual──▶ running
 * pending   ──enqueue───────▶ queued        （自动/定时/依赖触发）
 * pending   ──cancel────────▶ cancelled
 * queued    ──dispatch──────▶ running
 * queued    ──cancel────────▶ cancelled
 * queued    ──requeue───────▶ queued
 * running   ──finish────────▶ done          （执行成功直接完成，无验收环节）
 * running   ──fail_retryable▶ queued        （失败且重试次数未耗尽）
 * running   ──fail_final────▶ failed        （失败且重试耗尽）
 * running   ──cancel────────▶ cancelled
 * failed    ──retry─────────▶ queued
 * cancelled ──retry─────────▶ queued        （重新执行已取消的任务）
 * cancelled ──reopen────────▶ pending
 */
import type { TaskStatus } from '../platform/types.js';

export type TaskEvent =
  | 'start_manual'
  | 'enqueue'
  | 'requeue'
  | 'dispatch'
  | 'finish'
  | 'fail_retryable'
  | 'fail_final'
  | 'cancel'
  | 'retry'
  | 'reopen';

export const ALLOWED: Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>> = {
  pending: { start_manual: 'running', enqueue: 'queued', cancel: 'cancelled' },
  queued: { dispatch: 'running', cancel: 'cancelled', requeue: 'queued' },
  running: {
    finish: 'done',
    fail_retryable: 'queued',
    fail_final: 'failed',
    cancel: 'cancelled',
  },
  done: {},
  failed: { retry: 'queued' },
  cancelled: { reopen: 'pending', retry: 'queued' },
};

export function nextStatus(from: TaskStatus, event: TaskEvent): TaskStatus | undefined {
  return ALLOWED[from]?.[event];
}

export function canTransition(from: TaskStatus, event: TaskEvent): boolean {
  return nextStatus(from, event) !== undefined;
}

export const ALL_STATUSES: TaskStatus[] = ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'];
