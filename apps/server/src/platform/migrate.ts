/**
 * platform/migrate.ts
 * 建表脚本（幂等）。表结构对应 SDD 第 7 章。
 */
import type { Db } from './db.js';

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 智能体
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  role            TEXT,
  avatar          TEXT,
  system_prompt   TEXT NOT NULL,
  model_config    TEXT,
  status          TEXT NOT NULL DEFAULT 'enabled',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  timeout_sec     INTEGER,
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 智能体授权工具
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id  TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  config    TEXT,
  PRIMARY KEY (agent_id, tool_name)
);

-- 经验记忆
CREATE TABLE IF NOT EXISTS agent_memories (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  content        TEXT NOT NULL,
  source_task_id TEXT,
  status         TEXT NOT NULL DEFAULT 'confirmed',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memories(agent_id, created_at);

-- 项目
CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  default_workspace     TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  auto_schedule_enabled INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- 项目成员
CREATE TABLE IF NOT EXISTS project_members (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  role_in_project TEXT,
  joined_at       INTEGER NOT NULL,
  UNIQUE (project_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_member_agent ON project_members(agent_id);

-- 任务
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  parent_id           TEXT,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL,
  workspace           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  priority            TEXT NOT NULL DEFAULT 'medium',
  result              TEXT,
  trigger_mode        TEXT NOT NULL DEFAULT 'manual',
  scheduled_at        INTEGER,
  cron_expr           TEXT,
  next_run_at         INTEGER,
  not_before          INTEGER,
  retry_max           INTEGER NOT NULL DEFAULT 0,
  retry_interval      INTEGER NOT NULL DEFAULT 0,
  retry_backoff       TEXT NOT NULL DEFAULT 'fixed',
  retry_no            INTEGER NOT NULL DEFAULT 0,
  schedule_enabled    INTEGER NOT NULL DEFAULT 1,
  queued_at           INTEGER,
  enqueue_reason      TEXT,
  pending_fire        INTEGER NOT NULL DEFAULT 0,
  timeout_sec         INTEGER,
  locked_by           TEXT,
  locked_at           INTEGER,
  last_dispatch_error TEXT,
  last_dispatch_error_at INTEGER,
  created_by          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_queue ON tasks(status, priority, queued_at);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at);

-- 前置依赖
CREATE TABLE IF NOT EXISTS task_dependencies (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  UNIQUE (task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_dep_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_dep_depends ON task_dependencies(depends_on_task_id);

-- 执行记录
CREATE TABLE IF NOT EXISTS task_executions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  retry_no     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  session_id   TEXT,
  workspace    TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  error        TEXT,
  result       TEXT,
  log_path     TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_task ON task_executions(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_exec_running ON task_executions(status);

-- 状态迁移日志（审计）
CREATE TABLE IF NOT EXISTS task_status_logs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_logs_task ON task_status_logs(task_id, created_at);

-- 工具调用审计
CREATE TABLE IF NOT EXISTS tool_audits (
  id           TEXT PRIMARY KEY,
  execution_id TEXT,
  task_id      TEXT,
  agent_id     TEXT,
  tool_name    TEXT NOT NULL,
  input        TEXT,
  decision     TEXT NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
`;

export function migrate(db: Db): void {
  db.exec(DDL);
}
