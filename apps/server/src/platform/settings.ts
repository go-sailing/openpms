/**
 * platform/settings.ts
 * 键值设置（系统级调度开关等）。
 */
import type { Db } from './db.js';
import { now } from './time.js';

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      now(),
    );
  }

  getBool(key: string, fallback: boolean): boolean {
    const v = this.get(key);
    if (v === undefined) return fallback;
    return v === '1' || v === 'true';
  }

  setBool(key: string, value: boolean): void {
    this.set(key, value ? '1' : '0');
  }
}

export const SETTING_KEYS = {
  autoScheduleEnabled: 'scheduler.autoScheduleEnabled',
  lastRecoveryAt: 'scheduler.lastRecoveryAt',
} as const;
