/**
 * execution/routes.ts — 执行记录与日志（F-T-03、F-T-04）
 */
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../http/deps.js';
import { fail, ok } from '../http/respond.js';
import { readExecutionLog } from './logs.js';

export function registerExecutionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { engine } = deps;

  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id/executions', async (req, reply) => {
    try {
      return ok(reply, engine.listExecutions(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/v1/executions', async (req, reply) => {
    try {
      return ok(reply, engine.recentExecutions(Number(req.query?.limit ?? 50)));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { eid: string } }>('/api/v1/executions/:eid', async (req, reply) => {
    try {
      const ex = engine.getExecution(req.params.eid);
      if (!ex) return reply.code(404).send({ code: 'NOT_FOUND', message: '执行记录不存在' });
      return ok(reply, ex);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { eid: string }; Querystring: { tail?: string } }>(
    '/api/v1/executions/:eid/logs',
    async (req, reply) => {
      try {
        const tail = req.query?.tail ? Number(req.query.tail) : 2000;
        const content = readExecutionLog(req.params.eid, { tail });
        return ok(reply, { executionId: req.params.eid, content });
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
