/**
 * useWebSocket.ts — WebSocket 连接（同源 /ws，由 vite 代理到后端）
 * 采用模块级单例连接 + 事件订阅，避免多组件重复建连。
 */
import { useEffect, useRef, useState } from 'react';
import type { WsEvent } from '../types';

type Handler = (event: WsEvent) => void;

const handlers = new Set<Handler>();
const statusListeners = new Set<(connected: boolean) => void>();

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let started = false;
let connected = false;

function notifyStatus(): void {
  for (const listener of statusListeners) listener(connected);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    socket = new WebSocket(`${proto}//${window.location.host}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    connected = true;
    notifyStatus();
    try {
      socket?.send(JSON.stringify({ action: 'subscribe', all: true }));
    } catch {
      /* ignore */
    }
  };

  socket.onmessage = (ev: MessageEvent) => {
    let data: WsEvent;
    try {
      data = JSON.parse(String(ev.data)) as WsEvent;
    } catch {
      return;
    }
    if (!data || data.type === 'hello') return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  };

  socket.onclose = () => {
    connected = false;
    notifyStatus();
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    /* 连接错误统一由 onclose 处理重连 */
  };
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  connect();
}

/** 订阅连接状态；返回当前是否已连接 */
export function useWebSocket(): boolean {
  const [isConnected, setIsConnected] = useState(connected);

  useEffect(() => {
    ensureStarted();
    const listener = (value: boolean) => setIsConnected(value);
    statusListeners.add(listener);
    setIsConnected(connected);
    return () => {
      statusListeners.delete(listener);
    };
  }, []);

  return isConnected;
}

/** 订阅服务端推送事件 */
export function useWsEvent(handler: Handler, deps: unknown[] = []): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const wrapped: Handler = (event) => ref.current(event);
    handlers.add(wrapped);
    return () => {
      handlers.delete(wrapped);
    };
    // deps 由调用方控制重订阅时机
  }, deps);
}
