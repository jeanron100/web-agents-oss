/** 看板/列表加载骨架屏 */
export function SkeletonCards({ count = 5 }: { count?: number }) {
  return (
    <div className="server-group__cards">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="session-card skeleton-card">
          <div className="skeleton-line" style={{ width: '45%' }} />
          <div className="skeleton-line" style={{ width: '70%', marginTop: 10 }} />
          <div className="skeleton-line" style={{ width: '88%', marginTop: 10 }} />
        </div>
      ))}
    </div>
  )
}
