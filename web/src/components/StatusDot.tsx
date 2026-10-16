import type { SessionState } from '../types'

export const stateLabel: Record<SessionState, string> = {
  running: '运行中',
  waiting_approval: '等待审批',
  waiting_input: '等待输入',
  idle: '空闲',
  done: '已完成',
  error: '错误',
}

export function StatusDot({ state }: { state: SessionState }) {
  return <span className={`dot dot--${state}`} />
}

export function StateText({ state }: { state: SessionState }) {
  return (
    <span className={`session-card__state state-text--${state}`}>
      <StatusDot state={state} />
      {stateLabel[state]}
    </span>
  )
}
