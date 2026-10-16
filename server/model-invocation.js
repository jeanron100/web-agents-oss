import { redactString } from './event-redaction.js'

// Only transport-owned fields cross this boundary. Never expose the raw response/config.
export function modelInvocation(body, { stage, requestedModel, secret = '', observedAt = Date.now() } = {}) {
  const clean = (value, size = 160) => {
    if (typeof value !== 'string') return null
    const safe = redactString(secret ? value.split(secret).join('***') : value)
    return (safe.length > size ? safe.slice(0, size - 1) + '…' : safe) || null
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  const meta = body?.metadata || {}, usage = body?.usage || {}
  const resolved = clean(meta.resolved_model) || clean(meta.model_selection?.selected_upstream_model)
  const reported = clean(body?.model)
  const warnings = [...(Array.isArray(meta.warnings) ? meta.warnings : []), ...(Array.isArray(body?.warnings) ? body.warnings : []), ...(typeof body?.warning === 'string' ? [body.warning] : [])]
  return {
    stage, observedAt, requestedModel: clean(requestedModel),
    actualModel: resolved && resolved !== 'auto' ? resolved : reported && reported !== 'auto' ? reported : null,
    provider: clean(meta.resolved_provider), requestId: clean(meta.request_id || body?.id),
    usage: {
      inputTokens: count(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
      totalTokens: count(usage.total_tokens),
      cachedInputTokens: count(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens),
      cacheCreationTokens: count(usage.prompt_tokens_details?.cache_creation_tokens),
      reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens),
    },
    warnings: warnings.slice(0, 8).map(w => typeof w === 'string' ? { detail: clean(w, 320) } : {
      code: clean(w?.code, 80), parameter: clean(w?.parameter, 80), policy: clean(w?.policy, 80), detail: clean(w?.detail || w?.message, 320),
    }).filter(w => w.detail || w.code || w.parameter),
    warningsTruncated: warnings.length > 8,
  }
}
