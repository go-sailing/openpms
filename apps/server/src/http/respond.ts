/**
 * http/respond.ts — 统一响应封装与错误映射
 */
import type { FastifyReply } from 'fastify';
import { AppError } from '../platform/errors.js';

export function ok<T>(reply: FastifyReply, data: T): FastifyReply {
  return reply.send({ code: 0, message: 'ok', data });
}

export function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) {
    return reply
      .code(err.statusCode)
      .send({ code: err.code, message: err.message, details: err.details });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ code: 'INTERNAL', message });
}
