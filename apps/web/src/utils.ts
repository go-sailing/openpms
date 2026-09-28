/**
 * utils.ts — 通用格式化与文本工具
 */
import type { Priority, TaskStatus } from './types';

/** 毫秒时间戳 → 本地可读时间 */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 秒级时长 → 可读文本 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** datetime-local 输入框值 → 毫秒时间戳 */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 毫秒时间戳 → datetime-local 输入框值（YYYY-MM-DDTHH:mm，本地时区） */
export function toLocalInput(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

const STATUS_LABEL: Record<TaskStatus | string, string> = {
  pending: '待处理',
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  succeeded: '成功',
  interrupted: '已中断',
  enabled: '已启用',
  disabled: '已停用',
  active: '进行中',
  archived: '已归档',
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return STATUS_LABEL[status] ?? status;
}

const PRIORITY_LABEL: Record<Priority | string, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export function priorityLabel(p: Priority | string | null | undefined): string {
  if (!p) return '—';
  return PRIORITY_LABEL[p] ?? p;
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  auto: '自动',
  scheduled: '定时',
  dependency: '依赖触发',
};

export function triggerLabel(mode: string | null | undefined): string {
  if (!mode) return '—';
  return TRIGGER_LABEL[mode] ?? mode;
}

export function riskLabel(risk: string): string {
  return risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
}

/** 截断长文本（用于列表展示） */
export function truncate(text: string | null | undefined, max = 80): string {
  if (!text) return '—';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 安全 JSON 文本化 */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
