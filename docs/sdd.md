# 智能体项目管理系统（OpenPMS）系统设计文档

| 项目 | 内容 |
| --- | --- |
| 产品名称 | OpenPMS（Open Agent-driven Project Management System） |
| 文档版本 | v1.3 |
| 文档状态 | 草稿 |
| 创建日期 | 2026-09-28 |
| 对应需求 | [docs/prd.md](./prd.md) v1.5 |

## 修订记录

| 版本 | 日期 | 修订人 | 修订内容 |
| --- | --- | --- | --- |
| v1.0 | 2026-09-28 | — | 初版，覆盖 PRD v1.2 全部功能的架构、模块、数据、接口与关键流程设计 |
| v1.1 | 2026-09-28 | — | 调整 4.2 上下文注入：经验记忆移至 System Prompt 之后；新增当前项目已完成历史任务注入，同步更新适配层接口 |
| v1.2 | 2026-09-28 | — | 配合 PRD v1.4 删除"待验收（review）"状态：执行成功直接进入 done，移除状态机迁移、approve/reject 接口与时序中的验收环节 |
| v1.3 | 2026-09-28 | — | 落实第 15 章四项决策：opencode 采用最新稳定版；M1 引入执行超时与命令黑名单默认值；记忆默认自动沉淀；周期任务 Running 期间错过的周期在上次执行结束后立即补执行一次（新增 pending_fire） |
| v1.4 | 2026-09-28 | — | 新增"可重试错误的兜底重试"（配合 PRD v1.6）：适配层解析 opencode 错误的 `isRetryable`，任务未配置重试策略时按 `transientRetryMax/transientRetryIntervalSec` 兜底重试，同步更新 5.6、10.2、第 13 章与第 15 章 |
| v1.5 | 2026-09-29 | — | 新增可插拔运行时：接入 DeepSeek Harness（dsh）作为第二个 `AgentRuntime` 实现；新增 4.1.1、补充 4.1 失败分类与可重试判定、4.3 运行时安全差异、第 13 章配置项与第 15 章决策记录 |
| v1.6 | 2026-09-29 | — | 取消全局运行时档位（`config.runtime` / `OPENPMS_RUNTIME`）：**harness 底座改为按智能体选择**（`agents.harness`，智能体编辑页可选）；组合根改为「按底座取运行时」的注册表，同一个服务内不同智能体可各走各的底座；health 改为返回各底座可用性 |
| v1.7 | 2026-09-29 | — | **工具授权通用化**：`TOOL_CATALOG` 只保留 OpenPMS 自己提供的 5 个任务管理工具，删除 harness 原生工具（`fs.*` / `shell` / `webfetch` / `websearch`）的授权项；opencode 侧**不再下发 `permission`**（按智能体裁剪文件/命令工具一并移除）；**命令黑名单功能整体删除**（规则集、`commandBlacklist*` / `commandWhitelist` 配置、两个 `/system/command-*` 接口）；迁移时清理历史遗留的工具授权行；4.3、第 7 章、第 13 章与第 15 章同步（决策 #9） |
| v1.8 | 2026-09-29 | — | **删除底座默认模型配置**（`config.defaultModel` / `config.dshModel` / `OPENPMS_DSH_MODEL`）：模型一律由智能体指定，未指定时不传、交给底座自身默认；新增「按底座列可用模型」能力（`GET /harnesses/:kind/models`，opencode 走 `opencode models`、dsh 用内置目录），智能体编辑页的模型字段改为可选下拉 |
| v1.9 | 2026-09-29 | — | **重试一律改为「接续执行」**：新增 `tasks.resume_execution_id`（各重试决策点写入目标执行 id，引擎启动时消费一次）；引擎**复用该执行记录**（状态置回 `running`、沿用 `session_id` 与日志文件）而非新建，`StartSessionOptions` 增加 `resumeSessionId`（opencode 追加 `--session`、dsh 追加 `--session-id`）；覆盖执行内自动重试、重启补偿重试、用户重试/重新执行全部路径，接续时注入「继续上一次被中断的执行」指令；会话 id 在事件流首事件后即落库，保证强杀/重启后仍可接续；5.6、4.1、第 7 章与第 8 章同步 |
| v1.10 | 2026-09-30 | — | **接续运行不再重复注入上下文**：接续某一会话时只下发 System Prompt（底座每次请求按 agent 配置重新组装，不落会话历史），运行时上下文与用户指令**不再重复下发**（已随首次执行进入会话历史），仅下发一句极简的「继续执行未完成的部分。」；4.2 与 5.6 同步 |

---

## 1. 文档目的与范围

本文档描述 OpenPMS 的技术实现方案，作为开发与评审依据，内容包括：

- 系统总体架构与技术选型；
- 智能体运行时（opencode / dsh 适配层）、OpenPMS 工具授权与工作目录校验设计；
- 任务自动调度器的触发、队列、并发、重试与故障恢复设计；
- 数据库结构、后端接口、关键流程时序；
- 安全、可靠性、可观测性与部署方案。

需求边界以 PRD 为准（多租户、多智能体自动编排、看板等不在本期范围）。

## 2. 设计目标与约束

### 2.1 设计目标

| 目标 | 设计要点 |
| --- | --- |
| 智能体可插拔 | opencode 调用全部收敛到适配层，运行时可替换/升级 |
| 调度可靠 | 队列持久化、派发互斥、重启补偿，做到不丢、不重 |
| 执行安全 | 任务工作目录执行前校验；OpenPMS 工具按智能体授权（服务端强制，与底座无关） |
| 单机易用 | 本地单进程 + SQLite 即可运行，零外部中间件依赖 |
| 过程可观测 | 执行日志与调度决策实时推送、全程可追溯 |

### 2.2 技术选型

| 层次 | 选型 | 理由 |
| --- | --- | --- |
| 后端 | Node.js + TypeScript（NestJS 或 Fastify） | 与 opencode 同语言生态，便于直接复用其 SDK/类型 |
| 前端 | React + TypeScript + Vite | 生态成熟，适合管理台与实时日志展示 |
| 数据库 | SQLite（better-sqlite3） | 单机本地部署、零运维；以写队列为主、并发量低，事务足够支撑调度锁 |
| ORM | Drizzle / Prisma | 迁移管理与类型安全 |
| 实时通道 | WebSocket | 推送执行日志、任务状态、队列变化 |
| 定时 | 进程内 Scheduler + 持久化 `next_run_at`（cron 解析用 cron-parser） | 不依赖外部 cron/消息队列，满足重启补偿 |
| 智能体运行时 | opencode **最新稳定版**（SDK / `opencode serve` 优先，headless CLI 兜底） | PRD 指定；已确认始终跟进最新稳定版，落地时在依赖清单锁定具体版本号，通过适配层隔离其 API 变化 |
| 进程模型 | 单进程内多模块；任务执行以子进程/会话方式运行 | 智能体崩溃不影响主服务 |

