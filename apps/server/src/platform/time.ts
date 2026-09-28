/**
 * platform/time.ts
 */
export const now = (): number => Date.now();

export function fmtTime(ts?: number | null): string | null {
  return ts ? new Date(ts).toISOString() : null;
}
