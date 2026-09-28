/**
 * agent/service.ts — 智能体、工具授权、经验记忆
 * 对应需求：F-A-01 ~ F-A-03
 */
import type { Db } from '../platform/db.js';
import { idGen } from '../platform/ids.js';
import { now } from '../platform/time.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import { config } from '../platform/config.js';
import { bus } from '../platform/events.js';
import { TOOL_CATALOG, type AgentRow, type MemoryRow } from '../platform/types.js';

export interface AgentDTO {
  id: string;
  name: string;
  role: string | null;
  avatar: string | null;
  systemPrompt: string;
  model: string | null;
  status: string;
  maxConcurrency: number;
  timeoutSec: number | null;
  isBuiltin: boolean;
  tools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentInput {
  name: string;
  role?: string | null;
  avatar?: string | null;
  systemPrompt: string;
  model?: string | null;
  maxConcurrency?: number;
  timeoutSec?: number | null;
  tools?: string[];
}

const VALID_TOOLS = new Set<string>(TOOL_CATALOG.map((t) => t.name));

function rowToDTO(row: AgentRow, tools: string[]): AgentDTO {
  let model: string | null = null;
  if (row.model_config) {
    try {
      model = (JSON.parse(row.model_config) as { model?: string }).model ?? null;
    } catch {
      model = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    model,
    status: row.status,
    maxConcurrency: row.max_concurrency,
    timeoutSec: row.timeout_sec,
    isBuiltin: row.is_builtin === 1,
    tools,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentService {
  constructor(private readonly db: Db) {}

  private toolsOf(agentId: string): string[] {
    return this.db
      .all<{ tool_name: string }>('SELECT tool_name FROM agent_tools WHERE agent_id = ?', agentId)
      .map((r) => r.tool_name);
  }

  private assertTools(tools: string[]): void {
    for (const t of tools) {
      if (!VALID_TOOLS.has(t)) throw badRequest('VALIDATION_DENIED', `未知工具: ${t}`);
    }
  }

  list(): AgentDTO[] {
    const rows = this.db.all<AgentRow>(
      'SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY is_builtin DESC, created_at ASC',
    );
    return rows.map((r) => rowToDTO(r, this.toolsOf(r.id)));
  }

  getOrThrow(id: string): AgentDTO {
    const row = this.db.get<AgentRow>('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', id);
    if (!row) throw notFound(`智能体不存在: ${id}`);
    return rowToDTO(row, this.toolsOf(id));
  }

  getRow(id: string): AgentRow | undefined {
    return this.db.get<AgentRow>('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL', id);
  }

  create(input: AgentInput): AgentDTO {
    if (!input.name?.trim()) throw badRequest('VALIDATION_DENIED', '智能体名称必填');
    if (!input.systemPrompt?.trim()) throw badRequest('VALIDATION_DENIED', 'System Prompt 必填');
    const dup = this.db.get<{ id: string }>('SELECT id FROM agents WHERE name = ? AND deleted_at IS NULL', input.name);
    if (dup) throw badRequest('CONFLICT', `智能体名称已存在: ${input.name}`);

    const tools = input.tools ?? ['fs.read', 'fs.glob', 'fs.grep', 'fs.list'];
    this.assertTools(tools);

    const ts = now();
    const id = idGen.agent();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO agents (id, name, role, avatar, system_prompt, model_config, status,
                             max_concurrency, timeout_sec, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'enabled', ?, ?, 0, ?, ?)`,
        id,
        input.name.trim(),
        input.role ?? null,
        input.avatar ?? null,
        input.systemPrompt,
        input.model ? JSON.stringify({ model: input.model }) : null,
        input.maxConcurrency ?? config.defaultAgentConcurrency,
        input.timeoutSec ?? null,
        ts,
        ts,
      );
      for (const t of tools) {
        this.db.run('INSERT INTO agent_tools (agent_id, tool_name, config) VALUES (?, ?, NULL)', id, t);
      }
    });
    bus.emit({ type: 'agent.updated', payload: { id, action: 'created' } });
    return this.getOrThrow(id);
  }

  update(id: string, input: Partial<AgentInput>): AgentDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`智能体不存在: ${id}`);
    if (input.tools) this.assertTools(input.tools);
    if (input.name && input.name !== row.name) {
      const dup = this.db.get<{ id: string }>(
        'SELECT id FROM agents WHERE name = ? AND deleted_at IS NULL AND id <> ?',
        input.name,
        id,
      );
      if (dup) throw badRequest('CONFLICT', `智能体名称已存在: ${input.name}`);
    }

    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `UPDATE agents SET name = ?, role = ?, avatar = ?, system_prompt = ?, model_config = ?,
                           max_concurrency = ?, timeout_sec = ?, updated_at = ?
         WHERE id = ?`,
        input.name ?? row.name,
        input.role !== undefined ? input.role : row.role,
        input.avatar !== undefined ? input.avatar : row.avatar,
        input.systemPrompt ?? row.system_prompt,
        input.model !== undefined
          ? input.model
            ? JSON.stringify({ model: input.model })
            : null
          : row.model_config,
        input.maxConcurrency ?? row.max_concurrency,
        input.timeoutSec !== undefined ? input.timeoutSec : row.timeout_sec,
        ts,
        id,
      );
      if (input.tools) {
        this.db.run('DELETE FROM agent_tools WHERE agent_id = ?', id);
        for (const t of input.tools) {
          this.db.run('INSERT INTO agent_tools (agent_id, tool_name, config) VALUES (?, ?, NULL)', id, t);
        }
      }
    });
    bus.emit({ type: 'agent.updated', payload: { id, action: 'updated' } });
    return this.getOrThrow(id);
  }

  setStatus(id: string, status: 'enabled' | 'disabled'): AgentDTO {
    const row = this.getRow(id);
    if (!row) throw notFound(`智能体不存在: ${id}`);
    this.db.run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
    bus.emit({ type: 'agent.updated', payload: { id, action: status } });
    return this.getOrThrow(id);
  }

  /** 软删除；被任务引用时保留名称快照（历史任务仍可读）。 */
  remove(id: string): void {
    const row = this.getRow(id);
    if (!row) throw notFound(`智能体不存在: ${id}`);
    const running = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM task_executions WHERE agent_id = ? AND status = 'running'",
      id,
    );
    if ((running?.c ?? 0) > 0) {
      throw new AppError('CONFLICT', '该智能体有正在执行的任务，请先中止后再删除', 409);
    }
    this.db.run('UPDATE agents SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ?', now(), 'disabled', now(), id);
    bus.emit({ type: 'agent.updated', payload: { id, action: 'deleted' } });
  }

  // ---- 经验记忆 ----

  listMemories(agentId: string): MemoryRow[] {
    return this.db.all<MemoryRow>(
      'SELECT * FROM agent_memories WHERE agent_id = ? ORDER BY created_at DESC',
      agentId,
    );
  }

  addMemory(agentId: string, content: string, sourceTaskId?: string | null): MemoryRow {
    if (!content?.trim()) throw badRequest('VALIDATION_DENIED', '记忆内容不能为空');
    const id = idGen.memory();
    const ts = now();
    this.db.run(
      `INSERT INTO agent_memories (id, agent_id, content, source_task_id, status, created_at)
       VALUES (?, ?, ?, ?, 'confirmed', ?)`,
      id,
      agentId,
      content.trim(),
      sourceTaskId ?? null,
      ts,
    );
    return this.db.get<MemoryRow>('SELECT * FROM agent_memories WHERE id = ?', id)!;
  }

  deleteMemory(memoryId: string): void {
    const row = this.db.get<MemoryRow>('SELECT * FROM agent_memories WHERE id = ?', memoryId);
    if (!row) throw notFound(`记忆不存在: ${memoryId}`);
    this.db.run('DELETE FROM agent_memories WHERE id = ?', memoryId);
  }

  /** 自动沉淀（默认模式）：单任务条数封顶。 */
  sinkMemories(agentId: string, taskId: string, contents: string[]): number {
    if (config.memorySinkMode !== 'auto') return 0;
    const cleaned = contents.map((c) => c.trim()).filter(Boolean).slice(0, config.memoryMaxPerTask);
    if (cleaned.length === 0) return 0;
    this.db.tx(() => {
      for (const c of cleaned) this.addMemory(agentId, c, taskId);
    });
    return cleaned.length;
  }
}