> 选型为建议方案，落地时若 opencode 版本能力变化，仅影响适配层与工具接入方式，不影响上层领域模型。

## 3. 系统总体架构

### 3.1 架构分层

```
┌──────────────────────────── 前端（Web 管理台） ───────────────────────────┐
│  智能体管理 │ 项目/成员管理 │ 任务管理 │ 调度队列视图 │ 执行日志(实时)        │
└───────────────┬───────────────────────────┬───────────────────────────────┘
            REST/HTTP                      WebSocket（日志/状态/队列事件）
┌───────────────▼───────────────────────────▼───────────────────────────────┐
│                            应用服务层（Backend）                            │
│ ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────────────────────┐ │
│ │ Agent    │ │ Project  │ │ Task         │ │ Scheduler                 │ │
│ │ Service  │ │ Service  │ │ Service      │ │ 触发器/队列扫描/并发控制   │ │
│ │ (含记忆) │ │ (含成员) │ │ (含状态机)   │ │ 重试/开关/暂停恢复         │ │
│ └────┬─────┘ └────┬─────┘ └──────┬───────┘ └─────────────┬─────────────┘ │
│      └────────────┴──────────────┼───────────────────────┘               │
│                                  ▼                                        │
│                        ┌──────────────────┐    ┌──────────────────────┐   │
│                        │ Execution Engine │───▶│ Task Tool Service    │   │
│                        │ (执行编排/日志)   │    │ (智能体任务管理工具)  │   │
│                        └────────┬─────────┘    └──────────────────────┘   │
└─────────────────────────────────┼─────────────────────────────────────────┘
                                   │ 仅通过适配接口
┌─────────────────────────────────▼─────────────────────────────────────────┐
│                      Agent Runtime Adapter（opencode）                     │
│  会话管理 │ Prompt/记忆注入 │ OpenPMS 工具（MCP）挂载 │ 事件流(思考/工具调用/输出)     │
└─────────────────────────────────┬─────────────────────────────────────────┘
                                   │ 子进程 / RPC
                            ┌──────▼──────┐
                            │  opencode   │  ── 模型供应商（LLM API）
                            │  runtime    │  ── 文件/Shell（由底座自身提供）
                            └─────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│  SQLite（agents/memories/projects/members/tasks/dependencies/executions） │
│  文件存储：执行日志文件、产出物（可选）                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 后端模块划分

| 模块 | 职责 | 对应需求 |
| --- | --- | --- |
| agent 模块 | 智能体 CRUD、启停、默认智能体种子数据、经验记忆管理 | F-A-01~03 |
| project 模块 | 项目 CRUD、归档、项目成员增删与校验 | F-P-01/02 |
| task 模块 | 任务 CRUD、指派校验、状态机、依赖与调度配置、查询 | F-T-01/02/04 |
| execution 模块 | 执行编排、opencode 会话、日志流、中止、产出回写 | F-T-03 |
| scheduler 模块 | 触发器、队列扫描、派发、并发槽位、重试、开关、恢复 | F-T-05 |
| tool 模块 | 向智能体暴露的"任务管理工具"及其权限控制与审计 | F-A-05 |
| runtime-adapter | 封装 opencode，隔离版本差异 | 非功能-兼容性 |
| sandbox | 工作目录校验与文件/命令越权防护 | F-A-04、非功能-安全 |
| event/notify | WebSocket 事件总线、异常通知 | 可观测性 |

## 4. 智能体运行时设计

### 4.1 opencode 适配层

定义统一接口，上层不直接依赖 opencode 具体 API：

```ts
interface AgentRuntime {
  // 创建一次任务执行会话
  startSession(opts: {
    agent: AgentConfig;          // systemPrompt、modelConfig、授权工具集
    workspace: string;           // 已校验的绝对工作目录（沙箱根）
    input: {
      taskName: string;
      taskDescription: string;
      memories: MemoryItem[];    // 仅该智能体的记忆
      projectContext?: string;
      completedTasks?: CompletedTaskSummary[]; // 当前项目已完成的历史任务，见 4.2
    };
    executionId: string;
    taskId: string;
    resumeSessionId?: string | null; // 在既有会话上接续（重试被中断的任务，见 5.6）
    signal: AbortSignal;         // 用户中止
  }): Promise<SessionHandle>;
}

