/**
 * OverviewPage.tsx — 概览：调度开关、队列、健康信息、手动触发 tick
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useToast } from '../components/Toast';
import { useWsEvent } from '../hooks/useWebSocket';
import type { HealthStatus, SchedulerStatus, SystemConfig } from '../types';
import { formatDuration, formatTime } from '../utils';

export function OverviewPage() {
  const toast = useToast();
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lastRefresh = useRef(0);

  const load = useCallback(async () => {
    try {
      const [schedulerData, healthData, configData] = await Promise.all([
        api.schedulerStatus(),
        api.health(),
        api.systemConfig(),
      ]);
      setScheduler(schedulerData);
      setHealth(healthData);
      setConfig(configData);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshSoon = useCallback(() => {
    const now = Date.now();
    if (now - lastRefresh.current < 800) return;
    lastRefresh.current = now;
    void load();
  }, [load]);

  useWsEvent((event) => {
    if (
      event.type === 'queue.updated' ||
      event.type === 'scheduler.diagnostic' ||
      event.type === 'task.updated' ||
      event.type.startsWith('execution.')
    ) {
      refreshSoon();
    }
  });

  const toggleScheduler = async () => {
    if (!scheduler) return;
    setBusy(true);
    try {
      const next = await api.setSchedulerEnabled(!scheduler.enabled);
      setScheduler(next);
      toast.success(next.enabled ? '调度器已启用' : '调度器已暂停');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const triggerTick = async () => {
    setBusy(true);
    try {
      const next = await api.schedulerTick();
      setScheduler(next);
      toast.success('已手动触发一次调度 tick');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="empty">加载中…</div>;

  return (
    <div className="page">
      <section className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">调度器</div>
          <div className="stat-value">
            <span className={`dot ${scheduler?.enabled ? 'dot-green' : 'dot-gray'}`} />
            {scheduler?.enabled ? '已启用' : '已暂停'}
          </div>
          <div className="stat-foot">tick 间隔 {scheduler?.tickMs ?? '—'} ms</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">队列长度</div>
          <div className="stat-value">{scheduler?.queued ?? 0}</div>
          <div className="stat-foot">等待派发的任务数</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">运行中执行</div>
          <div className="stat-value">{scheduler?.runningExecutions ?? 0}</div>
          <div className="stat-foot">全局最大并发 {scheduler?.globalMaxConcurrency ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">最近 tick</div>
          <div className="stat-value small">{formatTime(scheduler?.lastTickAt ?? null)}</div>
          <div className="stat-foot">调度循环 {scheduler?.running ? '运行中' : '空闲'}</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>调度控制</h2>
          <div className="panel-actions">
            <button type="button" className="btn btn-primary" onClick={toggleScheduler} disabled={busy}>
              {scheduler?.enabled ? '暂停调度' : '启用调度'}
            </button>
            <button type="button" className="btn" onClick={triggerTick} disabled={busy}>
              手动触发调度 tick
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={busy}>
              刷新
            </button>
          </div>
        </div>
        <div className="kv-grid">
          <div className="kv">
            <span className="kv-k">调度开关</span>
            <span className="kv-v">{scheduler?.enabled ? '开启' : '关闭'}</span>
          </div>
          <div className="kv">
            <span className="kv-k">调度循环</span>
            <span className="kv-v">{scheduler?.running ? '运行中' : '空闲'}</span>
          </div>
          <div className="kv">
            <span className="kv-k">tick 间隔</span>
            <span className="kv-v">{scheduler?.tickMs ?? '—'} ms</span>
          </div>
          <div className="kv">
            <span className="kv-k">全局最大并发</span>
            <span className="kv-v">{scheduler?.globalMaxConcurrency ?? '—'}</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>系统健康</h2>
        </div>
        {health ? (
          <div className="kv-grid">
            <div className="kv">
              <span className="kv-k">服务状态</span>
              <span className="kv-v">
                <span className={`dot ${health.ok ? 'dot-green' : 'dot-red'}`} />
                {health.ok ? '正常' : '异常'}
              </span>
            </div>
            <div className="kv">
              <span className="kv-k">版本</span>
              <span className="kv-v">{health.version}</span>
            </div>
            <div className="kv">
              <span className="kv-k">运行时长</span>
              <span className="kv-v">{formatDuration(health.uptimeSec)}</span>
            </div>
            <div className="kv">
              <span className="kv-k">WS 客户端</span>
              <span className="kv-v">{health.wsClients}</span>
            </div>
            <div className="kv">
              <span className="kv-k">opencode 可用</span>
              <span className="kv-v">
                <span className={`dot ${health.opencode.available ? 'dot-green' : 'dot-red'}`} />
                {health.opencode.available ? '可用' : '不可用'}
              </span>
            </div>
            <div className="kv">
              <span className="kv-k">默认模型</span>
              <span className="kv-v mono">{health.opencode.defaultModel || '—'}</span>
            </div>
            <div className="kv wide">
              <span className="kv-k">opencode 路径</span>
              <span className="kv-v mono">{health.opencode.bin}</span>
            </div>
          </div>
        ) : (
          <div className="empty small">暂无健康信息</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>运行配置（只读）</h2>
        </div>
        {config ? (
          <div className="kv-grid">
            {Object.entries(config).map(([key, value]) => (
              <div className="kv" key={key}>
                <span className="kv-k">{key}</span>
                <span className="kv-v mono">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty small">暂无配置</div>
        )}
      </section>
    </div>
  );
}
