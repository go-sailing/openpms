/**
 * ProjectsPage.tsx — 项目列表/新增/编辑/归档，项目成员管理（含移除确认与改派）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty } from '../components/Empty';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { TasksPanel } from '../components/TasksPanel';
import { useToast } from '../components/Toast';
import { useWsEvent } from '../hooks/useWebSocket';
import type { Agent, Member, Project } from '../types';
import { formatTime, truncate } from '../utils';

interface ProjectForm {
  id: string | null;
  name: string;
  description: string;
  defaultWorkspace: string;
  autoScheduleEnabled: boolean;
}

interface OpenTaskBrief {
  id: string;
  name: string;
  status: string;
}

interface RemoveConfirmDetails {
  requiresConfirm: boolean;
  openTasks: OpenTaskBrief[];
  strategies: string[];
}

const EMPTY_FORM: ProjectForm = {
  id: null,
  name: '',
  description: '',
  defaultWorkspace: '',
  autoScheduleEnabled: true,
};

export function ProjectsPage({ onOpenExecution }: { onOpenExecution: (executionId: string) => void }) {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [busy, setBusy] = useState(false);

  const [detail, setDetail] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const [pendingRemove, setPendingRemove] = useState<{ member: Member; details: RemoveConfirmDetails } | null>(null);
  const [removeStrategy, setRemoveStrategy] = useState<'reassign' | 'keep'>('reassign');
  const [reassignTo, setReassignTo] = useState('');

  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);

  const lastRefresh = useRef(0);

  const loadList = useCallback(async () => {
    try {
      const [projectList, agentList] = await Promise.all([api.listProjects(), api.listAgents()]);
      setProjects(projectList);
      setAgents(agentList);
      // 同步刷新详情对象，保证任务/成员计数最新（删除确认等处会用到）
      setDetail((current) =>
        current ? projectList.find((p) => p.id === current.id) ?? current : current,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadMembers = useCallback(
    async (projectId: string) => {
      try {
        setMembers(await api.listMembers(projectId));
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (detail) void loadMembers(detail.id);
  }, [detail, loadMembers]);

  useWsEvent((event) => {
    if (event.type !== 'project.updated' && event.type !== 'task.updated') return;
    const now = Date.now();
    if (now - lastRefresh.current < 800) return;
    lastRefresh.current = now;
    void loadList();
    if (detail) void loadMembers(detail.id);
  });

  const saveForm = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast.error('项目名称为必填项');
      return;
    }
    setBusy(true);
    try {
      if (form.id) {
        const updated = await api.updateProject(form.id, {
          name: form.name.trim(),
          description: form.description.trim() || null,
          defaultWorkspace: form.defaultWorkspace.trim() || null,
          autoScheduleEnabled: form.autoScheduleEnabled,
        });
        toast.success('项目已更新');
        if (detail && detail.id === updated.id) setDetail(updated);
      } else {
        await api.createProject({
          name: form.name.trim(),
          description: form.description.trim() || null,
          defaultWorkspace: form.defaultWorkspace.trim() || null,
        });
        toast.success('项目已创建');
      }
      setForm(null);
      await loadList();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (project: Project) => {
    try {
      const updated = await api.archiveProject(project.id);
      toast.success('项目已归档');
      if (detail && detail.id === updated.id) setDetail(updated);
      await loadList();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const confirmDeleteProject = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      const result = await api.deleteProject(pendingDelete.id, { confirm: true });
      toast.success(
        `项目「${pendingDelete.name}」已删除${result.deletedTasks ? `（含 ${result.deletedTasks} 个任务）` : ''}`,
      );
      if (detail && detail.id === pendingDelete.id) setDetail(null);
      setPendingDelete(null);
      await loadList();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (agentId: string) => {
    if (!detail) return;
    try {
      await api.addMembers(detail.id, [agentId]);
      toast.success('成员已添加');
      await loadMembers(detail.id);
      await loadList();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const requestRemove = async (member: Member) => {
    if (!detail) return;
    try {
      await api.removeMember(detail.id, member.agentId);
      toast.success('成员已移除');
      await loadMembers(detail.id);
      await loadList();
    } catch (e) {
      if (e instanceof ApiError && e.details && (e.details as RemoveConfirmDetails).requiresConfirm) {
        const details = e.details as RemoveConfirmDetails;
        setRemoveStrategy(details.strategies.includes('reassign') ? 'reassign' : 'keep');
        setReassignTo('');
        setPendingRemove({ member, details });
        return;
      }
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const confirmRemove = async () => {
    if (!detail || !pendingRemove) return;
    if (removeStrategy === 'reassign' && !reassignTo) {
      toast.error('请选择改派目标成员');
      return;
    }
    setBusy(true);
    try {
      await api.removeMember(detail.id, pendingRemove.member.agentId, {
        confirm: true,
        strategy: removeStrategy,
        reassignToAgentId: removeStrategy === 'reassign' ? reassignTo : undefined,
      });
      toast.success('成员已移除');
      setPendingRemove(null);
      await loadMembers(detail.id);
      await loadList();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const candidates = detail
    ? agents.filter((a) => a.status === 'enabled' && !members.some((m) => m.agentId === a.id))
    : [];
  const reassignCandidates = members.filter(
    (m) => m.agentId !== pendingRemove?.member.agentId && m.agentStatus === 'enabled',
  );

  /* ---------------- 项目详情 ---------------- */

  if (detail) {
    return (
      <div className="page">
        <div className="toolbar">
          <div className="toolbar-info">
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setDetail(null)}>
              ← 返回项目列表
            </button>
          </div>
          <div className="toolbar-actions">
            <button type="button" className="btn" onClick={() => void loadMembers(detail.id)}>
              刷新成员
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                setForm({
                  id: detail.id,
                  name: detail.name,
                  description: detail.description ?? '',
                  defaultWorkspace: detail.defaultWorkspace ?? '',
                  autoScheduleEnabled: detail.autoScheduleEnabled,
                })
              }
            >
              编辑项目
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setPendingDelete(detail)}>
              删除项目
            </button>
          </div>
        </div>

        <section className="panel">
          <div className="panel-head">
            <h2>{detail.name}</h2>
            <StatusBadge status={detail.status} />
          </div>
          <div className="kv-grid">
            <div className="kv">
              <span className="kv-k">描述</span>
              <span className="kv-v">{detail.description || '—'}</span>
            </div>
            <div className="kv">
              <span className="kv-k">默认工作目录</span>
              <span className="kv-v mono">{detail.defaultWorkspace || '—'}</span>
            </div>
            <div className="kv">
              <span className="kv-k">自动调度</span>
              <span className="kv-v">{detail.autoScheduleEnabled ? '开启' : '关闭'}</span>
            </div>
            <div className="kv">
              <span className="kv-k">成员 / 任务</span>
              <span className="kv-v">
                {detail.memberCount} / {detail.taskCount}
              </span>
            </div>
          </div>
        </section>

        <TasksPanel project={detail} members={members} onOpenExecution={onOpenExecution} />

        <section className="panel">
          <div className="panel-head">
            <h2>项目成员</h2>
            <div className="panel-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setShowAddMember(true)}
              >
                添加成员
              </button>
            </div>
          </div>
          {members.length === 0 ? (
            <Empty text="该项目暂无成员，请点击右上角「添加成员」" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>在办任务</th>
                  <th>加入时间</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      {member.agentName}
                      <span className="mono muted small"> {member.agentId}</span>
                    </td>
                    <td className="muted">{truncate(member.agentRole, 36)}</td>
                    <td>
                      <StatusBadge status={member.agentStatus} />
                    </td>
                    <td>{member.openTaskCount}</td>
                    <td className="muted small">{formatTime(member.joinedAt)}</td>
                    <td className="col-actions">
                      <button type="button" className="btn btn-xs btn-danger" onClick={() => void requestRemove(member)}>
                        移除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {showAddMember ? (
          <Modal
            title="添加项目成员"
            size="md"
            onClose={() => setShowAddMember(false)}
            footer={
              <button type="button" className="btn" onClick={() => setShowAddMember(false)}>
                关闭
              </button>
            }
          >
            <p className="muted small">
              仅可添加已启用且尚未加入本项目的智能体。指派任务时只能从项目成员中选择。
            </p>
            {candidates.length === 0 ? (
              <Empty text="没有可添加的智能体" />
            ) : (
              <div className="chip-list">
                {candidates.map((agent) => (
                  <div className="chip" key={agent.id}>
                    <span>{agent.name}</span>
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      disabled={busy}
                      onClick={() => void addMember(agent.id)}
                    >
                      加入
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Modal>
        ) : null}

        {form ? (
          <ProjectFormModal
            form={form}
            busy={busy}
            onChange={setForm}
            onClose={() => setForm(null)}
            onSave={saveForm}
          />
        ) : null}

        {pendingRemove ? (
          <Modal
            title="移除成员确认"
            size="md"
            onClose={() => setPendingRemove(null)}
            footer={
              <>
                <button type="button" className="btn" onClick={() => setPendingRemove(null)} disabled={busy}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void confirmRemove()} disabled={busy}>
                  {busy ? '处理中…' : '确认移除'}
                </button>
              </>
            }
          >
            <p className="warn-text">
              成员「{pendingRemove.member.agentName}」在该项目下还有 {pendingRemove.details.openTasks.length}{' '}
              个未完成任务，请选择处理方式：
            </p>
            <ul className="task-brief-list">
              {pendingRemove.details.openTasks.map((task) => (
                <li key={task.id}>
                  <span>{task.name}</span>
                  <StatusBadge status={task.status} />
                </li>
              ))}
            </ul>
            <div className="radio-group">
              <label className="radio-item">
                <input
                  type="radio"
                  name="remove-strategy"
                  checked={removeStrategy === 'reassign'}
                  onChange={() => setRemoveStrategy('reassign')}
                />
                <span>改派给其他成员</span>
              </label>
              <label className="radio-item">
                <input
                  type="radio"
                  name="remove-strategy"
                  checked={removeStrategy === 'keep'}
                  onChange={() => setRemoveStrategy('keep')}
                />
                <span>保留任务待人工处理</span>
              </label>
            </div>
            {removeStrategy === 'reassign' ? (
              <label className="field">
                <span>改派目标成员</span>
                <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                  <option value="">请选择…</option>
                  {reassignCandidates.map((member) => (
                    <option key={member.agentId} value={member.agentId}>
                      {member.agentName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </Modal>
        ) : null}

        {pendingDelete ? (
          <ConfirmDialog
            title="删除项目"
            danger
            confirmText="确认删除"
            busy={busy}
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => void confirmDeleteProject()}
            message={
              <>
                <p>
                  确定要删除项目「<strong>{pendingDelete.name}</strong>」吗？
                </p>
                <p className="muted small">
                  将同时删除该项目下的 {pendingDelete.taskCount} 个任务、{pendingDelete.memberCount}{' '}
                  条成员关系及其执行记录与日志，且不可恢复。
                </p>
              </>
            }
          />
        ) : null}
      </div>
    );
  }

  /* ---------------- 项目列表 ---------------- */

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-info">共 {projects.length} 个项目</div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void loadList()}>
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setForm({ ...EMPTY_FORM })}>
            新增项目
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">加载中…</div>
      ) : projects.length === 0 ? (
        <Empty text="暂无项目，点击「新增项目」创建" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>项目</th>
              <th>描述</th>
              <th>状态</th>
              <th>自动调度</th>
              <th>成员</th>
              <th>任务</th>
              <th>创建时间</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>
                  <button type="button" className="link" onClick={() => setDetail(project)}>
                    {project.name}
                  </button>
                </td>
                <td className="muted">{truncate(project.description, 40)}</td>
                <td>
                  <StatusBadge status={project.status} />
                </td>
                <td>{project.autoScheduleEnabled ? '开启' : '关闭'}</td>
                <td>{project.memberCount}</td>
                <td>{project.taskCount}</td>
                <td className="muted small">{formatTime(project.createdAt)}</td>
                <td className="col-actions">
                  <button type="button" className="btn btn-xs" onClick={() => setDetail(project)}>
                    成员
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() =>
                      setForm({
                        id: project.id,
                        name: project.name,
                        description: project.description ?? '',
                        defaultWorkspace: project.defaultWorkspace ?? '',
                        autoScheduleEnabled: project.autoScheduleEnabled,
                      })
                    }
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => void archive(project)}
                    disabled={project.status === 'archived'}
                  >
                    归档
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    onClick={() => setPendingDelete(project)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {form ? (
        <ProjectFormModal
          form={form}
          busy={busy}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={saveForm}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="删除项目"
          danger
          confirmText="确认删除"
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDeleteProject()}
          message={
            <>
              <p>
                确定要删除项目「<strong>{pendingDelete.name}</strong>」吗？
              </p>
              <p className="muted small">
                将同时删除该项目下的 {pendingDelete.taskCount} 个任务、{pendingDelete.memberCount}{' '}
                条成员关系及其执行记录与日志，且不可恢复。
              </p>
            </>
          }
        />
      ) : null}
    </div>
  );
}

interface ProjectFormModalProps {
  form: ProjectForm;
  busy: boolean;
  onChange: (form: ProjectForm) => void;
  onClose: () => void;
  onSave: () => void;
}

function ProjectFormModal({ form, busy, onChange, onClose, onSave }: ProjectFormModalProps) {
  return (
    <Modal
      title={form.id ? '编辑项目' : '新增项目'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field wide">
          <span>名称 *</span>
          <input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
        </label>
        <label className="field wide">
          <span>描述</span>
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
          />
        </label>
        <label className="field wide">
          <span>默认工作目录</span>
          <input
            value={form.defaultWorkspace}
            onChange={(e) => onChange({ ...form, defaultWorkspace: e.target.value })}
            placeholder="如：/tmp/openpms-demo"
          />
        </label>
        {form.id ? (
          <label className="field wide checkbox-field">
            <input
              type="checkbox"
              checked={form.autoScheduleEnabled}
              onChange={(e) => onChange({ ...form, autoScheduleEnabled: e.target.checked })}
            />
            <span>启用自动调度（项目内任务按触发方式自动派发）</span>
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
