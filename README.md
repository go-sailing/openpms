# OpenPMS · 智能体项目管理系统

OpenPMS 是一个以「项目」为组织单元的多智能体协作与任务调度平台。你把任务指派给具备独立人设、经验记忆和工具权限的智能体，由**可插拔的智能体运行时**真实执行（读写文件、执行命令），系统统一负责队列、并发、失败重试与执行留痕。

支持的运行时（harness 底座）**由每个智能体各自选择**，新建智能体默认 `opencode`：

| 底座 | 说明 |
| --- | --- |
| `opencode`（默认） | [opencode](https://opencode.ai) CLI（`opencode run --format json`），逐 token 实时流式，文件/命令类工具授权由运行时强制拦截 |
| `dsh` | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI（`dsh --profile headless --json`），DeepSeek 官方开源框架；事件为步骤级（非逐 token），工具授权语义见「已知限制」 |

底座在**智能体编辑页**的「Harness 底座」下拉框中切换，可同一套系统里让不同角色的智能体各走各的底座（例如编码类用 opencode、中文长文类用 dsh）。

- 产品需求：[docs/prd.md](docs/prd.md)
- 系统设计：[docs/sdd.md](docs/sdd.md)

---

## 1. 核心能力

| 能力 | 说明 |
| --- | --- |
| 智能体管理 | 独立 System Prompt、模型（按底座拉取候选）、**harness 底座**、最大并发、执行超时、**OpenPMS 工具授权**、经验记忆（执行结束后自动沉淀，页面仅可查看/删除）；内置「项目经理 / 产品经理 / 开发工程师 / 测试工程师」四个模板 |
| 项目管理 | 多项目管理、默认工作目录、项目级调度开关、归档与级联删除；**只有项目成员列表中的智能体才能被指派或调度执行该项目任务** |
| 任务管理 | 任务 CRUD、父子任务拆解、前置依赖（创建时做同项目 / 非自身 / 环检测校验）、优先级、计划时间与 Cron 周期 |
| 自动调度 | 四种触发方式：手动 / 自动派发 / 定时（Cron 周期）/ 依赖触发；队列按「优先级 + 入队时间 FIFO」派发；全局与按智能体的并发槽位；条件更新（CAS）占用防止重复执行 |
| 失败重试 | 按任务配置的重试次数 / 间隔 / 退避策略（固定或指数）；未配置重试策略时，对上游标记为「可重试」的瞬时错误（网络不可达、上游 5xx、限流等）仍会兜底重试。**任何重试都在该次尝试已有的会话上接续运行**（opencode `--session` / dsh `--session-id`），而不是从头重做 |
| 执行与观测 | 每次执行独立子进程；事件流经 WebSocket 实时推送；NDJSON 日志落盘并按大小分片轮转；支持执行超时与用户中止；产出回写到任务 |
| 智能体工具 | 以 MCP（stdio）形式向智能体暴露任务管理工具：查询我的任务、更新状态、回写产出、创建子任务、改派；三重鉴权（执行令牌 → 项目成员 → 工具授权）+ 全量审计。**这是唯一一层「工具授权」，全部在服务端强制，与 harness 底座无关** |
| 沙箱 | 任务执行前校验工作目录（存在性 + 允许根路径白名单），并在 System Prompt 中约束智能体将文件/命令操作限制在工作目录内。**不做命令黑名单**：harness 原生工具（文件、命令、网络）由底座自身提供，OpenPMS 不裁剪、也不拦截（详见「已知限制」） |

### 任务状态机

```
待处理(Pending) ──手动启动──▶ 执行中(Running) ──完成──▶ 已完成(Done)
      │                          │  ▲
      │(自动/定时/依赖触发)        │  └──自动重试(失败且预算未耗尽)
      ▼                          │
排队中(Queued) ──调度器派发──▶ 执行中(Running)
                                 │
                                 └──失败(重试耗尽)──▶ 失败(Failed)
待处理/排队中/执行中 ──取消──▶ 已取消(Cancelled)
```

执行成功后直接进入「已完成」，不设人工验收环节；「已取消」的任务可重新执行。

---

## 2. 技术栈

| 层次 | 选型 |
| --- | --- |
| 语言 / 运行时 | TypeScript + Node.js（≥ 22.5，开发使用 24.x） |
| 后端 | Fastify 5 + `@fastify/websocket` + `@fastify/static` |
| 数据库 | Node 内置 `node:sqlite`（`DatabaseSync`，WAL 模式）——**无原生编译依赖** |
| 前端 | React 18 + Vite 5（无路由库，`useState` 切换页面） |
| 智能体运行时 | 可插拔 harness 底座：opencode（`opencode run --format json`）与 DeepSeek Harness `dsh`（`dsh --profile headless --json`），均为 NDJSON 事件流；**底座按智能体选择**，且两者都以外部 CLI 提供，不进入 npm 依赖 |
| 智能体工具协议 | MCP（stdio，NDJSON JSON-RPC 2.0） |
| 仓库结构 | npm workspaces monorepo |

---

## 3. 目录结构

```
openpms/
├── apps/
│   ├── server/                    # 后端服务
│   │   ├── mcp/openpms-tools.mjs  # 暴露给运行时的 MCP 工具服务（由任一运行时的子进程拉起）
│   │   ├── test-fixtures/         # 开发用假运行时桩（不进入打包产物）
│   │   └── src/
│   │       ├── agent/             # 智能体 + 经验记忆 + 工具授权
│   │       ├── project/           # 项目 + 项目成员
│   │       ├── task/              # 任务 + 状态机 + 依赖
│   │       ├── execution/         # 执行引擎 + 日志落盘
│   │       ├── scheduler/         # 触发器 / 派发 / 依赖传播 / 重建恢复
│   │       ├── runtime/           # 运行时适配层：common 共享件 + opencode + dsh + 组合入口 index.ts
│   │       ├── tools/             # 智能体任务管理工具（鉴权 + 审计）
│   │       ├── sandbox/           # 工作目录校验
│   │       ├── http/              # Fastify 实例、WebSocket、响应封装
│   │       └── platform/          # 配置、SQLite、迁移、事件总线、种子数据
│   ├── web/                       # 前端管理台（概览 / 智能体 / 项目 / 队列 / 执行日志）
│   └── desktop/                   # Electron 桌面客户端（内置后端）
│       ├── src/main.ts            # 主进程：拉起内置后端、主窗口、生命周期
│       └── scripts/stage.mjs      # 装配运行时资源（后端单文件 + MCP + 前端静态资源）
├── data/                          # 运行期生成：SQLite 库与执行日志（不入库）
└── docs/                          # prd.md、sdd.md
```

---

## 4. 快速开始

### 4.1 前置条件

```bash
node -v             # >= 22.5.0（推荐 24.x）
opencode --version  # 底座 opencode 必需：需已安装 opencode CLI，并完成模型鉴权
dsh --version       # 底座 dsh 时才需要（npm i -g @deepseek-ai/dsh，或用 npx）
```

> 智能体的模型调用由**该智能体所选底座**负责，鉴权在该底座侧配置；**模型在智能体编辑页选择**：
> - 底座 `opencode`：候选模型由 `opencode models` 实时拉取（含你自行配置的 provider）；
> - 底座 `dsh`：候选模型取自 dsh 的内置目录（`deepseek-flash`、`deepseek-v4-pro`），需要有效的 DeepSeek 凭据——在 dsh 侧配置一次即可（`dsh auth login` 或 dsh Web 界面的 Models 页面，写入 `~/.dsh/.credentials.yaml`），或在启动 OpenPMS 时 `export DEEPSEEK_API_KEY=...`；
> - 两者都**允许手动填写**下拉之外的模型，留空则由底座自身的默认模型决定。
>
> 只需安装你实际会用到的那一个底座；某个智能体选了未安装的底座时，它的任务执行会失败并在日志中给出原因。

### 4.2 安装、构建、启动

```bash
npm install     # 安装依赖（workspaces 一次装齐前后端）
npm run build   # 构建后端（tsc）+ 前端（vite）
npm start       # 启动服务：单进程同时托管 API、WebSocket 与前端静态资源
```

浏览器打开 <http://127.0.0.1:4517>。首次启动会自动建库、执行迁移并播种四个默认智能体。

### 4.3 开发模式

```bash
npm run dev      # 终端 A：后端 tsx watch（:4517）
npm run dev:web  # 终端 B：前端 vite（:5173，已代理 /api 与 /ws 到 4517）
```

> ⚠️ `tsx watch` 会在源码变更时重启进程，正在执行的智能体会话会被判定为「服务重启导致执行中断」。需要跑真实任务时请使用 `npm start`。

### 4.4 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 构建前后端（= `build:server` + `build:web`） |
| `npm start` | 以生产模式启动后端（需先 `npm run build`） |
| `npm run typecheck` | 前后端 TypeScript 类型检查 |
| `npm run dev` / `npm run dev:web` | 后端 / 前端开发模式 |

---

## 5. 桌面客户端（Electron）

除 Web 管理台外，仓库内置了一个 Electron 桌面客户端：**内置后端**，双击即用，无需事先启动服务、也无需目标机器安装 Node。

### 5.1 运行与打包

```bash
# 开发运行：自动构建后端/前端 + 装配运行时资源，然后打开窗口
npm run desktop

# 打包 Linux 安装包（AppImage + deb）
npm run desktop:dist
# 产物：
#   apps/desktop/release/OpenPMS-<version>-x86_64.AppImage
#   apps/desktop/release/OpenPMS-<version>-amd64.deb
#   apps/desktop/release/linux-unpacked/openpms     ← 免安装可执行文件
```

### 5.2 工作原理

1. 主进程用 **Electron 自带的 Node**（`ELECTRON_RUN_AS_NODE=1`）拉起打包进 `resources/` 的后端，因此不依赖系统 Node；
2. 自动挑选一个**空闲端口**并通过环境变量下发给后端（不会与已在运行的 `npm start` 冲突）；
3. 轮询 `/api/v1/system/health` 就绪后再打开主窗口加载该地址，外部链接交给系统浏览器；
4. 关闭窗口或退出应用时终止后端进程。

内置后端的运行时资源由 [scripts/stage.mjs](apps/desktop/scripts/stage.mjs) 装配：

| 产物 | 说明 |
| --- | --- |
| `dist/server/dist/index.mjs` | 后端经 esbuild 打包的自包含单文件（约 2.5 MB，仅 node 内置模块外部化） |
| `dist/server/mcp/` | 智能体工具 MCP 服务（需保持独立文件，由 opencode 子进程拉起） |
| `dist/web/` | 前端静态资源 |

应用数据（SQLite 库与执行日志）存放在系统用户数据目录，Linux 下为 `~/.config/OpenPMS/`。

### 5.3 注意事项

- 桌面客户端仍依赖**智能体所选底座**的 CLI：请确保已安装 opencode 及/或 dsh，并完成相应鉴权。主进程会把 `~/.opencode/bin`、`~/.dsh/bin`、`~/.npm-global/bin`、`~/.nvm/*/bin` 等常见位置补进 `PATH`（从桌面启动时不会继承 shell 的 PATH）；底座由各智能体自身配置（`agents.harness`）决定。
- 打包目标目前仅 Linux（AppImage / deb）；需要 Windows / macOS 时在 `apps/desktop/package.json` 的 `build` 字段补充对应 target。
- 未提供自定义图标，安装后使用 Electron 默认图标。
- `deb` 的 maintainer 目前是占位值 `OpenPMS <openpms@example.com>`，请按需在 `build.linux.maintainer` 中替换。
- 仓库根 `.npmrc` 只做两件事：Electron 二进制走 npmmirror 镜像；放行 Electron 的 postinstall（npm 11 的安装脚本白名单）。若你的网络可直连 GitHub，可删除该文件，并自行在 npm 配置里放行 `electron`。

---

## 6. 配置

**配置文件**（按优先级从高到低查找，均为可选）：

1. 环境变量 `OPENPMS_CONFIG` 指向的文件
2. 仓库根目录 `openpms.config.json`
3. `data/config.json`

**环境变量覆盖**：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OPENPMS_DATA_DIR` | 数据目录（SQLite 与日志） | `<仓库根>/data` |
| `OPENPMS_DB` | 数据库文件路径 | `<数据目录>/openpms.db` |
| `OPENPMS_PORT` | HTTP 端口 | `4517` |
| `OPENPMS_GLOBAL_CONCURRENCY` | 全局最大并发执行数 | `4` |
| `OPENPMS_OC_TIMEOUT` | 单任务执行超时（秒） | `1800` |
| `OPENPMS_AUTO_SCHEDULE` | 自动调度开关初始值 | `true` |
| `OPENPMS_WORKSPACE_ROOTS` | 允许作为工作目录的根路径白名单（`:` 分隔） | 空（仅校验存在性） |
| `OPENCODE_BIN` | 底座 `opencode` 的可执行文件路径 | `opencode`（从 PATH 查找） |
| `DSH_BIN` | 底座 `dsh` 的可执行文件或命令行（支持 `npx -y @deepseek-ai/dsh`） | `dsh` |
| `OPENPMS_DSH_HOME` | 可选：显式指定 dsh 的 `DSH_HOME`（状态/会话/凭据目录）。**不设置时不覆盖**，沿用 dsh 自身的 `~/.dsh` | 不设置（不覆盖） |
| `DEEPSEEK_API_KEY` | 底座 `dsh` 所需的 DeepSeek 凭据（由 dsh 读取） | 空 |

> 底座本身**没有全局开关**，也**没有全局默认模型**：底座记录在 `agents.harness`、模型记录在 `agents.model_config`，都在智能体编辑页设置。上面的 `OPENCODE_BIN` / `DSH_BIN` 只是定位各底座的 CLI。

其余可配置项（并发、重试、记忆注入上限、日志分片大小、可重试错误兜底重试等）见 `apps/server/src/platform/config.ts` 与 [docs/sdd.md](docs/sdd.md) 第 13 章。

### 运行期数据

| 路径 | 内容 |
| --- | --- |
| `data/openpms.db`（含 `-wal` / `-shm`） | 任务、执行、审计、记忆等业务数据 |
| `data/logs/<executionId>.log` | 单次执行的 NDJSON 日志，超过 10MB 自动分片为 `.partN` |

> `data/` 已在 `.gitignore` 中忽略，不会提交到仓库。

---

## 7. 接口概览

后端在 `/api/v1` 下提供 REST 接口，WebSocket 端点 `/ws`（推送任务状态、调度诊断与实时执行日志）。完整定义见 [docs/sdd.md](docs/sdd.md) 第 8 章。

| 分组 | 端点 |
| --- | --- |
| 智能体 | `GET/POST /agents`、`GET/PATCH/DELETE /agents/{id}`、`POST /agents/{id}/enable\|disable`、`GET /agents/{id}/memories`、`DELETE /memories/{memoryId}`、`GET/PUT /agents/{id}/tools`、`GET /tools/catalog`、`GET /harnesses/{kind}/models` |
| 项目 | `GET/POST /projects`、`GET/PATCH/DELETE /projects/{id}`、`POST /projects/{id}/archive`、`GET/POST /projects/{id}/members`、`DELETE /projects/{id}/members/{agentId}` |
| 任务 | `GET/POST /tasks`、`GET/PATCH/DELETE /tasks/{id}`、`POST /tasks/{id}/start\|cancel\|retry`、`POST /tasks/{id}/schedule/pause\|resume`、`GET /tasks/{id}/status-logs`、`GET /queue` |
| 执行 | `GET /tasks/{id}/executions`、`GET /executions`、`GET /executions/{eid}`、`GET /executions/{eid}/logs` |
| 系统 | `GET /system/health`、`GET/PUT /system/scheduler`、`POST /system/scheduler/tick`、`GET /system/config` |
| 智能体工具 | `POST /agent-tools/task/{list_my,update_status,submit_result,create_subtask,reassign}`（需 `x-openpms-token` 执行令牌）、`GET /tool-audits` |

---

## 8. 智能体如何接入

任务执行时，后端按**被指派智能体的 harness 底座**选择适配层分支：

**公共部分**

1. 组装 **System Prompt**（智能体人设 + 经验记忆）；
2. 组装 **用户消息**（运行时上下文：项目信息、可指派成员、已完成历史任务、当前任务、可用工具、约束）；
3. 把上述两者以 `prompt` 事件写入执行日志，便于回溯本次实际下发的上下文；
4. 启动运行时会话，实时消费事件流并落盘 + 经 WebSocket 推送。

**底座 `opencode`**

- System Prompt 经 `OPENCODE_CONFIG_CONTENT` 的 `agent.<key>.prompt` 注入，用户消息作为命令行位置参数；
- 授权了 OpenPMS 工具时，通过 `OPENCODE_CONFIG_CONTENT` 的 `mcp.openpms` 挂载 MCP server；未授权则不挂载；
- **不下发 `permission`**：harness 原生工具（读写文件、命令、网络）交由 opencode 自身默认行为。

**底座 `dsh`**

- 每次执行生成一份 `--patch` YAML 覆盖层（落在 `<数据目录>/dsh/patches/`，执行后删除），覆盖 `system-prompt` 行（人设）与 `agent-default-model` 行（模型）；该覆盖层内容也会写入执行日志；
- **任务文本走 stdin**（避免超长参数与引号转义问题）；
- **凭据**：默认不覆盖 `DSH_HOME`，因此 dsh 会用它自己的 `~/.dsh`，**你在 dsh 侧配置过一次 API Key 就能直接用**（`dsh auth login` 或 dsh Web 界面的 Models 页面，凭据存于 `~/.dsh/.credentials.yaml`）；也可以改为在启动 OpenPMS 的进程环境里 `export DEEPSEEK_API_KEY=...`，该变量会透传给 dsh。若两者都没有，会报 `MISSING_CREDENTIAL`。
- 若希望 dsh 的会话/状态与你的日常 dsh 使用隔离开，可显式设置 `OPENPMS_DSH_HOME`（此时才会下发 `DSH_HOME`）——但注意换目录后需要在新目录重新配置凭据。

**任务管理工具（两个底座一致）**

系统以 MCP server 形式向智能体提供 5 个工具：`task.list_my`、`task.update_status`、`task.submit_result`、`task.create_subtask`、`task.reassign`。底座 `opencode` 下工具名即上述名称；底座 `dsh` 下 dsh 会加命名空间前缀，形如 `mcp__openpms__task_list_my`。授权由服务端强制（执行令牌 → 项目成员 → 工具授权），未授权调用会被拒绝并审计。

> 工具授权**只覆盖这 5 个 OpenPMS 工具**。harness 自身提供的工具（读写文件、执行命令、网络访问等）不参与授权，由各底座按自身默认行为提供，因此同一套授权在换底座时语义完全一致。

智能体创建的子任务默认自动派发（带 `dependencyIds` 时改为「前置全部完成后自动执行」），无需人工启动。

### 任务重试与执行接续

任务被中断（执行报错、用户中止、服务重启）后，**重试会在被中断的那次执行上接续**——既复用同一条执行记录，也在同一个会话上继续：

1. 执行过程中**会话 id 一确定就落库**到 `task_executions.session_id`（不等执行结束），所以进程被强杀/服务重启后也照样能接续；
2. 每个重试决策点把目标执行的 id 写入 `tasks.resume_execution_id`：执行内自动重试（`retry_max` / 可重试错误兜底）、服务重启中断后的补偿重试、界面上的「重试」与对已取消任务的「开始执行」；
3. 下一次执行启动时消费该字段：**复用那条执行记录**（不新增 `task_executions` 行，状态置回「执行中」，清空上次的结束信息），日志**追加在同一份日志文件**后面，并写入一条「接续执行：复用执行记录 …」的分隔说明；
4. 同时在该执行的会话上继续——opencode 追加 `--session <id>`，dsh 追加 `--session-id <id>`；这一次**只下发 System Prompt**（底座每次请求按 agent 配置重新组装，不落会话历史），运行时上下文与用户指令**不再重复注入**（已随首次执行进入会话历史），用户消息只发一句「继续执行未完成的部分。」。

因此任务详情页里，一次被中断并重试的执行仍显示为**同一条执行记录**（同 id、同日志），而不是多出一条。

例外与边界：

- **周期任务的新一轮触发不接续**——那是新的执行而非重试；用户取消任务时会清空待接续意图，避免残留意图被下一轮误用；
- 若上次失败时底座还没建立起会话（例如没装 CLI、凭据缺失），则没有可接续的执行，重试会新建执行记录、开全新会话；
- 若历史会话 id 已失效（dsh：`session ... does not exist`），该次执行会直接失败且不消耗重试预算，再点一次重试即回到全新会话；
- 执行日志的「开始执行」事件里带 `resumeSessionId`，可直接确认某一次执行是接续还是新建。

---

## 9. 已知约束与限制

- **单机部署**：状态在本地 SQLite，队列即数据库（`tasks.status`），不支持多实例共享调度。
- **服务重启会中断执行**：重启时残留的 `running` 执行会被标记为中断，并按任务重试策略重入队或置为失败。
- **模型可用性受上游影响**：模型可能被上游调整或下线，报错形如 `Unexpected server error`；此时在智能体编辑页换一个模型（下拉候选来自该底座，或手动填写）即可。
- **harness 原生工具不受 OpenPMS 管控**（两个底座皆然）：文件读写/编辑、命令执行、网络访问由底座自身提供，OpenPMS **不做按智能体的裁剪，也不在执行期拦截命令**（原「命令黑名单」功能已随之移除）。真正的执行隔离只有两层：① 执行前的工作目录校验（`validateWorkspace`）；② System Prompt 中的约束文案（模型自律）。若要硬隔离，请用容器/受限用户运行 OpenPMS 本身。

### 底座 `dsh` 特有的限制（给智能体切换底座前请知悉）

1. **事件为步骤级、非逐 token 流式**。dsh 的 `text`/`thinking` 事件在步骤提交时才发出，长步骤内会较长时间没有新日志，实时观感弱于 opencode 底座。
2. **dsh 仍是 developer preview**。官方明示会有破坏性变更（CLI 参数、patch 配置行结构、事件词汇、退出码语义都可能变）。升级 dsh 后建议先跑一次 `dsh --profile headless --dump-config` 确认关键配置行（`system-prompt`、`agent-default-model`）仍存在。
