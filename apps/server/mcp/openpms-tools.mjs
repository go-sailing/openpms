#!/usr/bin/env node
/**
 * mcp/openpms-tools.mjs
 *
 * OpenPMS 任务管理工具的 MCP server（stdio 传输，NDJSON JSON-RPC 2.0）。
 * 由 opencode 以 local MCP 方式拉起，通过环境变量获得执行上下文：
 *   OPENPMS_API_URL / OPENPMS_EXECUTION_ID / OPENPMS_TOOL_TOKEN
 *
 * 所有调用统一转给 OpenPMS HTTP API，由后端做鉴权、状态机校验与审计。
 */
import { createInterface } from 'node:readline';

const API = process.env.OPENPMS_API_URL || 'http://127.0.0.1:4517';
const TOKEN = process.env.OPENPMS_TOOL_TOKEN || '';

const TOOLS = [
  {
    name: 'task_list_my',
    description: '查询当前项目中指派给我（该智能体）的任务列表。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'],
          description: '可选，按状态过滤',
        },
      },
      additionalProperties: false,
    },
    path: 'task/list_my',
  },
  {
    name: 'task_update_status',
    description:
      '更新任务状态。仅允许合法流转；不传 taskId 时更新当前任务。可用于将当前任务标记为已完成（done）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'],
          description: '目标状态',
        },
        taskId: { type: 'string', description: '可选，任务 id，默认当前任务' },
      },
      required: ['status'],
      additionalProperties: false,
    },
    path: 'task/update_status',
  },
  {
    name: 'task_submit_result',
    description: '回写当前任务的产出摘要与结论，供项目其他成员参考。',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'string', description: '产出摘要/结论，Markdown 文本' },
        taskId: { type: 'string', description: '可选，任务 id，默认当前任务' },
      },
      required: ['result'],
      additionalProperties: false,
    },
    path: 'task/submit_result',
  },
  {
    name: 'task_create_subtask',
    description:
      '在当前项目中创建一个子任务并指派给项目成员智能体（仅项目经理类角色可用）。指派人必须是当前项目成员。'
      + '子任务创建后会自动派发执行，无需人工启动：不传 dependencyIds 时创建即入队；'
      + '传了 dependencyIds 时，该子任务会等待全部前置任务完成后再自动入队。'
      + '返回结果包含 taskId，可作为后续子任务的 dependencyIds。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '子任务名称' },
        description: { type: 'string', description: '子任务描述与交付要求' },
        agentId: { type: 'string', description: '被指派的项目成员智能体 id' },
        workspace: { type: 'string', description: '可选，工作目录，默认继承当前任务' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        dependencyIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选，前置依赖任务 id 列表（取自上一步 task_create_subtask 返回的 taskId）。'
            + '传入后该子任务转为依赖触发，需等全部前置任务完成后才会自动派发。',
        },
      },
      required: ['name', 'description', 'agentId'],
      additionalProperties: false,
    },
    path: 'task/create_subtask',
  },
  {
    name: 'task_reassign',
    description: '把当前项目内的某个任务改派给其他项目成员智能体（仅项目经理类角色可用）。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要改派的任务 id' },
        agentId: { type: 'string', description: '目标项目成员智能体 id' },
      },
      required: ['taskId', 'agentId'],
      additionalProperties: false,
    },
    path: 'task/reassign',
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callApi(path, payload) {
  const res = await fetch(`${API}/api/v1/agent-tools/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openpms-token': TOKEN,
    },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { isError: true, text: `服务端返回非 JSON：${text.slice(0, 500)}` };
  }
  if (!res.ok || json.code !== 0) {
    return { isError: true, text: `调用失败(${json.code ?? res.status})：${json.message ?? text}` };
  }
  return { isError: false, text: JSON.stringify(json.data, null, 2) };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'openpms-tools', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true },
      });
      return;
    }
    const out = await callApi(tool.path, args);
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: out.text }], isError: out.isError },
    });
    return;
  }
  if (method === 'resources/list' || method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [], resources: [], prompts: [] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法: ${method}` } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg).catch((err) => {
    if (msg && msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  });
});
rl.on('close', () => process.exit(0));