interface SessionHandle {
  events: AsyncIterable<AgentEvent>; // thought | tool_call | tool_result | output | finish | error
  wait(): Promise<ExecutionResult>;  // 最终状态与产出摘要（含 sessionId）
  abort(): Promise<void>;
}
```

- **实现策略**：优先用 opencode SDK / 本地 server 模式（便于订阅结构化事件流），不可用时降级为 headless CLI（`opencode run`）并解析输出；两种实现实现同一接口。本接口另有第二个实现（DeepSeek Harness，见 4.1.1），二者由**智能体的 harness 配置**选择（见 4.1.1）。
- **工具下发**：OpenPMS 提供的任务管理工具以 MCP server 形式注册（opencode 走其 `mcp` 配置段，dsh 走 `@deepseek-ai/dsh-mcp-client` 行），**仅在智能体被授权时挂载**；harness 原生工具（文件/命令/网络）不参与授权，由各底座默认提供。授权由服务端强制（见 4.3）。
- **进程隔离**：每个执行会话在独立子进程中运行，主服务通过 RPC/事件与之通信；子进程异常退出被捕获为执行失败，不影响服务存活。
- **超时与中止**：会话支持执行超时配置与 `AbortSignal`；**M1 即启用默认执行超时 1800 秒（30 分钟）**，支持全局配置与按任务覆盖；超时按执行失败处理（走重试策略）。用户中止时终止子进程并将任务置为"已取消"或保留原状态（按入口区分）。
- **失败分类与可重试标记**：适配层把子进程退出与上游错误统一归一化为 `ExecutionResult{status, error, retryable}`。opencode 解析其错误对象（`{name, data:{message, isRetryable, metadata}}`），把 `data.isRetryable = true` 的瞬时错误标记为 `retryable=true`；dsh 优先用结构化错误字段（`turn_end.reason.error.code` / `status`：429 与 5xx 可重试、4xx 不可重试），拿不到时回退错误文本分类（`ECONNRESET`/`upstream`/`rate limit`/`timed out` 等可重试；`MISSING_CREDENTIAL`/`AUTH`/`unknown model`/`ENOENT` 等结构性错误不可重试），无法归类一律不可重试。两者都交给执行引擎按 5.6 的重试策略决定是否重试。

### 4.1.1 DeepSeek Harness（dsh）适配

第二个运行时实现，与 opencode 并存、实现同一套 `AgentRuntime` 接口。**底座（harness）由每个智能体各自选择**（`agents.harness`，智能体编辑页可切换，默认 `opencode`）；组合根 `runtime/index.ts` 提供「按底座取运行时」的注册表（`createRuntimes()` → `RuntimeRegistry.get(kind)`），执行引擎按被指派智能体的 `harness` 取值取得实现，因此同一个服务内不同智能体可各走各的底座，执行引擎与依赖容器无需感知具体实现。

- **集成方式**：`dsh --profile headless --json`（NDJSON 事件流，一次性任务）；接续被中断的任务时在 app 参数区追加 `--session-id <id>`（见 5.6）。dsh 以**外部 CLI** 提供（配置 `dshBin` / `DSH_BIN`，支持 `npx -y @deepseek-ai/dsh` 这类含参数的形态），**不进入 npm 依赖**——它带 koffi/node-pty/libreoffice-kit-wasm 等原生依赖，纳入依赖会破坏本项目「零原生编译依赖」的约束。
- **System Prompt 与模型注入**：每次执行在 `DATA_DIR/dsh/patches/<executionId>.yml` 生成一份 `--patch` 覆盖层，覆盖 `system-prompt` 行（`personaPrefix` 放我们的 System Prompt、`personaSuffix` 保留 dsh 的工作目录提示、`includeHarnessIdentity`/`includeRuntimeContext` 显式置 true）；**只有在智能体指定了模型时**才覆盖 `agent-default-model` 行（`provider: deepseek-official` + `model`），未指定则不打该行，由 dsh 自身默认模型决定。**dsh 的 patch 语义是替换目标行的完整 config 而非深合并**，故每行必须写全需要保留的键；`toolOrder` 无默认值、写错会导致加载失败，故不写。任务文本走 **stdin**（dsh 在省略位置参数时读 stdin），避免超长参数与引号转义问题。patch 文件内容不含任何密钥（敏感值写成 `!!js process.env.*` 引用，真值由 spawn 环境注入），因此可整份写入执行日志，并在执行结束后删除。
- **状态目录与凭据**：**默认不覆盖 `DSH_HOME`**，让 dsh 使用其自身默认目录（`~/.dsh`）——因为 dsh 的凭据存储为 `$DSH_HOME/.credentials.yaml`，用户在 dsh 侧通过 `dsh auth` 或 Web Models 页面写入的 API Key 就存放在这里；若把 `DSH_HOME` 重定向到一个新目录，dsh 会因找不到凭据而报 `MISSING_CREDENTIAL`（这是曾经的实际故障）。需要与用户既有 dsh 环境隔离时（CI、或希望会话独立存放）可显式配置 `OPENPMS_DSH_HOME`，此时才下发 `DSH_HOME`。
- **凭据来源（两条都可用）**：① 复用 dsh 自身凭据：在 dsh 侧配置一次（`dsh auth login` 或 Web Models 页面），OpenPMS 默认即可读到；② 启动环境变量：在启动 OpenPMS 的进程环境中 `export DEEPSEEK_API_KEY=...`，会随 spawn 环境透传给 dsh（实测 dsh 的 `llm-deepseek-api-key` 会读取它）。OpenPMS **不持久化**供应商密钥，也不写入 patch 文件。
- **事件映射**：`session`→捕获会话标识；`status.phase`（`turn_start`/`step_start`/`step_end`/`turn_end`）→ `step_start`/`step_finish`，其中 `turn_end.reason` 用于失败判定与错误分类；`text`→`output`；`thinking`→`thought`；`tool_call`/`tool_result`→同名事件（工具名形如 `mcp__openpms__task_*`）；`final`→产出权威来源。成功判定以退出码为主（`turn_end` 为 completed 才返回 0）。
- **已知限制**：① `text`/`thinking` 是**步骤提交时**才发出、**非逐 token 流式**，实时性弱于 opencode；② dsh 仍是 developer preview，CLI 与 patch 行结构可能发生破坏性变更，升级前需重跑 `--dump-config` 冒烟。（工具授权与命令约束不再由运行时承担，见 4.3，两个底座一致。）

### 4.2 Prompt、经验记忆与上下文注入

会话启动时按以下**顺序**组装输入，经验记忆紧跟 System Prompt 之后，保证角色人设先立、再带入个体经验，最后提供项目与任务的事实性上下文：

```
[System Prompt(智能体配置)]
+ 角色与行为边界、输出规范
[经验记忆] 该智能体的跨项目经验（按相关性/时间选取，设 token 预算上限）
[运行时上下文]
- 项目：名称、描述
- 项目已完成历史任务：当前项目 status=done 的任务记录摘要（见下）
- 当前任务：名称、描述、交付要求、工作目录
- 可用的 OpenPMS 工具：仅授权清单（底座原生能力始终可用，不受此清单约束）
[用户指令] 任务描述
```

**接续运行时的注入差异**：任务被中断后重试/续跑（接续既有会话）时，**只下发 System Prompt**——底座每次请求都按 agent 配置重新组装它，不落在会话历史里，所以照常下发不会造成重复，还能保证接续轮仍有智能体人设与工具说明；上面的运行时上下文与用户指令则**不再重复下发**（它们已随首次执行进入会话历史，重复注入只会让同一份内容在会话里出现两次），改为只发一句极简的「继续执行未完成的部分。」，让被中断的执行接着往下跑（见 5.6）。

**（1）经验记忆**

- 位置固定在 System Prompt 之后；读取仅限当前 `agent_id`，从数据访问层保证隔离；
- 设置条数/token 上限（默认 20 条 / 2k token，见第 13 章配置），超出时按最近使用与来源任务相关度裁剪；
- **沉淀模式：默认自动沉淀（已确认）**——执行结束后智能体产出的"候选记忆"由执行引擎直接写入 `agent_memories`（status=confirmed，source_task_id 关联本次任务），无需用户确认；用户仍可在记忆管理中事后查看、编辑、删除。单任务沉淀条数设上限，避免一次执行灌爆记忆。

**（2）项目已完成历史任务**

执行引擎在拉起会话前查询**当前项目下 `status=done`** 的任务，组装为摘要列表随上下文注入，让智能体了解项目已完成的工作与结论，避免重复劳动并保持产出连贯：

```ts
interface CompletedTaskSummary {
  taskId: string;
  name: string;
  description: string;
  assigneeAgentId: string;   // 可能由项目内其他成员智能体完成
  result: string | null;     // tasks.result 产出摘要/结论
  completedAt: number;       // 进入 done 的时间
}
```

- **范围**：仅当前项目、仅"已完成（Done）"；不含失败、已取消、进行中/排队中的任务，避免把未验证结论当作事实；
- **来源不限智能体**：包含项目内各成员（含其他智能体）完成的任务——它是项目级共享上下文，区别于按智能体隔离的经验记忆；
- **排序与裁剪**：默认按 `completedAt` 倒序取最近 20 条 / 2k token（见第 13 章配置）；超预算时优先保留与当前任务名称/描述相关度高的条目，其余截断；
- **数据来源**：`tasks`（status/result/updated_at）关联 `task_status_logs`（最近一次进入 done 的时间作为 completedAt）；大字段只取摘要，不注入执行日志全文；
- **权限前提**：能执行该项目任务的智能体必为项目成员（F-P-02），历史任务对项目成员可见，不构成越权。

### 4.3 工具授权与工作目录沙箱

**工具授权是通用的，且只覆盖 OpenPMS 自己提供的工具。**

| 机制 | 说明 |
| --- | --- |
| 授权范围 | 仅 OpenPMS 提供的 5 个任务管理工具（`task.list_my` / `task.update_status` / `task.submit_result` / `task.create_subtask` / `task.reassign`）。harness 自身提供的工具（读写文件、命令、网络）**不参与授权**，由各底座按其默认行为提供 |
| 授权生效方式 | 会话启动时未授权的 OpenPMS 工具不注册（opencode 不挂载 MCP server / dsh 不打 MCP 行）；即便被调用，服务端仍以「执行令牌 → 项目成员 → 工具授权」三重校验拒绝并审计 |
| 通用性 | 该层完全在服务端强制，与 harness 底座无关：同一份授权换底座时语义一致 |
| 工作目录校验 | 执行前由 `validateWorkspace` 校验任务工作目录（存在、是目录、位于允许根目录之下），**始终生效** |
| 目录内约束 | 通过 System Prompt 约束智能体把文件/命令操作限制在 `workspace` 内（模型自律，非强制拦截） |
| 审计 | 每次 OpenPMS 工具调用记录（`tool_audits`）：执行 id、智能体、工具名、入参摘要、决策、原因、时间 |

> **已移除的 harness 侧裁剪与命令黑名单**：历史上 OpenPMS 曾通过 opencode 的 `permission` 下发「按智能体裁剪文件/命令类工具」与「命令黑名单」；由于该机制只对 opencode 生效、在 dsh 下完全失效（非通用的假保证），已在工具授权通用化时**整体移除** —— opencode 侧不再下发任何 `permission`，命令黑名单的规则集、配置项（`commandBlacklist*` / `commandWhitelist`）与 `/system/command-check`、`/system/command-blacklist` 接口也一并删除。
>
> 因此执行隔离只剩两层：① 执行前的工作目录校验；② System Prompt 约束（模型自律）。需要硬隔离时应在 OpenPMS 之外解决（容器、受限用户、网络策略）。

**默认安全策略（均可通过配置覆盖）**：

| 策略 | 默认值 |
| --- | --- |
| 单任务执行超时 | 1800 秒（30 分钟），超时按失败处理 |
| 允许的工作区根目录 | 用户显式配置；未配置时仅校验工作目录存在且是目录 |

## 5. 任务自动调度器设计

调度器是系统内的常驻服务，与 Web 服务同进程、单实例运行（单机部署）。核心原则：**队列就是数据库，状态即真相；任何时刻一个任务至多一个执行。**

### 5.1 组成

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Trigger 定时器│   │ Dependency   │   │ 用户/智能体   │
│ (cron/once)  │   │ Watcher      │   │ 动作(自动派发)│
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ enqueue          │ 前置完成事件      │ enqueue
       ▼                  ▼                  ▼
              ┌──────────────────────┐
              │   tasks(status=queued)│  ← 持久化队列
              │  ORDER BY priority,  │
              │          queued_at    │
              └──────────┬───────────┘
                         │ 周期性 tick（如每 2s）
                         ▼
              ┌──────────────────────┐
              │ Dispatcher 派发器     │
              │ - 调度开关判断        │
              │ - 成员/启用/目录校验  │
              │ - 并发槽位判断        │
              │ - 行级占用(CAS 加锁)  │
              └──────────┬───────────┘
                         ▼
                 Execution Engine（见第 4 章）
```

