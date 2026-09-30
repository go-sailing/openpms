/**
 * platform/migrate.ts
 * 建表脚本（幂等）。表结构对应 SDD 第 7 章。
 */
import type { Db } from './db.js';
import { TOOL_CATALOG } from './types.js';

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
  harness         TEXT NOT NULL DEFAULT 'opencode',
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
  /**
   * 待接续的执行 id：重试决定做出时写入（指向被中断的那次执行），
   * 由执行引擎在下次启动时消费一次——引擎会**复用该执行记录**（同一 execution、同一日志文件）
   * 并在其会话上继续；为空表示新建执行记录（全新会话）。
   */
  resume_execution_id TEXT,
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
  // 老库的 agents 表没有 harness 列（CREATE TABLE IF NOT EXISTS 不会改已存在的表），
  // 需要显式补列；默认 opencode 与升级前行为一致。
  addColumnIfMissing(db, 'agents', 'harness', "harness TEXT NOT NULL DEFAULT 'opencode'");
  // 老库 tasks 表没有 resume_execution_id 列（重试时接续被中断的那次执行）
  addColumnIfMissing(db, 'tasks', 'resume_execution_id', 'resume_execution_id TEXT');
  dropRetiredToolGrants(db);
}

/** 幂等补列：列已存在时不做任何事 */
function addColumnIfMissing(db: Db, table: string, column: string, columnDdl: string): void {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
}

/**
 * 工具授权已通用化：只授权 OpenPMS 自己提供的工具。历史上授权过的 harness 原生工具
 * （fs.* / shell / webfetch / websearch）已不在目录中，这里清理掉这些残留行，
 * 避免智能体详情里出现「授权了但页面上选不到、且不再有任何效果」的幽灵授权。
 */
function dropRetiredToolGrants(db: Db): void {
  const names = TOOL_CATALOG.map((t) => t.name);
  const placeholders = names.map(() => '?').join(', ');
  db.run(`DELETE FROM agent_tools WHERE tool_name NOT IN (${placeholders})`, ...names);
}
