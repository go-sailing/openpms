/**
 * TaskDetailView.tsx — 任务详情弹窗：基础信息、产出、依赖、调度、状态流转与执行记录
 * 点击某条执行记录会跳转到「执行日志」页并选中该记录（见 ExecutionsPage）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Modal } from './Modal';
import { PriorityBadge, StatusBadge } from './StatusBadge';
import { useToast } from './Toast';
import { useWsEvent } from '../hooks/useWebSocket';
import type { Execution, StatusLog, Task } from '../types';
import { formatTime, triggerLabel } from '../utils';

interface TaskDetailViewProps {
  task: Task;
  onClose: () => void;
  onChanged: () => void;
  /** 点击执行记录 → 跳转到执行日志页并选中该记录 */
  onOpenExecution: (executionId: string) => void;
}

export function TaskDetailView({ task, onClose, onChanged, onOpenExecution }: TaskDetailViewProps) {
  const toast = useToast();
  const [current, setCurrent] = useState<Task>(task);
  const [siblings, setSiblings] = useState<Task[]>([]);
  const [statusLogs, setStatusLogs] = useState<StatusLog[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [busy, setBusy] = useState(false);

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const loadDetail = useCallback(
    async (taskId: string) => {
      try {
        const fresh = await api.getTask(taskId);
        const [execs, logs, projectTasks] = await Promise.all([
          api.taskExecutions(taskId),
          api.statusLogs(taskId),
          api.listTasks({ projectId: fresh.projectId }),
        ]);
        setCurrent(fresh);
        setExecutions(execs);
        setStatusLogs(logs);
        setSiblings(projectTasks);
        onChangedRef.current();
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadDetail(task.id);
  }, [loadDetail, task.id]);

  useWsEvent((event) => {
    if (
      event.type === 'task.updated' ||
      event.type === 'queue.updated' ||
      event.type === 'scheduler.diagnostic' ||
      event.type.startsWith('execution.')
    ) {
      if (event.type === 'task.updated' && event.taskId === current.id) {
        void loadDetail(current.id);
      }
    }
  });

  const runAction = async (action: 'start' | 'cancel' | 'retry' | 'pause' | 'resume', target: Task) => {
    setBusy(true);
    try {
      if (action === 'start') await api.startTask(target.id);
      else if (action === 'cancel') await api.cancelTask(target.id);
      else if (action === 'retry') await api.retryTask(target.id);
      else if (action === 'pause') await api.pauseSchedule(target.id);
      else await api.resumeSchedule(target.id);
      const labels: Record<string, string> = {
        start: '已开始执行',
        cancel: '已取消',
        retry: '已重新入队',
        pause: '调度已暂停',
        resume: '调度已恢复',
      };
      toast.success(labels[action]);
      await loadDetail(target.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const nameOfTask = (id: string) => siblings.find((item) => item.id === id)?.name ?? id;

  return (
    <Modal
      title={`任务详情 · ${current.name}`}
      size="xl"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="detail-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || current.status === 'running'}
          onClick={() => void runAction('start', current)}
        >
          开始执行
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || ['done', 'cancelled', 'failed'].includes(current.status)}
          onClick={() => void runAction('cancel', current)}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !['failed', 'cancelled'].includes(current.status)}
          onClick={() => void runAction('retry', current)}
        >
          重试
        </button>
        {current.scheduleEnabled ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runAction('pause', current)}>
            暂停调度
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runAction('resume', current)}>
            恢复调度
          </button>
        )}
      </div>

      {current.lastDispatchError ? (
        <div className="alert alert-error">最近派发失败：{current.lastDispatchError}</div>
      ) : null}

      <div className="kv-grid">
        <div className="kv">
          <span className="kv-k">状态</span>
          <span className="kv-v">
            <StatusBadge status={current.status} />
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">优先级</span>
          <span className="kv-v">
            <PriorityBadge priority={current.priority} />
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">项目</span>
          <span className="kv-v">{current.projectName ?? current.projectId}</span>
        </div>
        <div className="kv">
          <span className="kv-k">指派智能体</span>
          <span className="kv-v">{current.agentName ?? current.agentId}</span>
        </div>
        <div className="kv">
          <span className="kv-k">触发方式</span>
          <span className="kv-v">{triggerLabel(current.triggerMode)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">调度开关</span>
          <span className="kv-v">{current.scheduleEnabled ? '启用' : '暂停'}</span>
        </div>
        <div className="kv">
          <span className="kv-k">工作目录</span>
          <span className="kv-v mono">{current.workspace || '—'}</span>
        </div>
        <div className="kv">
          <span className="kv-k">下次运行</span>
          <span className="kv-v">{formatTime(current.nextRunAt)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">最早可执行</span>
          <span className="kv-v">{formatTime(current.notBefore)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">计划时间</span>
          <span className="kv-v">{formatTime(current.scheduledAt)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">Cron 表达式</span>
          <span className="kv-v mono">{current.cronExpr || '—'}</span>
        </div>
        <div className="kv">
          <span className="kv-k">重试策略</span>
          <span className="kv-v">
            {current.retryMax} 次 / 间隔 {current.retryInterval}s /{' '}
            {current.retryBackoff === 'exponential' ? '指数退避' : '固定间隔'}（已重试 {current.retryNo} 次）
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">超时</span>
          <span className="kv-v">{current.timeoutSec ? `${current.timeoutSec} 秒` : '默认'}</span>
        </div>
        <div className="kv">
          <span className="kv-k">入队时间 / 原因</span>
          <span className="kv-v">
            {formatTime(current.queuedAt)} / {current.enqueueReason || '—'}
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">pendingFire</span>
          <span className="kv-v">{current.pendingFire ? '是' : '否'}</span>
        </div>
        <div className="kv">
          <span className="kv-k">创建 / 更新</span>
          <span className="kv-v small">
            {formatTime(current.createdAt)} / {formatTime(current.updatedAt)}
          </span>
        </div>
      </div>

      <section className="detail-section">
        <h4>任务描述</h4>
        <pre className="pre-block">{current.description}</pre>
      </section>

      <section className="detail-section">
        <h4>执行产出</h4>
        {current.result ? <pre className="pre-block">{current.result}</pre> : <div className="empty small">暂无产出</div>}
      </section>

      <section className="detail-section">
        <h4>前置依赖（{current.dependencyIds.length}）</h4>
        {current.dependencyIds.length === 0 ? (
          <div className="empty small">无依赖任务</div>
        ) : (
          <ul className="plain-list">
            {current.dependencyIds.map((id) => (
              <li key={id}>
                <span className="mono small muted">{id}</span> {nameOfTask(id)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="detail-section">
        <h4>状态流转日志</h4>
        {statusLogs.length === 0 ? (
          <div className="empty small">暂无流转记录</div>
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>时间</th>
                <th>流转</th>
                <th>操作者</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {statusLogs.map((log, index) => (
                <tr key={`${log.created_at}-${index}`}>
                  <td className="muted small">{formatTime(log.created_at)}</td>
                  <td>
                    <StatusBadge status={log.from_status ?? 'unknown'} /> → <StatusBadge status={log.to_status} />
                  </td>
                  <td className="muted small">
                    {log.actor_type}
                    {log.actor_id ? ` · ${log.actor_id}` : ''}
                  </td>
                  <td className="muted small">{log.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="detail-section">
        <h4>执行记录（{executions.length}）</h4>
        {executions.length === 0 ? (
          <div className="empty small">暂无执行记录</div>
        ) : (
          <ul className="exec-list">
            {executions.map((execution) => (
              <li key={execution.id}>
                <button
                  type="button"
                  className="exec-item"
                  title="查看该次执行的日志"
                  onClick={() => onOpenExecution(execution.id)}
                >
                  <StatusBadge status={execution.status} />
                  <span className="mono small">{execution.id.slice(-8)}</span>
                  <span className="muted small">
                    {execution.trigger_type === 'manual' ? '手动' : '调度'} ·{' '}
                    {formatTime(execution.started_at)}
                  </span>
                  <span className="exec-go muted small">查看日志 →</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Modal>
  );
}
