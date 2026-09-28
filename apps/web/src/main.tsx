/**
 * main.tsx — 应用入口：无路由库，使用 useState 切换页面
 */
import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout, type PageKey } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { useWebSocket } from './hooks/useWebSocket';
import { AgentsPage } from './pages/AgentsPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { QueuePage } from './pages/QueuePage';
import './styles.css';

function App() {
  const [page, setPage] = useState<PageKey>('overview');
  // 跨页跳转：从任务详情点击某次执行记录后，切到"执行日志"页并选中它
  const [executionTarget, setExecutionTarget] = useState<string | null>(null);
  const wsConnected = useWebSocket();

  const openExecutionLog = useCallback((executionId: string) => {
    setExecutionTarget(executionId);
    setPage('executions');
  }, []);

  const consumeExecutionTarget = useCallback(() => setExecutionTarget(null), []);

  return (
    <Layout page={page} onNavigate={setPage} wsConnected={wsConnected}>
      {page === 'overview' ? <OverviewPage /> : null}
      {page === 'agents' ? <AgentsPage /> : null}
      {page === 'projects' ? <ProjectsPage onOpenExecution={openExecutionLog} /> : null}
      {page === 'queue' ? <QueuePage /> : null}
      {page === 'executions' ? (
        <ExecutionsPage
          initialExecutionId={executionTarget}
          onInitialConsumed={consumeExecutionTarget}
        />
      ) : null}
    </Layout>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器不存在');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
