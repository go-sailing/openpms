/**
 * AgentsPage.tsx — 智能体列表、增删改、启停、经验记忆管理
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty } from '../components/Empty';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import type { Agent, AgentInput, Memory, ToolCatalogItem } from '../types';
import { formatTime, riskLabel, truncate } from '../utils';

interface AgentForm {
  id: string | null;
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  maxConcurrency: string;
  timeoutSec: string;
  tools: string[];
}

const EMPTY_FORM: AgentForm = {
  id: null,
  name: '',
  role: '',
  systemPrompt: '',
  model: '',
  maxConcurrency: '1',
  timeoutSec: '',
  tools: [],
};

function toForm(agent: Agent): AgentForm {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? '',
    systemPrompt: agent.systemPrompt,
    model: agent.model ?? '',
    maxConcurrency: String(agent.maxConcurrency),
    timeoutSec: agent.timeoutSec === null ? '' : String(agent.timeoutSec),
    tools: [...agent.tools],
  };
}

export function AgentsPage() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [catalog, setCatalog] = useState<ToolCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

  const [memoryAgent, setMemoryAgent] = useState<Agent | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);

  const load = useCallback(async () => {
    try {
      const [agentList, toolList] = await Promise.all([api.listAgents(), api.toolCatalog()]);
      setAgents(agentList);
      setCatalog(toolList);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveForm = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.systemPrompt.trim()) {
      toast.error('名称与 System Prompt 为必填项');
      return;
    }
    const payload: AgentInput = {
      name: form.name.trim(),
      role: form.role.trim() || null,
      systemPrompt: form.systemPrompt,
      model: form.model.trim() || null,
      maxConcurrency: Math.min(20, Math.max(1, Number(form.maxConcurrency) || 1)),
      timeoutSec: form.timeoutSec ? Math.max(1, Number(form.timeoutSec)) : null,
      tools: form.tools,
    };
    setBusy(true);
    try {
      if (form.id) {
        await api.updateAgent(form.id, payload);
        toast.success('智能体已更新');
      } else {
        await api.createAgent(payload);
        toast.success('智能体已创建');
      }
      setForm(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (agent: Agent) => {
    try {
      if (agent.status === 'enabled') await api.disableAgent(agent.id);
      else await api.enableAgent(agent.id);
      toast.success(agent.status === 'enabled' ? '已停用' : '已启用');
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const removeAgent = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.deleteAgent(pendingDelete.id);
      toast.success('智能体已删除');
      setPendingDelete(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openMemories = async (agent: Agent) => {
    setMemoryAgent(agent);
    try {
      setMemories(await api.listMemories(agent.id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const reloadMemories = async (agentId: string) => {
    try {
      setMemories(await api.listMemories(agentId));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const removeMemory = async (memoryId: string) => {
    if (!memoryAgent) return;
    try {
      await api.deleteMemory(memoryId);
      toast.success('记忆已删除');
      await reloadMemories(memoryAgent.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const toggleTool = (name: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      const has = prev.tools.includes(name);
      return { ...prev, tools: has ? prev.tools.filter((t) => t !== name) : [...prev.tools, name] };
    });
  };

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-info">共 {agents.length} 个智能体</div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setForm({ ...EMPTY_FORM })}>
            新增智能体
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">加载中…</div>
      ) : agents.length === 0 ? (
        <Empty text="暂无智能体，点击「新增智能体」创建第一个" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>角色</th>
              <th>状态</th>
              <th>工具数</th>
              <th>类型</th>
              <th>模型</th>
              <th>更新时间</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <td>
                  <button type="button" className="link" onClick={() => void openMemories(agent)}>
                    {agent.name}
                  </button>
                </td>
                <td className="muted">{truncate(agent.role, 40)}</td>
                <td>
                  <StatusBadge status={agent.status} />
                </td>
                <td>{agent.tools.length}</td>
                <td>{agent.isBuiltin ? <span className="tag">内置</span> : <span className="tag tag-plain">自定义</span>}</td>
                <td className="mono muted">{agent.model || '默认'}</td>
                <td className="muted small">{formatTime(agent.updatedAt)}</td>
                <td className="col-actions">
                  <button type="button" className="btn btn-xs" onClick={() => setForm(toForm(agent))}>
                    编辑
                  </button>
                  <button type="button" className="btn btn-xs" onClick={() => void toggleStatus(agent)}>
                    {agent.status === 'enabled' ? '停用' : '启用'}
                  </button>
                  <button type="button" className="btn btn-xs" onClick={() => void openMemories(agent)}>
                    记忆
                  </button>
                  <button type="button" className="btn btn-xs btn-danger" onClick={() => setPendingDelete(agent)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {form ? (
        <Modal
          title={form.id ? '编辑智能体' : '新增智能体'}
          size="lg"
          onClose={() => setForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setForm(null)} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void saveForm()} disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <label className="field">
              <span>名称 *</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：开发工程师"
              />
            </label>
            <label className="field">
              <span>角色</span>
              <input
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                placeholder="如：负责代码实现与调试"
              />
            </label>
            <label className="field">
              <span>模型</span>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="留空使用系统默认模型"
              />
            </label>
            <label className="field">
              <span>最大并发</span>
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxConcurrency}
                onChange={(e) => setForm({ ...form, maxConcurrency: e.target.value })}
              />
            </label>
            <label className="field">
              <span>超时秒数</span>
              <input
                type="number"
                min={1}
                value={form.timeoutSec}
                onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })}
                placeholder="留空使用全局超时"
              />
            </label>
            <label className="field wide">
              <span>System Prompt *</span>
              <textarea
                rows={8}
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                placeholder="定义智能体的职责、工作方式与输出规范"
              />
            </label>
            <div className="field wide">
              <span>工具授权（{form.tools.length} 项已选）</span>
              <div className="tool-picker">
                {catalog.map((tool) => (
                  <label key={tool.name} className="tool-option">
                    <input
                      type="checkbox"
                      checked={form.tools.includes(tool.name)}
                      onChange={() => toggleTool(tool.name)}
                    />
                    <span className="tool-name">{tool.label}</span>
                    <span className="mono muted small">{tool.name}</span>
                    <span className={`tag risk-${tool.risk}`}>{riskLabel(tool.risk)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {memoryAgent ? (
        <Modal
          title={`经验记忆 · ${memoryAgent.name}`}
          size="lg"
          onClose={() => setMemoryAgent(null)}
          footer={
            <button type="button" className="btn" onClick={() => setMemoryAgent(null)}>
              关闭
            </button>
          }
        >
          <p className="muted small">
            经验记忆由任务执行结束后自动沉淀，仅可查看或删除，不支持手动新增与编辑。
          </p>
          {memories.length === 0 ? (
            <Empty text="该智能体暂无经验记忆" />
          ) : (
            <ul className="memory-list">
              {memories.map((memory) => (
                <li key={memory.id} className="memory-item">
                  <div className="memory-text">{memory.content}</div>
                  <div className="memory-meta">
                    <span className="muted small">
                      {formatTime(memory.created_at)}
                      {memory.source_task_id ? ` · 来源任务 ${memory.source_task_id}` : ''}
                    </span>
                    <span className="memory-actions">
                      <button
                        type="button"
                        className="btn btn-xs btn-danger"
                        onClick={() => void removeMemory(memory.id)}
                      >
                        删除
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="删除智能体"
          danger
          busy={busy}
          confirmText="确认删除"
          message={
            <>
              确定要删除智能体「{pendingDelete.name}」吗？该操作不可撤销。
            </>
          }
          onConfirm={() => void removeAgent()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
