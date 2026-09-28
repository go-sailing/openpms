/**
 * http/server.ts — Fastify 服务装配（REST + WebSocket + 前端静态资源）
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppDeps } from './deps.js';
import { fail } from './respond.js';
import { wsHandler } from './ws.js';
import { AppError } from '../platform/errors.js';
import { registerAgentRoutes } from '../agent/routes.js';
import { registerProjectRoutes } from '../project/routes.js';
import { registerTaskRoutes } from '../task/routes.js';
import { registerExecutionRoutes } from '../execution/routes.js';
import { registerSystemRoutes } from '../system/routes.js';
import { registerToolRoutes } from '../tools/routes.js';
import type { ToolService } from '../tools/service.js';

export async function buildServer(
  deps: AppDeps,
  tools: ToolService,
  webDistDir?: string,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.OPENPMS_LOG_LEVEL ?? 'info' },
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // 容忍空 body 的 JSON 请求（如带 content-type 但无 body 的 DELETE），避免误报 400
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (!raw) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return fail(reply, err);
    const anyErr = err as unknown as { validation?: unknown; name?: string; message?: string; issues?: unknown };
    if (anyErr.validation) {
      return reply.code(400).send({ code: 'VALIDATION_DENIED', message: anyErr.message ?? '参数校验失败' });
    }
    // zod 校验错误
    if (anyErr.name === 'ZodError') {
      return reply.code(400).send({
        code: 'VALIDATION_DENIED',
        message: '参数校验失败',
        details: anyErr.issues,
      });
    }
    app.log.error(err);
    return reply.code(500).send({ code: 'INTERNAL', message: anyErr.message ?? '服务器内部错误' });
  });

  app.get('/ws', { websocket: true }, (connection) => {
    wsHandler(connection, undefined);
  });

  registerAgentRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerExecutionRoutes(app, deps);
  registerSystemRoutes(app, deps);
  registerToolRoutes(app, deps, tools);

  // 前端静态资源（存在构建产物时启用，SPA 回退到 index.html）
  const webRoot = webDistDir ?? resolve(process.cwd(), 'apps/web/dist');
  const hasWeb = existsSync(webRoot);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: `接口不存在: ${req.url}` });
    }
    if (hasWeb) return reply.sendFile('index.html');
    return reply
      .code(404)
      .send({ code: 'NOT_FOUND', message: '前端未构建：请先执行 npm run build:web' });
  });

  return app;
}
