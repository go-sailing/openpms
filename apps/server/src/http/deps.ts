/**
 * http/deps.ts — 路由依赖容器
 */
import type { Db } from '../platform/db.js';
import type { SettingsRepo } from '../platform/settings.js';
import type { AgentService } from '../agent/service.js';
import type { ProjectService } from '../project/service.js';
import type { TaskService } from '../task/service.js';
import type { ExecutionEngine } from '../execution/engine.js';
import type { Scheduler } from '../scheduler/index.js';

export interface AppDeps {
  db: Db;
  settings: SettingsRepo;
  agents: AgentService;
  projects: ProjectService;
  tasks: TaskService;
  engine: ExecutionEngine;
  scheduler: Scheduler;
}
