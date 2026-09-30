/**
 * main.ts — Electron 主进程
 *
 * 客户端形态：**内置后端**。启动时用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）
 * 拉起打包进 resources 的 OpenPMS 后端，等健康检查通过后再打开主窗口；
 * 退出时终止后端进程。
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 必须在读取 userData 路径之前设置，否则会因包名带斜杠产生非法目录名
app.setName('OpenPMS');

const HEALTH_TIMEOUT_MS = 30_000;

let backend: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/** 内置后端的运行时目录（开发态 = apps/desktop/dist，打包态 = resources/） */
function serverRuntimeDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'server') : join(__dirname, 'server');
}

/** 前端静态资源目录 */
function webRuntimeDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, 'web');
}

/** 取一个空闲端口，避免与用户正在运行的服务冲突 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('未能分配可用端口'))));
    });
  });
}

/**
 * 桌面启动时 PATH 往往不含 shell 里配置的目录，这里补充 opencode / node 的常见安装位置，
 * 保证智能体执行时能找到所选运行时的 CLI（opencode / dsh）。
 */
function buildPath(): string {
  const home = homedir();
  const extra = [
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'bin'),
    // dsh（DeepSeek Harness）的常见安装位置
    join(home, '.dsh', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const nvmNodeRoot = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmNodeRoot)) {
    for (const version of readdirSync(nvmNodeRoot)) extra.push(join(nvmNodeRoot, version, 'bin'));
  }
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  return [...new Set([...current, ...extra])].join(':');
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (backend && backend.exitCode !== null) {
      throw new Error(`内置后端已退出（exitCode=${backend.exitCode}）`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/health`);
      if (res.ok) return;
    } catch {
      /* 尚未就绪，继续等待 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`内置后端启动超时（${HEALTH_TIMEOUT_MS} ms）`);
}

async function startBackend(): Promise<number> {
  const entry = join(serverRuntimeDir(), 'dist', 'index.mjs');
  if (!existsSync(entry)) {
    throw new Error(
      `未找到内置后端：${entry}\n请先在仓库根目录执行 npm run desktop（会自动构建并装配运行时资源）。`,
    );
  }

  const port = await findFreePort();
  const dataDir = app.getPath('userData');
  const child = spawn(process.execPath, [entry], {
    cwd: dataDir,
    env: {
      ...process.env,
      // 以 Node 模式运行 Electron 可执行文件，从而无需系统安装 Node
      ELECTRON_RUN_AS_NODE: '1',
      OPENPMS_PORT: String(port),
      OPENPMS_DATA_DIR: dataDir,
      OPENPMS_WEB_DIST: webRuntimeDir(),
      PATH: buildPath(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
  child.on('exit', (code, signal) => {
    backend = null;
    if (quitting) return;
    const detail = signal ? `信号 ${signal}` : `退出码 ${code}`;
    dialog.showErrorBox('OpenPMS 后端已退出', `内置后端进程意外结束（${detail}）。`);
    app.quit();
  });

  backend = child;
  await waitForHealth(port);
  return port;
}

function stopBackend(): void {
  const child = backend;
  backend = null;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 3000).unref?.();
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'OpenPMS',
    backgroundColor: '#12151f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`http://127.0.0.1:${port}`)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  mainWindow.webContents.once('did-finish-load', () => {
    console.log(`[main] 界面已加载：http://127.0.0.1:${port}`);
  });

  void mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

// 单实例：重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      const port = await startBackend();
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox('OpenPMS 启动失败', (err as Error).message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    quitting = true;
    stopBackend();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopBackend();
  });
}
