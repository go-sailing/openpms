/**
 * Layout.tsx — 应用外壳：左侧导航 + 顶栏
 */
import type { ReactNode } from 'react';

export type PageKey = 'overview' | 'agents' | 'projects' | 'queue' | 'executions';

const NAV: { key: PageKey; label: string; icon: string; hint: string }[] = [
  { key: 'overview', label: '概览', icon: '▦', hint: '系统与调度总览' },
  { key: 'agents', label: '智能体', icon: '🤖', hint: '智能体与经验记忆' },
  { key: 'projects', label: '项目', icon: '📁', hint: '项目、成员与任务管理' },
  { key: 'queue', label: '调度队列', icon: '⇉', hint: '排队与派发顺序' },
  { key: 'executions', label: '执行日志', icon: '🖥', hint: '执行记录与实时日志' },
];

interface LayoutProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  wsConnected: boolean;
  children: ReactNode;
}

export function Layout({ page, onNavigate, wsConnected, children }: LayoutProps) {
  const current = NAV.find((item) => item.key === page);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <div className="brand-name">OpenPMS</div>
            <div className="brand-sub">智能体项目管理系统</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              onClick={() => onNavigate(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`ws-dot ${wsConnected ? 'on' : 'off'}`} />
          {wsConnected ? '实时连接正常' : '实时连接断开'}
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{current?.label ?? ''}</h1>
          <span className="topbar-sub">{current?.hint ?? ''}</span>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
