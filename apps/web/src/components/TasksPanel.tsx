/**
 * TasksPanel.tsx — 项目详情内的任务面板：筛选、任务列表、新建与详情入口
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { Empty } from './Empty';
import { PriorityBadge, StatusBadge } from './StatusBadge';
import { TaskDetailView } from './TaskDetailView';
import { TaskFormModal } from './TaskFormModal';
import { useToast } from './Toast';
import { useWsEvent } from '../hooks/useWebSocket';
import type { Member, Project, Task } from '../types';
import { formatTime, triggerLabel } from '../utils';

const STATUS_OPTIONS = ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'] as const;

interface TasksPanelProps {
  project: Project;
  members: Member[];
  /** 点击任务详情里的执行记录时，跳转到执行日志页并选中该记录 */
  onOpenExecution: (executionId: string) => void;
}

export function TasksPanel({ project, members, onOpenExecution }: TasksPanelProps) {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const [filterStatus, setFilterStatus] = useState('');
  const [filterKeyword, setFilterKeyword] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  const lastRefresh = useRef(0);

  const loadTasks = useCallback(async () => {
    try {
      setTasks(
        await api.listTasks({
          projectId: project.id,
          status: filterStatus || undefined,
          keyword: filterKeyword || undefined,
        }),
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id, filterStatus, filterKeyword, toast]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useWsEvent((event) => {
    if (
      event.type === 'task.updated' ||
      event.type === 'queue.updated' ||
      event.type === 'scheduler.diagnostic' ||
      event.type.startsWith('execution.')
    ) {
      const now = Date.now();
      if (now - lastRefresh.current < 800) return;
      lastRefresh.current = now;
      void loadTasks();
    }
  });

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.deleteTask(pendingDelete.id);
      toast.success(`任务「${pendingDelete.name}」已删除`);
      setPendingDelete(null);
      if (detailTask?.id === pendingDelete.id) setDetailTask(null);
      await loadTasks();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel tasks-panel">
      <div className="panel-head">
        <h2>项目任务</h2>
      </div>

      <div className="toolbar">
        <div className="filters">
          <label className="field inline">
            <span>状态</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">全部</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span>关键字</span>
            <input
              value={filterKeyword}
              onChange={(e) => setFilterKeyword(e.target.value)}
              placeholder="任务名称/描述"
            />
          </label>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void loadTasks()}>
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            新增任务
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">加载中…</div>
      ) : tasks.length === 0 ? (
        <Empty text="暂无符合条件的任务" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>任务</th>
              <th>指派智能体</th>
              <th>状态</th>
              <th>优先级</th>
              <th>触发方式</th>
              <th>下次运行</th>
              <th>更新时间</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <button type="button" className="link" onClick={() => setDetailTask(task)}>
                    {task.name}
                  </button>
                </td>
                <td>{task.agentName ?? task.agentId}</td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
                <td>
                  <PriorityBadge priority={task.priority} />
                </td>
                <td className="muted">{triggerLabel(task.triggerMode)}</td>
                <td className="muted small">{formatTime(task.nextRunAt)}</td>
                <td className="muted small">{formatTime(task.updatedAt)}</td>
                <td className="col-actions">
                  <button type="button" className="btn btn-xs" onClick={() => setDetailTask(task)}>
                    详情
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={task.status === 'running'}
                    title={task.status === 'running' ? '执行中的任务不可编辑' : '编辑任务'}
                    onClick={() => setEditTask(task)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    disabled={task.status === 'running'}
                    title={task.status === 'running' ? '执行中的任务不可删除，请先取消执行' : '删除任务'}
                    onClick={() => setPendingDelete(task)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate ? (
        <TaskFormModal
          project={project}
          members={members}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            void loadTasks();
          }}
        />
      ) : null}

      {editTask ? (
        <TaskFormModal
          project={project}
          members={members}
          task={editTask}
          onClose={() => setEditTask(null)}
          onSaved={() => {
            setEditTask(null);
            void loadTasks();
          }}
        />
      ) : null}

      {detailTask ? (
        <TaskDetailView
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onChanged={() => void loadTasks()}
          onOpenExecution={onOpenExecution}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="删除任务"
          danger
          confirmText="确认删除"
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
          message={
            <>
              <p>
                确定要删除任务「<strong>{pendingDelete.name}</strong>」吗？
              </p>
              <p className="muted small">
                该任务的执行记录、状态流转日志与日志文件将一并删除，且不可恢复。
                若其他任务依赖该任务，或该任务有子任务，需先解除后再删除。
              </p>
            </>
          }
        />
      ) : null}
    </section>
  );
}
