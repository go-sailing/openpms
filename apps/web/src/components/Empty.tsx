/**
 * Empty.tsx — 空列表占位
 */
export function Empty({ text = '暂无数据' }: { text?: string }) {
  return <div className="empty">{text}</div>;
}