### 5.2 触发器

| 触发方式 | 入库时机 | 实现 |
| --- | --- | --- |
| 自动派发 auto | 创建任务事务内直接置 `queued`、写 `queued_at/enqueue_reason=auto` | 同步入队 |
| 定时 scheduled（单次） | 后台扫描 `next_run_at <= now()` 的任务 | 触发后清空 `next_run_at` |
| 定时 cron（周期） | 扫描 `next_run_at <= now()` 的任务；正常派发占用时推进 `next_run_at`；**上一次执行仍在 Running 时不并发，置 `pending_fire=1` 并照常推进 `next_run_at`**（见 5.6） | cron-parser |
| 依赖 dependency | 任务状态变更为 Done/Failed/Cancelled 时检查后继任务 | 见 5.5 |
| 手动 manual | 不入队，用户点击直接调用执行引擎 | 立即执行 |

- 扫描采用"**定时触发 + 启动补偿**"：服务启动时先扫描一次所有到期任务，再进入周期扫描，保证重启不遗漏；
- `schedule_enabled=false`（用户暂停）的任务跳过触发；系统级或项目级开关关闭时只影响派发，不影响入队；
- 周期任务在两次执行之间以 `queued` + 未来 `next_run_at` 形态驻留队列，派发器只取"已到期或带补执行标记"的任务，因此不会提前执行。

### 5.3 派发与并发控制

派发器每个 tick：

1. 查询全局开关与项目开关开启的、`status=queued` 任务，满足派发时机条件（非周期任务直接可取；周期任务要求 `next_run_at <= now()` 或 `pending_fire=1`），按 `priority(高>中>低), queued_at ASC` 排序；
2. 逐条做**前置校验**：
   - 被指派智能体仍是该项目成员（`project_members` 存在）；
   - 智能体 `status=enabled`；
   - `workspace` 路径存在且可访问；
   - 任务 `schedule_enabled=true`；
3. 校验失败：不派发，写 `last_dispatch_error` 与时间，保留 `queued`（必要时发通知）；连续失败不做忙等刷屏（设最小重试间隔/退避）；
4. 校验通过且有空闲槽位：尝试占用（见 5.4）；
5. 占用成功 → 创建 `task_executions(trigger_type=scheduler, retry_no)` → 调执行引擎；任务置 `running`。

**并发槽位**：统计某智能体当前 `running` 执行数 `< agents.max_concurrency`（默认 1），且全局运行数 `< 全局上限`。槽位判断与占用必须在同一事务内完成，避免超发。

### 5.4 派发互斥（防重复执行）

使用 SQLite 事务 + 条件更新（CAS）实现行级占用，不依赖内存锁：

```sql
UPDATE tasks
SET status = 'running',
    locked_by = :node,
    locked_at = :now,
    updated_at = :now
WHERE id = :taskId
  AND status = 'queued'      -- 关键：仅排队中可被占用
  AND NOT EXISTS (SELECT 1 FROM task_executions
                  WHERE task_id = :taskId AND status = 'running');
```

