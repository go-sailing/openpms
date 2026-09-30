/**
 * runtime/common.ts — 运行时适配层共享工具
 *
 * 这些实现与具体运行时（opencode / dsh）无关，被各适配层复用：
 *   - AsyncQueue：把子进程回调式事件流转成 AsyncIterable
 *   - extractMemoryCandidates：从产出文本中解析「记忆沉淀」小节
 */

/** 简单异步队列，用于把子进程事件流转成 AsyncIterable */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buffer.push(v);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** 从最终输出中抽取「记忆沉淀」小节 */
export function extractMemoryCandidates(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s*记忆沉淀/.test(line) || /^\*\*?记忆沉淀/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,6}\s/.test(line) && !/记忆沉淀/.test(line)) break;
      const m = /^[-*]\s+(.+)$/.exec(line) || /^\d+[.、]\s*(.+)$/.exec(line);
      if (m && m[1] && !/^（.*）$/.test(m[1])) out.push(m[1].trim());
    }
  }
  return out
    .filter((s) => s.length >= 4 && s.length <= 500)
    .filter((s) => !/^（.*）$/.test(s))
    .slice(0, 20);
}