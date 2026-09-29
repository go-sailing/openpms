# OpenPMS · 智能体项目管理系统

OpenPMS 是一个以「项目」为组织单元的多智能体协作与任务调度平台。你把任务指派给具备独立人设、经验记忆和工具权限的智能体，由 [opencode](https://opencode.ai) 作为底层运行时**真实执行**（读写文件、执行命令），系统统一负责队列、并发、失败重试与执行留痕。

- 产品需求：[docs/prd.md](docs/prd.md)
- 系统设计：[docs/sdd.md](docs/sdd.md)

---

## 1. 核心能力

| 能力 | 说明 |
| --- | --- |
| 智能体管理 | 独立 System Prompt、模型、最大并发、执行超时、工具授权、经验记忆（执行结束后自动沉淀，页面仅可查看/删除）；内置「项目经理 / 产品经理 / 开发工程师 / 测试工程师」四个模板 |
| 项目管理 | 多项目管理、默认工作目录、项目级调度开关、归档与级联删除；**只有项目成员列表中的智能体才能被指派或调度执行该项目任务** |
| 任务管理 | 任务 CRUD、父子任务拆解、前置依赖（创建时做同项目 / 非自身 / 环检测校验）、优先级、计划时间与 Cron 周期 |
| 自动调度 | 四种触发方式：手动 / 自动派发 / 定时（Cron 周期）/ 依赖触发；队列按「优先级 + 入队时间 FIFO」派发；全局与按智能体的并发槽位；条件更新（CAS）占用防止重复执行 |
| 失败重试 | 按任务配置的重试次数 / 间隔 / 退避策略（固定或指数）；未配置重试策略时，对上游标记为「可重试」的瞬时错误（网络不可达、上游 5xx、限流等）仍会兜底重试 |
| 执行与观测 | 每次执行独立子进程；事件流经 WebSocket 实时推送；NDJSON 日志落盘并按大小分片轮转；支持执行超时与用户中止；产出回写到任务 |
| 智能体工具 | 以 MCP（stdio）形式向智能体暴露任务管理工具：查询我的任务、更新状态、回写产出、创建子任务、改派；三重鉴权（执行令牌 → 项目成员 → 工具授权）+ 全量审计 |
| 沙箱 | 工作目录校验 + 命令黑名单（提权、关机重启、磁盘操作、危险删除等），黑名单通过 opencode 的 `permission.bash` 下发 |

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
| 智能体运行时 | opencode CLI（`opencode run --format json`，NDJSON 事件流） |
| 智能体工具协议 | MCP（stdio，NDJSON JSON-RPC 2.0） |
| 仓库结构 | npm workspaces monorepo |

---

## 3. 目录结构

```
openpms/
├── apps/
│   ├── server/                    # 后端服务
│   │   ├── mcp/openpms-tools.mjs  # 暴露给 opencode 的 MCP 工具服务
│   │   └── src/
│   │       ├── agent/             # 智能体 + 经验记忆 + 工具授权
│   │       ├── project/           # 项目 + 项目成员
│   │       ├── task/              # 任务 + 状态机 + 依赖
│   │       ├── execution/         # 执行引擎 + 日志落盘
│   │       ├── scheduler/         # 触发器 / 派发 / 依赖传播 / 重建恢复
│   │       ├── runtime/           # opencode 适配层 + 上下文组装
│   │       ├── tools/             # 智能体任务管理工具（鉴权 + 审计）
│   │       ├── sandbox/           # 工作目录与命令黑名单
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
opencode --version  # 需已安装 opencode CLI，并完成模型鉴权
```

> 智能体的模型调用由 opencode 负责，模型与 API Key 请在 opencode 侧配置。
> 未单独指定模型时，系统默认使用 `opencode/mimo-v2.6-flash-free`。

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

- 桌面客户端仍依赖 **opencode CLI**：请确保已安装并完成模型鉴权。主进程会把 `~/.opencode/bin`、`~/.nvm/*/bin` 等常见位置补进 `PATH`（从桌面启动时不会继承 shell 的 PATH）。
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
| `OPENCODE_BIN` | opencode 可执行文件路径 | `opencode`（从 PATH 查找） |

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
| 智能体 | `GET/POST /agents`、`GET/PATCH/DELETE /agents/{id}`、`POST /agents/{id}/enable\|disable`、`GET /agents/{id}/memories`、`DELETE /memories/{memoryId}`、`GET/PUT /agents/{id}/tools`、`GET /tools/catalog` |
| 项目 | `GET/POST /projects`、`GET/PATCH/DELETE /projects/{id}`、`POST /projects/{id}/archive`、`GET/POST /projects/{id}/members`、`DELETE /projects/{id}/members/{agentId}` |
| 任务 | `GET/POST /tasks`、`GET/PATCH/DELETE /tasks/{id}`、`POST /tasks/{id}/start\|cancel\|retry`、`POST /tasks/{id}/schedule/pause\|resume`、`GET /tasks/{id}/status-logs`、`GET /queue` |
| 执行 | `GET /tasks/{id}/executions`、`GET /executions`、`GET /executions/{eid}`、`GET /executions/{eid}/logs` |
| 系统 | `GET /system/health`、`GET/PUT /system/scheduler`、`POST /system/scheduler/tick`、`GET /system/config`、`GET /system/command-blacklist`、`POST /system/command-check` |
| 智能体工具 | `POST /agent-tools/task/{list_my,update_status,submit_result,create_subtask,reassign}`（需 `x-openpms-token` 执行令牌）、`GET /tool-audits` |

---

## 8. 智能体如何接入

任务执行时，后端会：

1. 组装 **System Prompt**（智能体人设 + 经验记忆）经 `OPENCODE_CONFIG_CONTENT` 注入 opencode；
2. 组装 **用户消息**（运行时上下文：项目信息、可指派成员、已完成历史任务、当前任务、可用工具、约束）；
3. 按工具授权生成 `permission` 规则（含工作目录沙箱与命令黑名单），仅授权工具对智能体可见；
4. 以 `opencode run --format json` 启动会话，实时消费事件流并落盘。

系统向智能体额外提供 5 个任务管理工具（MCP）：`task.list_my`、`task.update_status`、`task.submit_result`、`task.create_subtask`、`task.reassign`。智能体创建的子任务默认自动派发（带 `dependencyIds` 时改为「前置全部完成后自动执行」），无需人工启动。

---

## 9. 已知约束

- **单机部署**：状态在本地 SQLite，队列即数据库（`tasks.status`），不支持多实例共享调度。
- **执行隔离依赖 opencode**：工作目录与命令限制通过 opencode 的权限配置下发，并非操作系统级沙箱。
- **服务重启会中断执行**：重启时残留的 `running` 执行会被标记为中断，并按任务重试策略重入队或置为失败。
- **模型可用性受上游影响**：默认免费模型可能被上游调整或下线，报错形如 `Unexpected server error`；此时在智能体上改配模型或调整 `defaultModel` 即可。
