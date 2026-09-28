/**
 * runtime/prompt.ts — 上下文组装（SDD 4.2）
 *
 * 顺序：System Prompt（作为 opencode agent 的 prompt 下发）
 *      → 经验记忆
 *      → 运行时上下文（项目信息、项目成员、项目已完成历史任务、当前任务、可用工具）
 *      → 用户指令（任务描述）
 */
import type { AgentConfigForRun, SessionInput } from './types.js';
import { TOOL_CATALOG } from '../platform/types.js';

/** 粗略 token 估算：约 4 字符 = 1 token（中英文混合场景的保守近似） */
const estimateTokens = (s: string): number => Math.ceil(s.length / 2);

function trimByTokens(items: string[], tokenBudget: number, max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const it of items) {
    if (out.length >= max) break;
    const t = estimateTokens(it);
    if (used + t > tokenBudget) break;
    out.push(it);
    used += t;
  }
  return out;
}

export interface AssembleOptions {
  agent: AgentConfigForRun;
  input: SessionInput;
  limits: {
    memoryInjectMax: number;
    memoryInjectTokenBudget: number;
    completedTaskInjectMax: number;
    completedTaskInjectTokenBudget: number;
  };
}

/**
 * 组装 System Prompt：智能体角色定义 + 经验记忆。
 * 顺序遵循 SDD 4.2：System Prompt → 经验记忆 → 运行时上下文 → 用户指令。
 */
export function assembleSystemPrompt(opts: AssembleOptions): string {
  const { agent, input, limits } = opts;
  const parts: string[] = [agent.systemPrompt];

  // ---- 经验记忆（按智能体隔离）----
  parts.push('', '# 经验记忆');
  if (input.memories.length === 0) {
    parts.push('（暂无）');
  } else {
    const lines = input.memories.map((m) => `- ${m.content}`);
    parts.push(...trimByTokens(lines, limits.memoryInjectTokenBudget, limits.memoryInjectMax));
  }

  return parts.join('\n');
}

/** 组装发送给智能体的用户消息（运行时上下文 + 用户指令；System Prompt 由 agent 配置承载） */
export function assembleMessage(opts: AssembleOptions): string {
  const { agent, input, limits } = opts;
  const parts: string[] = [];

  // ---- 运行时上下文 ----
  parts.push('# 运行时上下文');
  parts.push('## 项目');
  parts.push(`- 名称：${input.projectName}`);
  if (input.projectDescription) parts.push(`- 描述：${input.projectDescription}`);

  parts.push('', '## 项目成员（可指派对象）');
  if (input.members.length === 0) {
    parts.push('（暂无成员）');
  } else {
    for (const m of input.members) {
      parts.push(
        `- ${m.name}（agentId: ${m.agentId}）${m.role ? ` — ${m.role}` : ''}${
          m.isSelf ? ' ← 当前执行者' : ''
        }`,
      );
    }
  }

  parts.push('', '## 项目已完成的历史任务');
  if (input.completedTasks.length === 0) {
    parts.push('（暂无已完成任务）');
  } else {
    const lines = input.completedTasks.map(
      (t) => `- 【${t.name}】${(t.result ?? '无产出摘要').replace(/\s+/g, ' ')}`,
    );
    parts.push(
      ...trimByTokens(lines, limits.completedTaskInjectTokenBudget, limits.completedTaskInjectMax),
    );
  }

  parts.push('', '## 当前任务');
  parts.push(`- 名称：${input.taskName}`);
  parts.push(`- 工作目录：${input.workspace}`);
  parts.push(`- 交付要求：${input.taskDescription}`);

  parts.push('', '## 可用工具');
  const toolLabels = agent.tools
    .map((t) => TOOL_CATALOG.find((c) => c.name === t)?.label ?? t)
    .join('、');
  parts.push(`- ${toolLabels || '（无）'}`);

  parts.push('', '## 约束');
  parts.push('- 所有文件读写与命令执行必须限制在工作目录内，禁止越权访问其他路径。');
  parts.push('- 禁止执行提权、关机重启、磁盘操作、危险删除等破坏性命令。');
  parts.push(
    '- 使用 task.create_subtask 创建子任务时，agentId 必须取自上表「项目成员（可指派对象）」中的 id，禁止臆造；子任务创建后会自动派发执行，无需人工启动。',
  );
  parts.push(
    '- 拆解子任务时请为有先后顺序的任务设置前置依赖：先创建前置子任务，再用 task.create_subtask 返回的 taskId 作为后置子任务的 dependencyIds；未设置前置依赖的子任务会立即执行，设置后有前置的子任务会在前置全部完成后自动执行。',
  );
  parts.push(
    '- 使用 task.reassign 改派任务时，目标 agentId 同样必须取自「项目成员（可指派对象）」，禁止臆造。',
  );
  parts.push('- 完成后请简要总结产出与结论。');
  parts.push(
    '- 若本次积累了可复用的经验（规范、约定、踩坑），请在回答末尾以「## 记忆沉淀」为标题，用 Markdown 列表逐条列出，每条一行、简洁且不包含隐私信息；没有则不必输出该标题。',
  );

  // ---- 用户指令 ----
  parts.push('', '请按要求完成任务');

  return parts.join('\n');
}
