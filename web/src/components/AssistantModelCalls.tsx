export type AssistantModelCall = {
  stage: string; observedAt: number; requestedModel: string | null; actualModel: string | null; provider: string | null; requestId: string | null
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; cacheCreationTokens: number | null; reasoningTokens: number | null }
  warnings: Array<{ code?: string | null; parameter?: string | null; policy?: string | null; detail?: string | null }>; warningsTruncated?: boolean
}
const policy: Record<string, string> = { ignored: '已忽略', IGNORED_WITH_WARNING: '已忽略', EMULATED: '由网关模拟', UNSUPPORTED: '不支持', TRANSLATED: '已转换' }
const tokens = (value: number | null | undefined) => value == null ? '未返回' : value.toLocaleString('zh-CN')

export function AssistantModelCalls({ calls }: { calls?: AssistantModelCall[] }) {
  if (!calls?.length) return null
  return <section className="assistant-model-calls" aria-label="问答模型调用">
    <h3>本次问答模型调用</h3>
    {calls.map((call, index) => <article key={`${call.stage}-${index}`}>
      <p><strong>{call.stage === 'plan' ? '规划' : '归纳'}</strong> · 实际模型：{call.actualModel || '未返回'}{call.provider ? ` · ${call.provider}` : ''}</p>
      <p className="muted">Token · 输入 {tokens(call.usage?.inputTokens)} · 输出 {tokens(call.usage?.outputTokens)} · 合计 {tokens(call.usage?.totalTokens)}</p>
      {call.warnings?.map((warning, i) => <p className="assistant-model-calls__warning" role="note" key={i}>兼容告警：{[warning.parameter, warning.policy ? policy[warning.policy] || warning.policy : '', warning.code, warning.detail].filter(Boolean).join(' · ')}</p>)}
      {call.warningsTruncated && <p className="muted">告警过多，当前仅展示部分。</p>}
      <details><summary>调用详情</summary>
        <p>请求模型：{call.requestedModel || '未返回'} · 实际模型：{call.actualModel || '未返回'}</p>
        <p>缓存读取 {tokens(call.usage?.cachedInputTokens)} · 缓存写入 {tokens(call.usage?.cacheCreationTokens)} · 推理 {tokens(call.usage?.reasoningTokens)}</p>
        {call.requestId && <p>请求标识：{call.requestId}</p>}
        <p>调用时间：{new Date(call.observedAt).toLocaleString('zh-CN', { hour12: false })}。此处为该次调用的网关返回值；查看同一回答不会重复计量。</p>
      </details>
    </article>)}
  </section>
}
