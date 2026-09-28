/**
 * execution/logs.ts — 执行日志落盘（按执行分片，支持大小轮转与读取）
 * 大日志落文件，数据库只存 log_path（SDD 第 7 章说明）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../platform/config.js';

export class ExecutionLogWriter {
  private readonly dir: string;
  private readonly base: string;
  private part = 1;
  private size = 0;
  private maxBytes: number;

  constructor(executionId: string) {
    this.dir = config.logDir;
    mkdirSync(this.dir, { recursive: true });
    this.base = join(this.dir, `${executionId}.log`);
    this.maxBytes = Math.max(1, config.logFileMaxMB) * 1024 * 1024;
    if (existsSync(this.base)) this.size = statSync(this.base).size;
  }

  get path(): string {
    return this.base;
  }

  private currentPath(): string {
    return this.part === 1 ? this.base : `${this.base}.part${this.part}`;
  }

  append(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ...event, ts: Date.now() }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.size + bytes > this.maxBytes) {
      this.part += 1;
      this.size = 0;
    }
    appendFileSync(this.currentPath(), line, 'utf8');
    this.size += bytes;
  }

  appendRaw(text: string): void {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.size + bytes > this.maxBytes) {
      this.part += 1;
      this.size = 0;
    }
    appendFileSync(this.currentPath(), line, 'utf8');
    this.size += bytes;
  }
}

export function readExecutionLog(executionId: string, opts: { tail?: number } = {}): string {
  const base = join(config.logDir, `${executionId}.log`);
  const dir = config.logDir;
  if (!existsSync(dir)) return '';
  const parts = readdirSync(dir)
    .filter((f) => f === `${executionId}.log` || f.startsWith(`${executionId}.log.part`))
    .sort((a, b) => {
      const na = Number(a.split('.part')[1] ?? 1);
      const nb = Number(b.split('.part')[1] ?? 1);
      return na - nb;
    });
  if (parts.length === 0) return '';
  let content = '';
  for (const p of parts) {
    content += readFileSync(join(dir, p), 'utf8');
  }
  if (opts.tail && content.length > opts.tail) {
    const lines = content.split('\n');
    return lines.slice(-opts.tail).join('\n');
  }
  return content;
}

export function logFilesExist(executionId: string): boolean {
  return existsSync(join(config.logDir, `${executionId}.log`));
}

/** 删除某次执行的全部日志分片文件 */
export function deleteExecutionLogs(executionId: string): number {
  const dir = config.logDir;
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (f === `${executionId}.log` || f.startsWith(`${executionId}.log.part`)) {
      try {
        rmSync(join(dir, f));
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}
