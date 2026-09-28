/**
 * LogViewer.tsx — NDJSON 执行日志解析与可读化展示
 */
import { useEffect, useRef } from 'react';
import type { RuntimeLogEvent } from '../types';
import { formatTime, stringify } from '../utils';

export type LogKind = 'system' | 'output' | 'thought' | 'tool' | 'error' | 'step' | 'prompt' | 'raw';

export interface LogEntry {
  kind: LogKind;
  text: string;
  tool?: string;
  /** kind = prompt 时的角色标签（System Prompt / User Message） */
  label?: string;
  ts: number | null;
}

/** 把运行时的单条事件规范化为可展示的日志行 */
export function normalizeLogEvent(raw: RuntimeLogEvent): LogEntry | null {
  const ts = typeof raw.at === 'number' ? raw.at : null;
  switch (raw.type) {
    case 'system':
      return { kind: 'system', text: raw.text ?? '', ts };
    case 'prompt':
      return {
        kind: 'prompt',
        label: raw.role === 'system' ? 'System Prompt' : 'User Message',
        text: raw.text ?? '',
        ts,
      };
    case 'output':
      return { kind: 'output', text: raw.text ?? '', ts };
    case 'thought':
      return { kind: 'thought', text: raw.text ?? '', ts };
    case 'tool_call':
      return { kind: 'tool', tool: raw.tool, text: stringify(raw.detail), ts };
    case 'tool_result':
      return { kind: 'tool', tool: raw.tool, text: stringify(raw.detail), ts };
    case 'step_start':
      return { kind: 'step', text: '步骤开始', ts };
    case 'step_finish':
      return { kind: 'step', text: `步骤结束${raw.detail ? ` · ${stringify(raw.detail)}` : ''}`, ts };
    case 'error':
      return { kind: 'error', text: raw.text ?? '', ts };
    case 'raw':
      return normalizeRawEvent(raw.detail, ts);
    default:
      return { kind: 'raw', text: stringify(raw), ts };
  }
}

interface RawPart {
  type?: string;
  tool?: string;
  text?: string;
  state?: { status?: string; input?: unknown; output?: unknown };
}

interface RawDetail {
  type?: string;
  text?: string;
  tool?: string;
  stderr?: unknown;
  part?: RawPart;
}

/**
 * 兼容 opencode 原始事件流：日志中未识别的工具/文本/思考事件会被后端包成 raw，
 * 这里再按 detail 结构还原为可读行。
 */
function normalizeRawEvent(detail: unknown, ts: number | null): LogEntry | null {
  if (typeof detail === 'string') return { kind: 'raw', text: detail, ts };
  const d = detail as RawDetail | undefined;
  if (!d) return { kind: 'raw', text: stringify(detail), ts };

  if (typeof d.stderr === 'string' && d.stderr) return { kind: 'error', text: d.stderr, ts };

  const partType = d.part?.type;
  if (d.type === 'tool_use' || partType === 'tool') {
    const part = d.part ?? {};
    const state = part.state ?? {};
    const segments: string[] = [];
    if (state.status) segments.push(`状态：${state.status}`);
    if (state.input !== undefined) segments.push(`入参：${stringify(state.input)}`);
    if (state.output !== undefined) segments.push(`结果：${stringify(state.output)}`);
    return {
      kind: 'tool',
      tool: part.tool ?? d.tool ?? 'tool',
      text: segments.join('\n') || stringify(detail),
      ts,
    };
  }

  if (d.type === 'text' || partType === 'text') {
    const text = d.part?.text ?? d.text ?? '';
    return text ? { kind: 'output', text, ts } : null;
  }

  if (d.type === 'reasoning' || partType === 'reasoning') {
    const text = d.part?.text ?? d.text ?? '';
    return text ? { kind: 'thought', text, ts } : null;
  }

  return { kind: 'raw', text: stringify(detail), ts };
}

/** 解析 NDJSON 文本（每行一个 JSON） */
export function parseLogContent(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      entries.push({ kind: 'output', text: line, ts: null });
      continue;
    }
    const entry = normalizeLogEvent(parsed as RuntimeLogEvent);
    if (entry) entries.push(entry);
  }
  return entries;
}

const KIND_LABEL: Record<LogKind, string> = {
  system: '系统',
  output: '输出',
  thought: '思考',
  tool: '工具',
  error: '错误',
  step: '步骤',
  prompt: '提示词',
  raw: '原始',
};

function LogLine({ entry }: { entry: LogEntry }) {
  if (entry.kind === 'raw') {
    return (
      <details className="log-line log-raw">
        <summary>原始事件 {entry.ts ? `· ${formatTime(entry.ts)}` : ''}</summary>
        <pre>{entry.text}</pre>
      </details>
    );
  }

  if (entry.kind === 'prompt') {
    return (
      <details className="log-line log-prompt">
        <summary>
          {entry.label ?? '提示词'}
          {entry.ts ? ` · ${formatTime(entry.ts)}` : ''}
        </summary>
        <pre>{entry.text}</pre>
      </details>
    );
  }

  if (entry.kind === 'step') {
    return (
      <div className="log-line log-step">
        <span className="log-step-text">{entry.text}</span>
        {entry.ts ? <span className="log-time">{formatTime(entry.ts)}</span> : null}
      </div>
    );
  }

  return (
    <div className={`log-line log-${entry.kind}`}>
      <div className="log-head">
        <span className="log-kind">{KIND_LABEL[entry.kind]}</span>
        {entry.tool ? <span className="log-tool-name">{entry.tool}</span> : null}
        {entry.ts ? <span className="log-time">{formatTime(entry.ts)}</span> : null}
      </div>
      <pre className="log-text">{entry.text}</pre>
    </div>
  );
}

interface LogViewerProps {
  entries: LogEntry[];
  height?: number;
  emptyText?: string;
}

export function LogViewer({ entries, height = 460, emptyText = '暂无日志' }: LogViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const handleScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (!entries.length) return <div className="empty small">{emptyText}</div>;

  return (
    <div className="log-view" ref={boxRef} onScroll={handleScroll} style={{ maxHeight: height }}>
      {entries.map((entry, index) => (
        <LogLine key={index} entry={entry} />
      ))}
    </div>
  );
}