- `changes === 1` 才算抢占成功，否则跳过；
- **占用成功的同一事务内处理周期时钟**：
  - 若 `pending_fire=1`（本次派发是补执行）：清除 `pending_fire=0`，**不**再推进 `next_run_at`（错过周期时已推进过）；
  - 否则若为正常到期派发：按 cron 计算并写入下一周期 `next_run_at`；
- `locked_by/locked_at` 用于崩溃恢复：启动时把"残留 running 且锁过期"的执行标记为中断，再按策略决定重入队或置失败；
- 单实例部署 + 数据库写锁即可保证"一个任务同一时刻至多一个执行"。

### 5.5 依赖触发与循环检测

- **创建时校验**：新增 `task_dependencies` 前在事务内做 DFS 环检测，存在环直接拒绝（对应 F-T-05 验收 3）；依赖任务必须与当前任务同项目。
- **完成时传播**：某任务进入终态时：
  - 前置全部 `done` → 后继任务入队（`enqueue_reason=dependency`）；
  - 任一前置 `failed/cancelled` → 后继不触发，标记阻塞原因；其后置任务级联不触发。
- 入队是幂等操作：`status` 已不是可入队态（如 queued/running/done）则忽略。

### 5.6 失败重试与周期任务收尾

- 执行失败回调中读取 `retry_max/retry_interval/backoff`：
  - 已重试次数 < 上限 → 计算下次可派发时间 `not_before = now + interval`（指数退避则 `interval * 2^retry_no`），任务回到 `queued`，`retry_no+1`；
  - 达到上限 → 置 `failed`，写错误信息；
- **可重试错误的兜底重试**：适配层解析 opencode 错误对象，若 `data.isRetryable = true`（网络不可达、上游 5xx、限流等瞬时故障），则在 `ExecutionResult.retryable` 上标记并透传给执行引擎；生效的重试预算与间隔按下表判定：

| 任务重试配置 | 本次失败标记为可重试 | 生效预算 / 间隔 |
| --- | --- | --- |
| `retry_max > 0` | 任意 | 任务配置的 `retry_max` / `retry_interval`（指数退避则 `interval * 2^retry_no`） |
| `retry_max = 0` | 是 | 系统兜底 `transientRetryMax`（默认 2 次）/ `transientRetryIntervalSec`（默认 30 秒） |
| `retry_max = 0` | 否 | 不重试，直接置 `failed` |

- 采用兜底重试时，状态日志中标注原因与进度，如 `执行失败（可重试错误），自动重试（第 1/2 次）`；
- **用户手动「重试」= 接续被中断的那次执行**：`POST /tasks/{id}/retry` 会把该任务**最近一次建立了会话的执行 id** 写入 `tasks.resume_execution_id`；执行引擎启动下一次执行时消费该字段（一次性）并据此：
  1. **复用该执行记录**——不新建 `task_executions` 行，而是把原行状态置回 `running` 并清空 `finished_at/error/result`（`started_at`、`log_path`、`session_id` 保持不变），因此执行历史里始终是「同一次执行」，日志也**追加在同一份日志文件**后面（写入一条「接续执行：复用执行记录 …」的分隔说明）；`execution.started` 事件带 `resumed` 标记；
  2. **在该执行的会话上继续**——透传 `resumeSessionId`，opencode 追加 `--session <id>`，dsh 追加 `--session-id <id>`（adopt 已持久化会话）；该次下发**只带 System Prompt**，不再重复注入运行时上下文与用户指令（见 4.2），用户消息仅一句「继续执行未完成的部分。」，避免模型从头重做。
  若上次失败时**没有产生会话**（如底座未启动成功、凭据缺失），`resume_execution_id` 为空，重试即新建执行记录、开全新会话；历史遗留的无效会话 id 会让底座直接报错（dsh：`session ... does not exist`，非可重试），再点一次重试即回到全新会话。
- **所有重试路径都接续**（重试＝继续同一次尝试，不是重新开始）——各重试决策点写入 `resume_execution_id`：
  - 执行内自动重试（`retry_max` / 可重试错误兜底）→ 结束回调登记**本次执行**的 id；
  - 服务重启中断后的补偿重试（`recoverInterrupted`）→ 登记**被中断执行**的 id；
  - 用户在界面上「重试」失败/已取消的任务、或对已取消任务点「开始执行」→ 登记最近一次可接续执行的 id；
  - **周期任务的新一轮触发不接续**（那是一次新的执行而非重试）；用户取消任务时会清空待接续意图，避免残留意图被后续周期误用。
- **会话 id 尽早落库**：执行过程中事件流一旦给出会话标识（opencode 首事件即带 `sessionID`、dsh 的 `session` 事件），引擎立刻写入 `task_executions.session_id`（每次执行只写一次），因此**进程被强杀/服务重启后依然能接续**，不必等到执行正常结束。
- 派发器对带 `not_before` 的任务到期才取；
- 周期任务单次失败不影响后续周期：本轮按重试策略处理。

**周期任务执行结束（成功或重试耗尽失败）后的收尾规则**（在结束回调的同一事务内）：

1. 若 `pending_fire=1`（执行期间有周期到达）：任务立即回到 `queued`（`queued_at=now`、`enqueue_reason=scheduled_missed`），保留 `pending_fire=1` 由派发器取走，实现"**上一次执行完后立即执行下一周期**"；
2. 若 `pending_fire=0`：任务回到 `queued` 等待已持久化的下一 `next_run_at`；
3. Running 期间连续错过多个周期，`pending_fire` 始终只记 1 次（布尔量，不堆积），即只补执行一次，随后节奏对齐最新周期时间表；
4. 任务被取消（cancelled）或终态失败后不再自动收尾入队，并清除 `pending_fire`；暂停调度（`schedule_enabled=false`）期间不置位、不补执行。

### 5.7 重启恢复策略（启动时执行一次）

| 场景 | 处理 |
| --- | --- |
| `queued` 任务（含 `pending_fire=1` 的待补执行任务） | 保留；带补执行标记或已到期的会被立即派发 |
| 重启前残留 `running`（执行子进程已不存在） | execution 置 `interrupted/failed`；任务按其重试策略重入队或置 `failed`；重入队时若 `pending_fire=1` 则保留标记，恢复后立即补执行一次；置终态 `failed/cancelled` 时清除标记 |
| 到期未触发的定时任务（停机期间错过） | 启动扫描 `next_run_at<=now`：单次任务立即补偿触发；cron 任务错过多个周期只执行一次，并把 `next_run_at` 推进到"当前时间之后的下一周期"，不批量补跑历史 |
| 其他状态（done/failed/cancelled/pending） | 原样恢复 |

## 6. 任务状态机实现

- 在 task 模块集中定义**合法迁移表**，所有状态变更（用户、智能体工具、调度器）都走同一服务方法 `transition(task, event, actor)`：

