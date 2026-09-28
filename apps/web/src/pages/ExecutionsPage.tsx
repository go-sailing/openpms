/**
 * ExecutionsPage.tsx — 最近执行记录 + 单次执行日志（NDJSON 可读化，运行中实时追加）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Empty } from '../components/Empty';
import { LogViewer, normalizeLogEvent, parseLogContent, type LogEntry } from '../components/LogViewer';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { useWsEvent } from '../hooks/useWebSocket';
import type { Execution, RuntimeLogEvent } from '../types';
import { formatTime } from '../utils';

interface ExecutionsPageProps {
  /** 由其他页面（如任务详情）跳转过来时，要自动选中的执行记录 id */
  initialExecutionId?: string | null;
  /** 已消费 initialExecutionId 后通知调用方清空，避免再次进入本页时重复选中 */
  onInitialConsumed?: () => void;
}

export function ExecutionsPage({ initialExecutionId, onInitialConsumed }: ExecutionsPageProps) {
  const toast = useToast();
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Execution | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const lastRefresh = useRef(0);

  const load = useCallback(async () => {
    try {
      setExecutions(await api.recentExecutions(50));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useWsEvent((event) => {
    if (event.type === 'task.log') {
      if (!selectedId) return;
      const payload = event.payload as { executionId?: string; event?: RuntimeLogEvent } | undefined;
      if (payload?.executionId && payload.executionId === selectedId && payload.event) {
        const entry = normalizeLogEvent(payload.event);
        if (entry) setLogEntries((prev) => [...prev, entry]);
      }
      return;
    }
    if (event.type.startsWith('execution.') || event.type === 'task.updated') {
      const now = Date.now();
      if (now - lastRefresh.current < 800) return;
      lastRefresh.current = now;
      void load();
    }
  });

  const openExecutionById = useCallback(
    async (executionId: string) => {
      setSelectedId(executionId);
      setLogEntries([]);
      setLogLoading(true);
      try {
        const [detail, logs] = await Promise.all([
          api.getExecution(executionId),
          api.executionLogs(executionId, 2000),
        ]);
        setSelected(detail);
        setLogEntries(parseLogContent(logs.content));
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLogLoading(false);
      }
    },
    [toast],
  );

  // 从任务详情等页面跳转过来：自动选中并加载对应执行记录
  const consumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialExecutionId || consumedRef.current === initialExecutionId) return;
    consumedRef.current = initialExecutionId;
    void openExecutionById(initialExecutionId);
    onInitialConsumed?.();
  }, [initialExecutionId, openExecutionById, onInitialConsumed]);

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-info">最近 {executions.length} 次执行</div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">加载中…</div>
      ) : executions.length === 0 ? (
        <Empty text="暂无执行记录" />
      ) : (
        <div className="exec-layout wide">
          <ul className="exec-list">
            {executions.map((execution) => (
              <li key={execution.id}>
                <button
                  type="button"
                  className={`exec-item ${selectedId === execution.id ? 'active' : ''}`}
                  onClick={() => void openExecutionById(execution.id)}
                >
                  <StatusBadge status={execution.status} />
                  <span className="mono small">{execution.id.slice(-8)}</span>
                  <span className="muted small">
                    {execution.trigger_type === 'manual' ? '手动' : '调度'} · {formatTime(execution.started_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="exec-log">
            {selected ? (
              <>
                <div className="panel-head">
                  <h2 className="mono">{selected.id}</h2>
                </div>
                <div className="kv-grid">
                  <div className="kv">
                    <span className="kv-k">状态</span>
                    <span className="kv-v">
                      <StatusBadge status={selected.status} />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="kv-k">任务</span>
                    <span className="kv-v mono">{selected.task_id}</span>
                  </div>
                  <div className="kv">
                    <span className="kv-k">智能体</span>
                    <span className="kv-v mono">{selected.agent_id}</span>
                  </div>
                  <div className="kv">
                    <span className="kv-k">触发 / 重试</span>
                    <span className="kv-v">
                      {selected.trigger_type === 'manual' ? '手动' : '调度器'} · 第 {selected.retry_no} 次
                    </span>
                  </div>
                  <div className="kv">
                    <span className="kv-k">开始 / 结束</span>
                    <span className="kv-v small">
                      {formatTime(selected.started_at)} / {formatTime(selected.finished_at)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="kv-k">会话</span>
                    <span className="kv-v mono small">{selected.session_id || '—'}</span>
                  </div>
                  <div className="kv wide">
                    <span className="kv-k">工作目录</span>
                    <span className="kv-v mono">{selected.workspace || '—'}</span>
                  </div>
                </div>

                {selected.error ? <div className="alert alert-error">错误：{selected.error}</div> : null}
                {selected.result ? (
                  <section className="detail-section">
                    <h4>执行产出</h4>
                    <pre className="pre-block">{selected.result}</pre>
                  </section>
                ) : null}

                <section className="detail-section">
                  <h4>
                    执行日志
                    {selected.status === 'running' ? <span className="live-tag">实时追加中</span> : null}
                  </h4>
                  {logLoading ? (
                    <div className="empty small">日志加载中…</div>
                  ) : (
                    <LogViewer entries={logEntries} height={520} />
                  )}
                </section>
              </>
            ) : (
              <Empty text="请选择左侧执行记录查看详情与日志" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
