/**
 * agent/routes.ts — 智能体相关接口（F-A-01~F-A-03）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../http/deps.js';
import { fail, ok } from '../http/respond.js';
import { badRequest } from '../platform/errors.js';
import { TOOL_CATALOG } from '../platform/types.js';

const agentInput = z.object({
  name: z.string().min(1),
  role: z.string().nullish(),
  avatar: z.string().nullish(),
  systemPrompt: z.string().min(1),
  model: z.string().nullish(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  timeoutSec: z.number().int().min(1).nullish(),
  tools: z.array(z.string()).optional(),
});

export function registerAgentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { agents } = deps;

  app.get('/api/v1/tools/catalog', async (_req, reply) => ok(reply, TOOL_CATALOG));

  app.get('/api/v1/agents', async (_req, reply) => {
    try {
      return ok(reply, agents.list());
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/agents', async (req, reply) => {
    try {
      const body = agentInput.parse(req.body);
      return ok(reply, agents.create(body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/agents/:id', async (req, reply) => {
    try {
      return ok(reply, agents.getOrThrow(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/v1/agents/:id', async (req, reply) => {
    try {
      const body = agentInput.partial().parse(req.body);
      return ok(reply, agents.update(req.params.id, body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/agents/:id', async (req, reply) => {
    try {
      agents.remove(req.params.id);
      return ok(reply, { removed: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/agents/:id/enable', async (req, reply) => {
    try {
      return ok(reply, agents.setStatus(req.params.id, 'enabled'));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/agents/:id/disable', async (req, reply) => {
    try {
      return ok(reply, agents.setStatus(req.params.id, 'disabled'));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 经验记忆：只读 + 删除。记忆由任务执行结束后自动沉淀，不支持手动新增/编辑。
  app.get<{ Params: { id: string } }>('/api/v1/agents/:id/memories', async (req, reply) => {
    try {
      return ok(reply, agents.listMemories(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { memoryId: string } }>('/api/v1/memories/:memoryId', async (req, reply) => {
    try {
      agents.deleteMemory(req.params.memoryId);
      return ok(reply, { removed: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/agents/:id/tools', async (req, reply) => {
    try {
      const a = agents.getOrThrow(req.params.id);
      return ok(reply, a.tools);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put<{ Params: { id: string } }>('/api/v1/agents/:id/tools', async (req, reply) => {
    try {
      const body = z.object({ tools: z.array(z.string()) }).parse(req.body);
      const invalid = body.tools.filter((t) => !TOOL_CATALOG.some((c) => c.name === t));
      if (invalid.length) throw badRequest('VALIDATION_DENIED', `未知工具: ${invalid.join(',')}`);
      return ok(reply, agents.update(req.params.id, { tools: body.tools }));
    } catch (e) {
      return fail(reply, e);
    }
  });
}
