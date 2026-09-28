/**
 * StatusBadge.tsx — 状态 / 优先级标签
 */
import { priorityLabel, statusLabel } from '../utils';

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const key = status ?? 'unknown';
  return <span className={`badge badge-${key}`}>{statusLabel(status)}</span>;
}

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  return <span className={`badge badge-pri-${priority ?? 'unknown'}`}>{priorityLabel(priority)}</span>;
}
