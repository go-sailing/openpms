/**
 * platform/db.ts
 * 基于 Node 内置 node:sqlite 的轻量数据库封装（无需原生编译）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

type SqliteCtor = new (path: string) => Database;

// 使用动态 import 的字符串形式，避免依赖 @types/node 是否内置 node:sqlite 类型声明。
const sqliteModule = (await import('node:sqlite' as string)) as { DatabaseSync: SqliteCtor };

export class Db {
  private readonly raw: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new sqliteModule.DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.raw.prepare(sql).get(...params);
    return (row as T | undefined) ?? undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** 在事务中执行；抛错自动回滚。 */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
