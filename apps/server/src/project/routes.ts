/**
 * project/routes.ts — 项目与项目成员接口（F-P-01、F-P-02）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../http/deps.js';
import { fail, ok } from '../http/respond.js';

const projectInput = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  defaultWorkspace: z.string().nullish(),
});

export function registerProjectRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { projects } = deps;

  app.get('/api/v1/projects', async (_req, reply) => {
    try {
      return ok(reply, projects.list());
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/projects', async (req, reply) => {
    try {
      return ok(reply, projects.create(projectInput.parse(req.body)));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (req, reply) => {
    try {
      return ok(reply, projects.getOrThrow(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/v1/projects/:id', async (req, reply) => {
    try {
      const body = projectInput
        .partial()
        .extend({
          status: z.enum(['active', 'archived']).optional(),
          autoScheduleEnabled: z.boolean().optional(),
        })
        .parse(req.body);
      return ok(reply, projects.update(req.params.id, body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/archive', async (req, reply) => {
    try {
      return ok(reply, projects.archive(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/projects/:id',
    async (req, reply) => {
      try {
        const q = req.query ?? {};
        return ok(
          reply,
          projects.remove(req.params.id, { confirm: q.confirm === 'true' || q.confirm === '1' }),
        );
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // ---- 项目成员 ----

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/members', async (req, reply) => {
    try {
      return ok(reply, projects.listMembers(req.params.id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/members', async (req, reply) => {
    try {
      const body = z.object({ agentIds: z.array(z.string()).min(1) }).parse(req.body);
      return ok(reply, projects.addMembers(req.params.id, body.agentIds));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { id: string; agentId: string }; Querystring: Record<string, string> }>(
    '/api/v1/projects/:id/members/:agentId',
    async (req, reply) => {
      try {
        const q = req.query ?? {};
        const strategy = q.strategy === 'reassign' ? 'reassign' : q.strategy === 'keep' ? 'keep' : undefined;
        return ok(
          reply,
          projects.removeMember(req.params.id, req.params.agentId, {
            confirm: q.confirm === 'true' || q.confirm === '1',
            strategy,
            reassignToAgentId: q.reassignToAgentId,
          }),
        );
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
