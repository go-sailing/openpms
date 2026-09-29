/**
 * scripts/stage.mjs — 为 Electron 客户端装配「内置后端」运行时资源
 *
 * 产出（apps/desktop/dist/）：
 *   server/dist/index.mjs       后端自包含单文件（仅 node 内置模块外部化）
 *   server/mcp/openpms-tools.mjs 智能体工具 MCP 服务（需保持独立文件，由 opencode 子进程拉起）
 *   web/**                      前端静态资源
 *
 * 目录结构刻意与 apps/server 保持一致：后端入口位于 <runtime>/server/dist/index.mjs，
 * 因此其内部 resolve(here, '..', 'mcp', ...) 仍能正确定位到 <runtime>/server/mcp/。
 */
import { build } from 'esbuild';
import { access, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const repoRoot = resolve(desktopDir, '..', '..');

const serverEntry = resolve(repoRoot, 'apps/server/src/index.ts');
const serverMcpDir = resolve(repoRoot, 'apps/server/mcp');
const webDistDir = resolve(repoRoot, 'apps/web/dist');

const outServerDir = resolve(desktopDir, 'dist/server');
const outWebDir = resolve(desktopDir, 'dist/web');

// 打包为 ESM 时，为内联的 CJS 依赖补上 require/__filename/__dirname
const banner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __dirname_of } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  "const __dirname = __dirname_of(__filename);",
].join('\n');

await rm(outServerDir, { recursive: true, force: true });
await mkdir(resolve(outServerDir, 'dist'), { recursive: true });

await build({
  entryPoints: [serverEntry],
  outfile: resolve(outServerDir, 'dist/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:*'],
  banner: { js: banner },
  logLevel: 'info',
});

await cp(serverMcpDir, resolve(outServerDir, 'mcp'), { recursive: true });

try {
  await access(webDistDir);
} catch {
  throw new Error('未找到前端构建产物 apps/web/dist，请先执行 npm run build:web');
}
await rm(outWebDir, { recursive: true, force: true });
await cp(webDistDir, outWebDir, { recursive: true });

console.log('[stage] 运行时资源已就绪：dist/server/dist/index.mjs, dist/server/mcp, dist/web');
