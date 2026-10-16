import { ReactNode } from 'react'

export interface SheetAction {
  label: string
  icon?: string
  danger?: boolean
  onClick: () => void
}

/** 移动端底部动作面板（长按卡片快捷菜单） */
export function ActionSheet({ title, actions, onClose }: {
  title: ReactNode
  actions: SheetAction[]
  onClose: () => void
}) {
  return (
    <>
      <div className="sheet-overlay" onClick={onClose} />
      <div className="sheet-panel">
        <div className="sheet-title">{title}</div>
        {actions.map((a) => (
          <button
            key={a.label}
            className={`sheet-action ${a.danger ? 'sheet-action--danger' : ''}`}
            onClick={() => { onClose(); a.onClick() }}
          >
            {a.icon && <span className="sheet-action__icon">{a.icon}</span>}
            {a.label}
          </button>
        ))}
        <button className="sheet-action sheet-cancel" onClick={onClose}>取消</button>
      </div>
    </>
  )
}
