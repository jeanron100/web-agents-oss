import { Component, type ErrorInfo, type ReactNode } from 'react'

// 全局错误边界。
//
// 为什么需要它：**一个组件抛异常，整个应用就白屏**——React Router 会把整页换成
// 「Unexpected Application Error!」+ 一大坨 minified 栈。用户实测踩到：设置页的数据层面板
// 读 `stats.projection.spoolBytes`，后端返回的形状对不上时直接 `Cannot read properties of
// undefined` → **看板、收件箱、会话流全都没了**，只剩报错页。
//
// 一个组件坏掉，代价不该是整站不可用。这里兜住：坏掉的那块给一个可读的提示 +「重试 / 回看板」，
// 其余部分照常。生产环境同样受益（后端返回意外形状、字段改名、老前端配新后端…都属于这一类）。

type Props = { children: ReactNode; label?: string }
type State = { err: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(err: Error): State {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // 留一条能查的记录：minified 栈本身没什么用，但组件栈能定位到是哪一块炸的
    console.error('[ErrorBoundary]', this.props.label ?? '', err, info.componentStack)
  }

  render() {
    const { err } = this.state
    if (!err) return this.props.children
    return (
      <div className="eb">
        <div className="eb__title">这一块出错了</div>
        <div className="eb__msg">{err.message || String(err)}</div>
        <div className="eb__hint">
          其余功能不受影响。如果反复出现，多半是后端返回的数据形状变了。
        </div>
        <div className="eb__acts">
          <button className="btn btn--sm btn--primary" onClick={() => this.setState({ err: null })}>重试</button>
          <button className="btn btn--sm btn--ghost" onClick={() => { window.location.href = '/' }}>回看板</button>
        </div>
      </div>
    )
  }
}
