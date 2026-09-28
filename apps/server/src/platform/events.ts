/**
 * platform/events.ts
 * 进程内事件总线：领域层发事件，WS 层订阅并推送。
 */
export type DomainEventType =
  | 'task.updated'
  | 'task.log'
  | 'execution.started'
  | 'execution.finished'
  | 'execution.failed'
  | 'queue.updated'
  | 'scheduler.diagnostic'
  | 'agent.updated'
  | 'project.updated';

export interface DomainEvent<T = unknown> {
  type: DomainEventType;
  /** 关联任务 id（用于按任务订阅） */
  taskId?: string;
  /** 关联项目 id（用于按项目订阅） */
  projectId?: string;
  payload: T;
  at: number;
}

type Handler = (e: DomainEvent) => void;

class EventBus {
  private handlers = new Set<Handler>();

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  emit(e: Omit<DomainEvent, 'at'>): void {
    const full: DomainEvent = { ...e, at: Date.now() };
    for (const h of this.handlers) {
      try {
        h(full);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }
}

export const bus = new EventBus();