```ts
const ALLOWED: Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>> = {
  pending:   { start_manual: 'running', enqueue: 'queued', cancel: 'cancelled' },
  queued:    { dispatch: 'running', cancel: 'cancelled', requeue: 'queued' },
  running:   { finish: 'done', fail_retryable: 'queued', fail_final: 'failed',
               cancel: 'cancelled' },
  done:      {},
  failed:    { retry: 'queued' },
  cancelled: { reopen: 'pending' },
};
```

- 非法迁移抛领域异常并返回明确提示；每次迁移写 `task_status_logs`（谁、何时、从→到、原因），支撑审计与智能体留痕；
- 智能体经任务管理工具发起的迁移同样经过该校验，并额外做项目成员鉴权。

## 7. 数据库设计

SQLite，以下为核心表（省略部分通用列）。字符集 UTF-8，时间统一存 Unix 毫秒整数或 ISO8601 文本。

```sql
-- 智能体
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  role            TEXT,
  avatar          TEXT,
  system_prompt   TEXT NOT NULL,
  model_config    TEXT,                       -- JSON
  harness         TEXT NOT NULL DEFAULT 'opencode', -- opencode/dsh：该智能体使用的 harness 底座
  status          TEXT NOT NULL DEFAULT 'enabled', -- enabled/disabled
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER,                    -- 软删除
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 智能体授权工具
CREATE TABLE agent_tools (
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  tool_name TEXT NOT NULL,                    -- 仅 OpenPMS 工具：task.*
  config    TEXT,                             -- JSON，可选的工具级策略
  PRIMARY KEY (agent_id, tool_name)
);

-- 经验记忆
CREATE TABLE agent_memories (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  content        TEXT NOT NULL,
  source_task_id TEXT,
  status         TEXT NOT NULL DEFAULT 'confirmed', -- 自动沉淀模式下统一为 confirmed
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_memory_agent ON agent_memories(agent_id, created_at);

-- 项目
CREATE TABLE projects (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  description            TEXT,
  default_workspace      TEXT,
  status                 TEXT NOT NULL DEFAULT 'active', -- active/archived
  auto_schedule_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- 项目成员
CREATE TABLE project_members (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  role_in_project TEXT,
  joined_at       INTEGER NOT NULL,
  UNIQUE (project_id, agent_id)
);
CREATE INDEX idx_member_agent ON project_members(agent_id);

-- 任务
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  parent_id        TEXT REFERENCES tasks(id),
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  workspace        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  priority         TEXT NOT NULL DEFAULT 'medium', -- low/medium/high
  result           TEXT,
  -- 调度相关
  trigger_mode     TEXT NOT NULL DEFAULT 'manual', -- manual/auto/scheduled/dependency
  scheduled_at     INTEGER,
  cron_expr        TEXT,
  next_run_at      INTEGER,
  not_before       INTEGER,                        -- 重试/派发退避
  retry_max        INTEGER NOT NULL DEFAULT 0,
  retry_interval   INTEGER NOT NULL DEFAULT 0,     -- 秒
  retry_backoff    TEXT NOT NULL DEFAULT 'fixed',  -- fixed/exponential
  retry_no         INTEGER NOT NULL DEFAULT 0,
  schedule_enabled INTEGER NOT NULL DEFAULT 1,
  queued_at        INTEGER,
  enqueue_reason   TEXT,
  pending_fire     INTEGER NOT NULL DEFAULT 0, -- 周期任务 Running 期间错过的周期：1=上次执行结束后立即补执行一次
  resume_execution_id TEXT,                     -- 待接续的执行 id（重试时写入，执行启动时消费一次并复用该执行记录）
  locked_by        TEXT,
  locked_at        INTEGER,
  last_dispatch_error TEXT,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status_queue ON tasks(status, priority, queued_at);
CREATE INDEX idx_tasks_agent_status ON tasks(agent_id, status);
CREATE INDEX idx_tasks_project      ON tasks(project_id);
CREATE INDEX idx_tasks_next_run     ON tasks(next_run_at);

-- 前置依赖
CREATE TABLE task_dependencies (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  UNIQUE (task_id, depends_on_task_id)
);

-- 执行记录
CREATE TABLE task_executions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  trigger_type TEXT NOT NULL,                 -- manual/scheduler
  retry_no     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,                 -- running/succeeded/failed/cancelled/interrupted
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  error        TEXT,
  log_path     TEXT                           -- 大日志落文件，库存路径
);
CREATE INDEX idx_exec_task ON task_executions(task_id, started_at);
CREATE INDEX idx_exec_running ON task_executions(status);

-- 状态迁移日志（审计）
CREATE TABLE task_status_logs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_type  TEXT NOT NULL,                   -- user/agent/system/scheduler
  actor_id    TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
```

> 重试被中断的任务时**复用同一条执行记录**（状态置回 `running`，会话与日志沿用），见 5.6；每条记录承载「一次执行」的完整生命周期，可跨越多次重试。

**指派合法性**：在任务创建/改派的事务内校验

```sql
SELECT 1 FROM project_members
WHERE project_id = :projectId AND agent_id = :agentId;
```

并校验 `agents.status='enabled' AND deleted_at IS NULL`，不满足则回滚。成员为空的项目创建任务直接在服务层拒绝。

**日志存储**：实时日志量可能较大，结构化事件写文件（按 execution id 分片），库中仅存路径与状态；WebSocket 推送当前执行事件，历史执行从文件回放。

## 8. 接口设计

### 8.1 REST 主要端点（`/api/v1`）

| 模块 | 方法与路径 | 说明 |
| --- | --- | --- |
| 智能体 | `GET /agents`（列表） `POST /agents` `GET/PATCH/DELETE /agents/{id}` | 列表/增改/软删 |
| | `POST /agents/{id}/enable` `.../disable` | 启停 |
| | `GET/POST/PUT/DELETE /agents/{id}/memories` | 经验记忆维护 |
| | `GET /agents/{id}/tools` `PUT /agents/{id}/tools` | OpenPMS 工具授权 |
| | `GET /tools/catalog` | 可授权的 OpenPMS 工具目录 |
| | `GET /harnesses/{kind}/models` | 某底座当前可用的模型清单（`?refresh=1` 跳过缓存），供模型下拉使用 |
| 项目 | `GET /projects` `POST /projects` `GET/PATCH /projects/{id}` | 项目 CRUD |
| | `POST /projects/{id}/archive` | 归档 |
| 成员 | `GET /projects/{id}/members` `POST .../members` `DELETE .../members/{agentId}` | 成员列表/添加/移除（移除携带处理策略） |
| 任务 | `GET /tasks`（project/status/agent/keyword 过滤） | 查询/队列视图（`status=queued`） |
| | `POST /tasks` `GET/PATCH/DELETE /tasks/{id}` | 增改删；创建时服务端校验成员与调度配置 |
| | `POST /tasks/{id}/start` `.../cancel` | 手动操作（执行成功后任务直接完成，无验收接口） |
| | `POST /tasks/{id}/retry` `.../schedule/pause` `.../schedule/resume` | 重试（**在最近一次会话上接续**，见 5.6）与调度控制 |
| | `GET /tasks/{id}/executions` `.../executions/{eid}/logs` | 执行历史与日志 |
| 系统 | `GET /system/scheduler` `PUT /system/scheduler`（全局开关） | 调度总控 |

