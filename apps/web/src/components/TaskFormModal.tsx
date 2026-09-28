/**
 * TaskFormModal.tsx — 任务表单弹窗（新建 / 编辑；项目上下文固定，智能体仅可选当前项目已启用成员）
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { useToast } from './Toast';
import type { Member, Priority, Project, RetryBackoff, Task, TaskInput, TriggerMode } from '../types';
import { fromLocalInput, toLocalInput } from '../utils';

interface TaskForm {
  agentId: string;
  name: string;
  description: string;
  workspace: string;
  priority: Priority;
  triggerMode: TriggerMode;
  scheduleMode: 'time' | 'cron';
  scheduledAt: string;
  cronExpr: string;
  retryMax: string;
  retryInterval: string;
  retryBackoff: RetryBackoff;
  timeoutSec: string;
  dependencyIds: string[];
}

const EMPTY_FORM: TaskForm = {
  agentId: '',
  name: '',
  description: '',
  workspace: '',
  priority: 'medium',
  triggerMode: 'manual',
  scheduleMode: 'time',
  scheduledAt: '',
  cronExpr: '',
  retryMax: '0',
  retryInterval: '0',
  retryBackoff: 'fixed',
  timeoutSec: '',
  dependencyIds: [],
};

interface TaskFormModalProps {
  project: Project;
  members: Member[];
  /** 传入则为编辑模式 */
  task?: Task | null;
  onClose: () => void;
  onSaved: () => void;
}

/** 由已有任务初始化表单（编辑模式） */
function formFromTask(task: Task): TaskForm {
  return {
    agentId: task.agentId,
    name: task.name,
    description: task.description,
    workspace: task.workspace ?? '',
    priority: task.priority,
    triggerMode: task.triggerMode,
    scheduleMode: task.cronExpr ? 'cron' : 'time',
    scheduledAt: toLocalInput(task.scheduledAt),
    cronExpr: task.cronExpr ?? '',
    retryMax: String(task.retryMax),
    retryInterval: String(task.retryInterval),
    retryBackoff: task.retryBackoff,
    timeoutSec: task.timeoutSec ? String(task.timeoutSec) : '',
    dependencyIds: [...task.dependencyIds],
  };
}

