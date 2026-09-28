/**
 * QueuePage.tsx — 调度队列（派发顺序、优先级、入队原因、pendingFire）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Empty } from '../components/Empty';
import { PriorityBadge, StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { useWsEvent } from '../hooks/useWebSocket';
import type { Task } from '../types';
import { formatTime, triggerLabel } from '../utils';

export function QueuePage() {
  const toast = useToast();
  const [queue, setQueue] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const lastRefresh = useRef(0);

  const load = useCallback(async () => {
    try {
      setQueue(await api.queue());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useWsEvent((event) => {
    if (
      event.type !== 'queue.updated' &&
      event.type !== 'task.updated' &&
      event.type !== 'scheduler.diagnostic' &&
      !event.type.startsWith('execution.')
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastRefresh.current < 800) return;
    lastRefresh.current = now;
    void load();
  });

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-info">排队中 {queue.length} 个任务</div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">加载中…</div>
      ) : queue.length === 0 ? (
        <Empty text="当前调度队列为空" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>顺序</th>
              <th>任务</th>
              <th>项目</th>
              <th>优先级</th>
              <th>指派智能体</th>
              <th>触发方式</th>
              <th>入队原因</th>
              <th>下次运行</th>
              <th>pendingFire</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((task, index) => (
              <tr key={task.id}>
                <td className="mono">{index + 1}</td>
                <td>{task.name}</td>
                <td className="muted">{task.projectName ?? task.projectId}</td>
                <td>
                  <PriorityBadge priority={task.priority} />
                </td>
                <td>{task.agentName ?? task.agentId}</td>
                <td className="muted">{triggerLabel(task.triggerMode)}</td>
                <td className="muted">{task.enqueueReason || '—'}</td>
                <td className="muted small">{formatTime(task.nextRunAt ?? task.notBefore)}</td>
                <td>{task.pendingFire ? <span className="tag tag-warn">待触发</span> : '—'}</td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
