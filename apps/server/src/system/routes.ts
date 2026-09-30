/**
 * system/routes.ts — 系统级接口（调度开关、健康检查、运行信息）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../http/deps.js';
import { fail, ok } from '../http/respond.js';
import { config } from '../platform/config.js';
import { wsClientCount } from '../http/ws.js';
import { describeHarnesses } from '../runtime/index.js';

export function registerSystemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { scheduler } = deps;

  app.get('/api/v1/system/health', async (_req, reply) => {
    return ok(reply, {
      ok: true,
      version: '0.1.0',
      uptimeSec: Math.round(process.uptime()),
      wsClients: wsClientCount(),
      // 各 harness 底座的可用性（底座由每个智能体各自选择；模型清单见 GET /harnesses/:kind/models）
      harnesses: describeHarnesses(),
    });
  });

  app.get('/api/v1/system/scheduler', async (_req, reply) => {
    try {
      return ok(reply, scheduler.status());
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/v1/system/scheduler', async (req, reply) => {
    try {
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      scheduler.setEnabled(body.enabled);
      return ok(reply, scheduler.status());
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/system/scheduler/tick', async (_req, reply) => {
    try {
      await scheduler.tick();
      return ok(reply, scheduler.status());
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/v1/system/config', async (_req, reply) => {
    const { dbPath, logDir, ...rest } = config;
    return ok(reply, { ...rest, dbPath, logDir });
  });
}