export function TaskFormModal({ project, members, task, onClose, onSaved }: TaskFormModalProps) {
  const isEdit = Boolean(task);
  const toast = useToast();
  const [form, setForm] = useState<TaskForm>(
    task ? formFromTask(task) : { ...EMPTY_FORM, workspace: project.defaultWorkspace ?? '' },
  );
  const [busy, setBusy] = useState(false);
  const [projectTasks, setProjectTasks] = useState<Task[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.listTasks({ projectId: project.id });
        // 编辑时排除自身，避免自依赖
        setProjectTasks(task ? list.filter((item) => item.id !== task.id) : list);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
    })();
  }, [project.id, task, toast]);

  const enabledMembers = members.filter((member) => member.agentStatus === 'enabled');

  const saveTask = async () => {
    if (!form.agentId || !form.name.trim() || !form.description.trim()) {
      toast.error('指派智能体、任务名称与描述为必填项');
      return;
    }
    const isScheduled = form.triggerMode === 'scheduled';
    const payload: TaskInput = {
      projectId: project.id,
      agentId: form.agentId,
      name: form.name.trim(),
      description: form.description,
      // 编辑时留空表示沿用原工作目录（工作目录为必填，不允许置空）
      workspace: form.workspace.trim() || (isEdit ? undefined : null),
      priority: form.priority,
      triggerMode: form.triggerMode,
      scheduledAt: isScheduled && form.scheduleMode === 'time' ? fromLocalInput(form.scheduledAt) : null,
      cronExpr: isScheduled && form.scheduleMode === 'cron' ? form.cronExpr.trim() || null : null,
      retryMax: Math.min(10, Math.max(0, Number(form.retryMax) || 0)),
      retryInterval: Math.max(0, Number(form.retryInterval) || 0),
      retryBackoff: form.retryBackoff,
      timeoutSec: form.timeoutSec ? Math.max(1, Number(form.timeoutSec)) : null,
      dependencyIds: form.triggerMode === 'dependency' ? form.dependencyIds : [],
    };
    setBusy(true);
    try {
      if (task) {
        await api.updateTask(task.id, payload);
        toast.success('任务已更新');
      } else {
        await api.createTask(payload);
        toast.success('任务已创建');
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? '编辑任务' : '新增任务'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void saveTask()} disabled={busy}>
            {busy ? '保存中…' : isEdit ? '保存修改' : '创建任务'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>项目</span>
          <input value={project.name} readOnly disabled />
        </label>
        <label className="field">
          <span>指派智能体 *（仅项目成员）</span>
          <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
            <option value="">请选择智能体</option>
            {enabledMembers.map((member) => (
              <option key={member.agentId} value={member.agentId}>
                {member.agentName}
              </option>
            ))}
          </select>
          {enabledMembers.length === 0 ? <span className="hint">该项目暂无可用的已启用成员</span> : null}
        </label>
        <label className="field wide">
          <span>任务名称 *</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field wide">
          <span>任务描述 *</span>
          <textarea
            rows={4}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="清晰描述交付物与验收要点"
          />
        </label>
        <label className="field">
          <span>工作目录</span>
          <input
            value={form.workspace}
            onChange={(e) => setForm({ ...form, workspace: e.target.value })}
            placeholder={project.defaultWorkspace ?? '留空使用项目默认目录'}
          />
        </label>
        <label className="field">
          <span>优先级</span>
          <select
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <label className="field">
          <span>触发方式</span>
          <select
            value={form.triggerMode}
            onChange={(e) => setForm({ ...form, triggerMode: e.target.value as TriggerMode })}
          >
            <option value="manual">手动</option>
            <option value="auto">自动</option>
            <option value="scheduled">定时</option>
            <option value="dependency">依赖触发</option>
          </select>
        </label>
        <label className="field">
          <span>超时秒数</span>
          <input
            type="number"
            min={1}
            value={form.timeoutSec}
            onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })}
            placeholder="留空使用默认"
          />
        </label>

        {form.triggerMode === 'scheduled' ? (
          <div className="field wide schedule-box">
            <div className="schedule-mode">
              <label className="radio-item">
                <input
                  type="radio"
                  name="schedule-mode"
                  checked={form.scheduleMode === 'time'}
                  onChange={() => setForm({ ...form, scheduleMode: 'time' })}
                />
                <span>计划时间</span>
              </label>
              <label className="radio-item">
                <input
                  type="radio"
                  name="schedule-mode"
                  checked={form.scheduleMode === 'cron'}
                  onChange={() => setForm({ ...form, scheduleMode: 'cron' })}
                />
                <span>Cron 表达式</span>
              </label>
            </div>
            {form.scheduleMode === 'time' ? (
              <input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
              />
            ) : (
              <input
                value={form.cronExpr}
                onChange={(e) => setForm({ ...form, cronExpr: e.target.value })}
                placeholder="如：0 9 * * 1-5"
              />
            )}
          </div>
        ) : null}

        {form.triggerMode === 'dependency' ? (
          <div className="field wide">
            <span>前置依赖任务（{form.dependencyIds.length} 项已选）</span>
            {projectTasks.length === 0 ? (
              <span className="hint">该项目暂无任务可选</span>
            ) : (
              <div className="dep-list">
                {projectTasks.map((task) => (
                  <label key={task.id} className="dep-item">
                    <input
                      type="checkbox"
                      checked={form.dependencyIds.includes(task.id)}
                      onChange={() =>
                        setForm((prev) => {
                          const has = prev.dependencyIds.includes(task.id);
                          return {
                            ...prev,
                            dependencyIds: has
                              ? prev.dependencyIds.filter((id) => id !== task.id)
                              : [...prev.dependencyIds, task.id],
                          };
                        })
                      }
                    />
                    <span>{task.name}</span>
                    <StatusBadge status={task.status} />
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <label className="field">
          <span>重试次数上限</span>
          <input
            type="number"
            min={0}
            max={10}
            value={form.retryMax}
            onChange={(e) => setForm({ ...form, retryMax: e.target.value })}
          />
        </label>
        <label className="field">
          <span>重试间隔（秒）</span>
          <input
            type="number"
            min={0}
            value={form.retryInterval}
            onChange={(e) => setForm({ ...form, retryInterval: e.target.value })}
          />
        </label>
        <label className="field">
          <span>重试退避</span>
          <select
            value={form.retryBackoff}
            onChange={(e) => setForm({ ...form, retryBackoff: e.target.value as RetryBackoff })}
          >
            <option value="fixed">固定间隔</option>
            <option value="exponential">指数退避</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}