统一响应包：`{ code, message, data }`；错误码区分 `VALIDATION_DENIED / NOT_PROJECT_MEMBER / ILLEGAL_TRANSITION / WORKSPACE_INVALID / SCHEDULER_DISABLED` 等。

### 8.2 WebSocket 事件

`/ws` 按任务/项目订阅，服务端推送：

```
task.updated        任务字段或状态变化
task.log            执行日志增量（thought/tool_call/tool_result/output）
execution.started / finished / failed
queue.updated       队列内容/派发顺序变化
scheduler.diagnostic入队、派发、跳过原因、重试等调度决策
```

## 9. 智能体任务管理工具（tool 模块）

以 opencode 自定义工具（或 MCP server）形式向智能体注册，工具内部走与人类用户相同的应用服务与状态机，不做旁路写入：

| 工具 | 能力 | 约束 |
| --- | --- | --- |
| `task.list_my` | 查询指派给自己的任务 | 仅其作为成员的项目 |
| `task.update_status` | 更新任务状态（如执行完成→done） | 受状态机合法迁移约束 |
| `task.submit_result` | 回写产出摘要/结论 | 写入 `tasks.result` |
| `task.create_subtask` / `task.reassign` | 项目经理角色拆子任务、改派 | 指派人必须是同项目成员，且调用方需具备相应角色权限 |

每次调用鉴权三要素：调用智能体身份、是否项目成员、是否拥有该工具；调用记录进审计日志。

## 10. 关键流程时序

### 10.1 手动执行

```
用户 → API(start) → TaskService 校验(成员/启用/目录/状态迁移)
  → ExecutionEngine.start（加载本智能体记忆 + 项目已完成历史任务）
  → RuntimeAdapter.startSession(workspace, prompt, memories, completedTasks, tools)
  → opencode 子进程执行
      ├─ 事件流 → WebSocket 推送前端
      └─ 工具调用 → ToolService(鉴权+审计) → 可能回调 TaskService 改状态
  → 结束回调：成功 transition(finish→done, result) ｜ 失败走重试或 failed
```

### 10.2 自动派发与重试

```
建任务(trigger_mode=auto) ──事务内 enqueue──▶ queued
Scheduler.tick: 取队首 → 开关/成员/启用/目录校验 → 槽位判断
  → CAS 占用(running) → 创建 execution(scheduler) → Engine
       成功 → done
       失败 → 预算 = retry_max>0 ? retry_max : (retryable ? transientRetryMax : 0)
              retry_no<预算 ? (not_before, queued, retry_no+1) : failed
```

### 10.3 移除项目成员

```
DELETE member?strategy=reassign|keep
  - 查该成员项目下 pending/queued/running 任务
  - 有未完成任务 → 需二次确认
  - reassign：事务内批量改派给目标成员（须为启用成员）
  - keep：删除成员关系；其 queued 任务由调度器前置校验拦截(保留 queued + 原因)
  - running 任务：允许本次执行完成（成员关系生效于派发点），完成后不可再被派发
```

## 11. 安全设计

1. **身份与授权（轻量）**：单机本地工具，首期以本地用户/单用户为主，API 仅监听本地或带 token；预留用户表与角色字段。
2. **执行边界**：见 4.3，执行前工作目录校验 + OpenPMS 工具授权；建议将 `workspace` 限制在用户配置的允许根目录之下，防止把 `/`、家目录等设为工作目录。harness 原生工具不受 OpenPMS 管控，需要硬隔离时在 OpenPMS 之外解决（容器/受限用户）。
3. **注入隔离**：智能体仅获得本 id 记忆、本项目任务；工具调用全部服务端鉴权。
4. **审计**：工具调用、状态变更、调度决策、成员变更均落日志，含行为主体。
5. **凭据**：模型 API Key 由 opencode 自身配置管理，OpenPMS 不持久化供应商密钥。
6. **资源防护**：单任务执行超时、全局并发上限、日志文件大小上限与轮转，避免智能体异常耗尽资源。

## 12. 可靠性与可观测性

| 主题 | 方案 |
| --- | --- |
| 进程隔离 | opencode 子进程崩溃不影响主服务，统一转成执行失败 |
| 调度不丢 | 队列在库、启动补偿扫描、cron 推进持久化 |
| 调度不重 | CAS 占用 + `running` 执行唯一约束语义 |
| 事务一致性 | 入队/占用/状态迁移/依赖传播均在数据库事务内完成 |
| 日志 | 应用日志分级；执行事件结构化；调度决策通过 `scheduler.diagnostic` 可见 |
| 数据备份 | SQLite 单文件 + 日志目录，提供备份/恢复说明；重要目录建议配合 git（M3 快照） |
| 时间精度 | tick 间隔默认 2s，定时误差目标 < 1 分钟 |

## 13. 部署与目录结构建议

**部署**：本地单进程（后端同时托管前端静态资源与 WebSocket），启动时执行迁移与默认智能体种子数据；运行依赖声明 opencode 最新稳定版并在锁定文件中固定具体版本号。

**配置项与默认值**（配置文件声明，均可覆盖）：

| 配置项 | 默认值 |
| --- | --- |
| opencode 版本 | 最新稳定版（依赖锁定具体版本） |
| 全局最大并发执行数 | 4 |
| 智能体默认并发 `max_concurrency` | 1 |
| 调度 tick 间隔 | 2 秒 |
| 单任务执行超时 | 1800 秒（30 分钟） |
| 可重试错误的兜底重试 | 仅当任务未配置重试策略（`retry_max=0`）且失败被标记为可重试时生效：2 次 / 固定间隔 30 秒 |
| 允许的工作区根目录 | 用户显式配置（未配置时仅校验工作目录存在且是目录） |
| 记忆沉淀模式 | 自动沉淀；单任务最多沉淀 5 条 |
| 记忆注入上限 | 20 条 / 2k token |
| 项目已完成历史任务注入 | 最近 20 条 / 2k token |
| 执行日志单文件上限 | 10 MB，按执行分片轮转 |
| 智能体 harness 底座 | 按智能体设置（`agents.harness`，智能体编辑页可选）：`opencode`（默认）/ `dsh`；系统不再有全局档位 |
| opencode 可执行文件 | `opencode`（`OPENCODE_BIN`） |
| dsh 可执行文件 | `dsh`（`DSH_BIN`，支持 `npx -y @deepseek-ai/dsh` 形态） |
| dsh 状态目录 | **默认不设置** `DSH_HOME`（复用 dsh 自身默认的 `~/.dsh`，以便读到用户已配置的凭据）；需要隔离时用 `OPENPMS_DSH_HOME` 显式指定 |
| 模型 | **没有全局默认模型**：模型记录在 `agents.model_config`，由智能体各自指定；未指定时不传给底座，由底座自身默认决定 |
| 模型候选来源 | 由 `GET /harnesses/{kind}/models` 提供：opencode 走 `opencode models` 实时拉取；dsh 用内置目录（`deepseek-flash`、`deepseek-v4-pro`）。结果缓存 5 分钟，`?refresh=1` 可跳过 |

