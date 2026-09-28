/**
 * platform/cron.ts — Cron 表达式工具
 */
import cronParser from 'cron-parser';

export function isValidCron(expr: string): boolean {
  try {
    cronParser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

/** 计算 from 之后的下一次触发时间；表达式非法返回 null。 */
export function nextCronTime(expr: string, from: Date = new Date()): number | null {
  try {
    const it = cronParser.parseExpression(expr, { currentDate: from });
    return it.next().toDate().getTime();
  } catch {
    return null;
  }
}
