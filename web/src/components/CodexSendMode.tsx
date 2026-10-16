import type { MessageBehavior } from '../types'

export function CodexSendMode({ value, onChange, steeringAvailable = true }: { value: MessageBehavior; onChange: (value: MessageBehavior) => void; steeringAvailable?: boolean }) {
  return <div className="composer__send-mode" role="group" aria-label="Codex 发送方式">
    <button type="button" disabled={!steeringAvailable} aria-pressed={value === 'steer'} onClick={() => onChange('steer')}>即时补充</button>
    <button type="button" aria-pressed={value === 'queue'} onClick={() => onChange('queue')}>排队任务</button>
    <span>{!steeringAvailable ? '即时补充待更新，消息暂按顺序排队' : value === 'queue' ? '当前任务结束后处理' : '运行中追加到当前任务'}</span>
  </div>
}
