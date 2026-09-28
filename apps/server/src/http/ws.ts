/**
 * http/ws.ts — WebSocket 事件推送
 * 事件类型见 SDD 8.2：task.updated / task.log / execution.* / queue.updated / scheduler.diagnostic
 */
import type { ServerResponse } from 'node:http';
import type { DomainEvent } from '../platform/events.js';
import { bus } from '../platform/events.js';

interface Client {
  send: (data: string) => void;
  taskIds: Set<string>;
  projectIds: Set<string>;
  all: boolean;
}

const clients = new Set<Client>();

export function wsHandler(connection: unknown, req: unknown): void {
  const socket = connection as {
    socket?: { on: (e: string, cb: (d: unknown) => void) => void };
    on: (e: string, cb: (d: unknown) => void) => void;
    send: (d: string) => void;
    readyState: number;
  };
  const client: Client = {
    send: (d) => {
      try {
        socket.send(d);
      } catch {
        /* ignore */
      }
    },
    taskIds: new Set(),
    projectIds: new Set(),
    all: true,
  };
  clients.add(client);

  socket.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw)) as {
        action?: string;
        taskId?: string;
        projectId?: string;
        all?: boolean;
      };
      if (msg.action === 'subscribe') {
        if (msg.all) {
          client.all = true;
          client.taskIds.clear();
          client.projectIds.clear();
        } else {
          client.all = false;
          if (msg.taskId) client.taskIds.add(msg.taskId);
          if (msg.projectId) client.projectIds.add(msg.projectId);
        }
      } else if (msg.action === 'unsubscribe') {
        if (msg.taskId) client.taskIds.delete(msg.taskId);
        if (msg.projectId) client.projectIds.delete(msg.projectId);
      }
    } catch {
      /* 忽略非法消息 */
    }
  });

  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));

  client.send(JSON.stringify({ type: 'hello', at: Date.now() }));
}

bus.on((e: DomainEvent) => {
  if (clients.size === 0) return;
  const payload = JSON.stringify(e);
  for (const c of clients) {
    const match =
      c.all ||
      (e.taskId && c.taskIds.has(e.taskId)) ||
      (e.projectId && c.projectIds.has(e.projectId));
    if (match) c.send(payload);
  }
});

export function wsClientCount(): number {
  return clients.size;
}

export type { ServerResponse };
