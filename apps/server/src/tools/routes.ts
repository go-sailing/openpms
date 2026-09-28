/**
 * tools/routes.ts — 智能体任务管理工具的 HTTP 入口（供 MCP server 回调）
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../http/deps.js';
import type { ToolService } from './service.js';
import { fail, ok } from '../http/respond.js';
import { badRequest } from '../platform/errors.js';
import type { TaskStatus } from '../platform/types.js';

function tokenOf(req: FastifyRequest): string {
  const t = req.headers['x-openpms-token'];
  const token = Array.isArray(t) ? t[0] : t;
  if (!token) throw badRequest('VALIDATION_DENIED', '缺少 x-openpms-token 执行令牌');
  return token;
}

const statusEnum = z.enum(['pending', 'queued', 'running', 'done', 'failed', 'cancelled']);

export function registerToolRoutes(app: FastifyInstance, deps: AppDeps, tools: ToolService): void {
  app.post('/api/v1/agent-tools/task/list_my', async (req, reply) => {
    try {
      const body = z.object({ status: statusEnum.optional() }).parse(req.body ?? {});
      return ok(reply, tools.listMy(tokenOf(req), body.status as TaskStatus | undefined));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/agent-tools/task/update_status', async (req, reply) => {
    try {
      const body = z.object({ status: statusEnum, taskId: z.string().optional() }).parse(req.body ?? {});
      return ok(reply, tools.updateStatus(tokenOf(req), body.status as TaskStatus, body.taskId));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/agent-tools/task/submit_result', async (req, reply) => {
    try {
      const body = z
        .object({ result: z.string().min(1), taskId: z.string().optional() })
        .parse(req.body ?? {});
      return ok(reply, tools.submitResult(tokenOf(req), body.result, body.taskId));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/agent-tools/task/create_subtask', async (req, reply) => {
    try {
      const body = z
        .object({
          name: z.string().min(1),
          description: z.string().min(1),
          agentId: z.string().min(1),
          workspace: z.string().optional(),
          priority: z.enum(['low', 'medium', 'high']).optional(),
          dependencyIds: z.array(z.string().min(1)).optional(),
        })
        .parse(req.body ?? {});
      return ok(reply, tools.createSubtask(tokenOf(req), body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/agent-tools/task/reassign', async (req, reply) => {
    try {
      const body = z
        .object({ taskId: z.string().min(1), agentId: z.string().min(1) })
        .parse(req.body ?? {});
      return ok(reply, tools.reassign(tokenOf(req), body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 便于前端查看审计
  app.get<{ Querystring: { taskId?: string; limit?: string } }>(
    '/api/v1/tool-audits',
    async (req, reply) => {
      try {
        const rows = req.query?.taskId
          ? deps.db.all(
              'SELECT * FROM tool_audits WHERE task_id = ? ORDER BY created_at DESC LIMIT ?',
              req.query.taskId,
              Number(req.query.limit ?? 100),
            )
          : deps.db.all(
              'SELECT * FROM tool_audits ORDER BY created_at DESC LIMIT ?',
              Number(req.query?.limit ?? 100),
            );
        return ok(reply, rows);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