**建议目录**：

```
openpms/
├── apps/
│   ├── web/                 # React 前端
│   └── server/              # 后端服务
│       ├── src/
│       │   ├── agent/       # 智能体 + 记忆 + 工具授权
│       │   ├── project/     # 项目 + 成员
│       │   ├── task/        # 任务 + 状态机 + 依赖
│       │   ├── execution/   # 执行引擎 + 日志
│       │   ├── scheduler/   # 触发器/派发器/恢复/重试
│       │   ├── tools/       # 智能体任务管理工具
│       │   ├── runtime/     # 运行时适配层（common 共享件 + opencode + dsh + 组合入口 index.ts）
│       │   ├── sandbox/     # 路径/命令约束
│       │   └── platform/    # db、ws、config、迁移、种子
│       └── drizzle/         # 数据库迁移
├── data/                    # SQLite 与执行日志（运行期生成，不入库）
└── docs/                    # require / prd / sdd
```

## 14. 需求追溯

| PRD 编号 | 设计落点 |
| --- | --- |
| F-A-01 默认智能体 | platform 种子数据（agents + agent_tools 初始记录） |
| F-A-02 智能体 CRUD/启停 | agent 模块 + agents/agent_tools 表 |
| F-A-03 经验记忆 | agent_memories 表 + 运行时注入（4.2） |
| F-A-04 工具/沙箱 | OpenPMS 工具授权（服务端）+ sandbox 工作目录校验（4.3） |
| F-A-05 任务管理工具 | tools 模块（第 9 章） |
| F-P-01 项目管理 | project 模块 + projects 表 |
| F-P-02 项目成员 | project_members 表 + 指派/派发校验、移除流程（5.3/10.3） |
| F-T-01 任务字段/校验 | tasks 表 + TaskService 校验 |
| F-T-02 状态机 | 第 6 章迁移表 + task_status_logs |
| F-T-03 任务执行 | execution 模块 + runtime-adapter（第 4 章） |
| F-T-04 查询/队列视图 | `/tasks` 过滤 + WS `queue.updated` |
| F-T-05 自动调度 | scheduler 模块（第 5 章） |
| 非功能-安全/可靠/可观测 | 第 11、12 章 |

## 15. 关键决策记录（2026-09-28 已确认）

| # | 决策项 | 结论 | 落地位置 |
| --- | --- | --- | --- |
| 1 | opencode 版本 | 使用**最新稳定版**，跟进升级；适配层隔离 API 差异，依赖文件锁定具体版本 | 2.2、4.1、第 13 章 |
| 2 | 执行超时 / 命令黑名单 | **M1 即引入**并给出默认值：执行超时 1800s；内置命令黑名单（提权、电源、磁盘破坏、危险删除、fork bomb、`curl\|sh` 等），均可配置覆盖。**该黑名单已由 #9 整体移除** | 4.1、4.3、第 13 章 |
| 3 | 经验记忆沉淀模式 | **默认自动沉淀**：执行结束直接入库，无需用户确认，用户可事后编辑/删除；单任务沉淀条数封顶 | 4.2（1） |
| 4 | 周期任务与上一次执行重叠 | **不并发**；Running 期间到达的周期以 `pending_fire` 标记（错过多个周期只记一次），上一次执行结束后**立即补执行一次**，之后节奏对齐最新周期；持久化并支持重启恢复 | 5.2、5.4、5.6、5.7、tasks.pending_fire |
| 5 | 可重试错误的兜底重试 | 任务未配置重试策略（`retry_max=0`）时，被标记为可重试的瞬时错误（`isRetryable`：网络不可达、上游 5xx、限流等）仍按系统兜底策略重试 2 次 / 30 秒；不可重试的失败仍一次即终态，避免放大无意义重试 | 4.1、5.6、10.2、第 13 章 |
| 6 | 是否接入第二个运行时 | **接入 DeepSeek Harness（dsh）**，作为第二个 `AgentRuntime` 实现与 opencode 并存；dsh 以外部 CLI 提供、不进入 npm 依赖；采用 `--profile headless --json` 档位（选择粒度后被 #8 取代） | 4.1.1、4.3、第 13 章 |
| 7 | dsh 档位的工具授权落差 | **不强行做细粒度映射**：dsh 侧文件/命令类授权无法强制，M1 明确记录为限制（依赖工作目录校验 + 提示词约束降低风险），仅任务管理工具保持服务端强制；理由是在 `dsh-base` 的 tools 行取值域未验证前，硬造映射只会产出不生效的假保证（该结论已由 #9 推广到全部底座） | 4.1.1、4.3、README「已知限制」 |
| 8 | 运行时底座的**选择粒度** | **取消全局档位**（不再有 `config.runtime` / `OPENPMS_RUNTIME`），改为**按智能体选择**（`agents.harness`，编辑页可选，默认 opencode，老库自动补列沿用 opencode 行为）；组合根改为按底座的注册表，同一服务内不同智能体可各走各的底座。理由：角色差异（如编码类走 opencode、中文长文类走 dsh）比全局一刀切更贴合实际使用 | 4.1.1、4.3、第 7 章 agents、第 13 章 |
| 9 | 工具授权的**范围与通用性** | **只授权 OpenPMS 自己提供的工具**（5 个 `task.*`），删除 harness 原生工具（`fs.*` / `shell` / `webfetch` / `websearch`）的授权项，同时**移除 opencode 侧 `permission` 下发**，并把**命令黑名单功能整体删除**（规则集、`commandBlacklist*` / `commandWhitelist` 配置、`/system/command-check` 与 `/system/command-blacklist` 接口）。理由：该机制只在 opencode 生效、在 dsh 下完全失效，是「非通用的假保证」；留一个不再拦截的规则集只会造成误判，故一并删除。代价是执行隔离只剩「工作目录校验 + System Prompt 约束」，需要硬隔离应在 OpenPMS 之外解决（容器/受限用户） | 4.3、第 7 章 agent_tools、第 13 章、README「已知限制」 |
