import { useAppStore } from '../store/store'

/**
 * 已隐藏的项目 —— **恢复入口**。
 *
 * ★★ 为什么这个组件是必需的，而不是"锦上添花"：
 *   「隐藏 = 不加入项目纳管」意味着项目从看板、新建会话下拉、用量聚合里**全部消失**，
 *   服务端也不再扫描它。也就是说**隐藏之后，用户在界面上再也碰不到这个项目**。
 *   没有这张列表，「隐藏」就是一个单向的、把项目弄丢的按钮 —— 用户误点一次就只能来问人。
 *   本仓库刚为同一类问题付过代价：出错会话的「清理」把用户送进死循环，
 *   因为跳转目标从不验证「这个 id 还能不能打开」。**凡是让东西消失的操作，先想好怎么回来。**
 */
export function HiddenProjects() {
  const hidden = useAppStore((s) => s.hiddenProjects)
  const toggleHideProject = useAppStore((s) => s.toggleHideProject)
  const servers = useAppStore((s) => s.servers)
  const nameOf = (id: string) => servers.find((sv) => sv.id === id)?.name || id

  return (
    <div className="detail-section">
      <h2 className="detail-section__title">已隐藏的项目</h2>
      {hidden.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          没有隐藏任何项目。在看板上长按项目卡片可以隐藏不再需要的项目——隐藏后它不再被纳管
          （不扫描、不上看板、不进新建会话列表与用量统计），历史归档不受影响。
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            这些项目当前**不被纳管**：服务端不扫描，也不出现在看板、新建会话列表和用量统计里。
            它们的历史归档仍然保留，可在「执行历史」里检索。
          </p>
          <ul className="hidden-projects">
            {hidden.map((key) => {
              const i = key.indexOf('/')
              const serverId = key.slice(0, i)
              const project = key.slice(i + 1)
              return (
                <li key={key} className="hidden-projects__item">
                  <span className="hidden-projects__name">{project}</span>
                  <code className="hidden-projects__srv">{nameOf(serverId)}</code>
                  <button
                    className="btn btn--sm"
                    onClick={() => toggleHideProject(serverId, project)}
                  >
                    恢复纳管
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
