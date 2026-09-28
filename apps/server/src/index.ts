/**
 * index.ts — OpenPMS 服务启动入口
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { config } from './platform/config.js';
import { Db } from './platform/db.js';
import { migrate } from './platform/migrate.js';
import { seed } from './platform/seed.js';
import { SettingsRepo } from './platform/settings.js';
import { AgentService } from './agent/service.js';
import { ProjectService } from './project/service.js';
import { TaskService } from './task/service.js';
import { ToolService } from './tools/service.js';
import { OpencodeRuntime, resolveOpencodeBin } from './runtime/opencode.js';
import { ExecutionEngine } from './execution/engine.js';
import { Scheduler } from './scheduler/index.js';
import { buildServer } from './http/server.js';
import type { AppDeps } from './http/deps.js';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerPath = resolve(here, '..', 'mcp', 'openpms-tools.mjs');
// 前端构建产物：apps/web/dist（相对服务目录解析，避免依赖进程 cwd）
const webDistDir = process.env.OPENPMS_WEB_DIST ?? resolve(here, '..', '..', 'web', 'dist');

async function main(): Promise<void> {
  mkdirSync(config.logDir, { recursive: true });

  const db = new Db(config.dbPath);
  migrate(db);
  seed(db);

  const settings = new SettingsRepo(db);
  const agents = new AgentService(db);
  const projects = new ProjectService(db);
  const tasks = new TaskService(db);
  const runtime = new OpencodeRuntime({ mcpServerPath });
  const engine = new ExecutionEngine(db, agents, projects, tasks, runtime);
  const scheduler = new Scheduler(db, tasks, projects, agents, settings, engine);
  const tools = new ToolService(db, agents, projects, tasks);

  const deps: AppDeps = { db, settings, agents, projects, tasks, engine, scheduler };

  const app = await buildServer(deps, tools, webDistDir);

  scheduler.start();

  await app.listen({ port: config.port, host: '127.0.0.1' });

  const bin = resolveOpencodeBin();
  app.log.info(
    {
      port: config.port,
      db: config.dbPath,
      opencode: bin,
      model: config.defaultModel,
      globalMaxConcurrency: config.globalMaxConcurrency,
      executionTimeoutSec: config.executionTimeoutSec,
      schedulerTickMs: config.schedulerTickMs,
      commandBlacklist: config.commandBlacklistEnabled,
    },
    'OpenPMS 已启动',
  );

  const shutdown = async (): Promise<void> => {
    app.log.info('正在关闭...');
    scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
