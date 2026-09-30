/**
 * task/routes.ts — 任务接口（F-T-01~F-T-05）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../http/deps.js';
import { fail, ok } from '../http/respond.js';
import { badRequest } from '../platform/errors.js';
import { ALL_STATUSES } from './state.js';

const MAX_TIMESTAMP = 4102444800000; // 2100-01-01，防止超出 JS 安全整数范围
const taskInput = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  workspace: z.string().nullish(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  triggerMode: z.enum(['manual', 'auto', 'scheduled', 'dependency']).optional(),
  scheduledAt: z.number().int().safe().min(0).max(MAX_TIMESTAMP).nullish(),
  cronExpr: z.string().nullish(),
  retryMax: z.number().int().min(0).max(10).optional(),
  retryInterval: z.number().int().min(0).optional(),
  retryBackoff: z.enum(['fixed', 'exponential']).optional(),
  timeoutSec: z.number().int().min(1).nullish(),
  parentId: z.string().nullish(),
  dependencyIds: z.array(z.string()).optional(),
  createdBy: z.string().nullish(),
});

export function registerTaskRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { tasks, engine } = deps;

  app.get<{ Querystring: Record<string, string> }>('/api/v1/tasks', async (req, reply) => {
    try {
      const q = req.query ?? {};
      const status = q.status && ALL_STATUSES.includes(q.status as never) ? (q.status as never) : undefined;
      return ok(
        reply,
        tasks.list({
          projectId: q.projectId,
          agentId: q.agentId,
          keyword: q.keyword,
          status,
          limit: q.limit ? Number(q.limit) : undefined,
        }),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/v1/queue', async (_req, reply) => {
    try {
      return ok(reply, tasks.queue());
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/tasks', async (req, reply) => {
    try {
      return ok(reply, tasks.create(taskInput.parse(req.body)));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req, reply) => {
    try {
      return ok(reply, tasks.getOrThrow(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req, reply) => {
    try {
      const body = taskInput.partial().parse(req.body);
      return ok(reply, tasks.update(req.params.id, body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req, reply) => {
    try {
      tasks.remove(req.params.id);
      return ok(reply, { removed: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id/status-logs', async (req, reply) => {
    try {
      return ok(reply, tasks.statusLogs(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string }; Body: { actorId?: string } }>(
    '/api/v1/tasks/:id/start',
    async (req, reply) => {
      try {
        const execution = await engine.start({
          taskId: req.params.id,
          triggerType: 'manual',
          actorId: req.body?.actorId ?? null,
        });
        return ok(reply, execution);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/cancel', async (req, reply) => {
    try {
      await engine.cancel(req.params.id);
      return ok(reply, tasks.getOrThrow(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/retry', async (req, reply) => {
    try {
      const task = tasks.getRow(req.params.id);
      if (!task) throw badRequest('NOT_FOUND', '任务不存在');
      if (task.status !== 'failed' && task.status !== 'cancelled') {
        throw badRequest('VALIDATION_DENIED', '仅「失败」或「已取消」状态的任务可以重新入队');
      }
      // 接续上次执行：复用该任务最近一次建立了会话的执行记录（同一 execution、同一会话）；
      // 若那次执行没建立起会话（如底座未启动成功）则新建执行记录
      tasks.setResumeExecution(task.id, tasks.latestResumableExecution(task.id)?.executionId ?? null);
      tasks.transition(task.id, 'retry', 'user', null, '用户手动重新入队');
      tasks.resetRetryState(task.id);
      tasks.setScheduleEnabled(task.id, true);
      return ok(reply, tasks.getOrThrow(task.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/schedule/pause', async (req, reply) => {
    try {
      return ok(reply, tasks.setScheduleEnabled(req.params.id, false));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/schedule/resume', async (req, reply) => {
    try {
      return ok(reply, tasks.setScheduleEnabled(req.params.id, true));
    } catch (e) {
      return fail(reply, e);
    }
  });
}
