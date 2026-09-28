/**
 * Toast.tsx — 页面顶部提示（统一错误/成功信息展示，替代 alert）
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ToastKind = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({
  error: () => undefined,
  success: () => undefined,
  info: () => undefined,
});

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = ++seq;
      setItems((prev) => [...prev, { id, kind, text }]);
      window.setTimeout(() => remove(id), kind === 'error' ? 7000 : 3500);
    },
    [remove],
  );

  const value = useMemo<ToastApi>(
    () => ({
      error: (message: string) => push('error', message),
      success: (message: string) => push('success', message),
      info: (message: string) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast toast-${item.kind}`}
            role="button"
            tabIndex={0}
            onClick={() => remove(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') remove(item.id);
            }}
          >
            <span className="toast-text">{item.text}</span>
            <span className="toast-close">×</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
