// 对 hub 的 HTTP 访问。fetch 由参数注入，便于单测不起真服务。
//
// 错误语义直接继承 server/forward-error.js 的结论（2026-07-18 手机审批连失败 6 次的产物）：
// **别把「我不知道」说成「失败了」**。超时只说明"我不等了"，不代表上游没做；
// 而把上游的 4xx 压平成一句 message 会吃掉 canForce 这类可操作字段，让调用方走进死胡同。

import { parseEnvNumber } from './wire.js'
import fs from 'node:fs'

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError'])

export function classifyError(e) {
  if (e && TIMEOUT_NAMES.has(e.name)) {
    // 这份措辞曾经是照抄"写操作超时"的话术（"该操作可能已生效……请勿重复提交"）。
    // 但 P1 这五个工具全部是只读查询（GET /api/state /api/pending /events），根本没有
    // "重复提交"这回事——对读来说，重试正是正确动作。indeterminate:true 仍然成立
    // （超时只说明"我没等到"，不代表 hub 真的挂了），但劝退重试对读类操作是纯负面建议。
    return {
      ok: false,
      indeterminate: true,
      message: '节点响应超时，结果未知（不代表 hub 出了问题）——这是只读查询，直接重试即可',
    }
  }
  if (e?.status >= 400 && e.status < 600) {
    // e.body 必须先展开、包装字段后写：上游 body 里若恰好带 ok/status/message 这几个
    // 键名（哪怕是巧合），后写的字段才能保证不被顶掉——否则一个真实的 409 可能被
    // 上游 body 里的 {ok:true} 悄悄翻成"成功"，调用方据此走错分支。
    return { ...(e.body ?? {}), ok: false, status: e.status, message: String(e.message ?? e) }
  }
  return { ok: false, message: String(e?.message ?? e) }
}

export function createHubClient({
  baseUrl = process.env.WA_MCP_HUB || 'http://127.0.0.1:8787',
  fetchImpl = fetch,
  timeoutMs = parseEnvNumber('WA_MCP_TIMEOUT_MS', 15_000),
} = {}) {
  const token=process.env.WA_MCP_TOKEN||(process.env.WA_MCP_TOKEN_FILE?fs.readFileSync(process.env.WA_MCP_TOKEN_FILE,'utf8').trim():'')
  async function get(path) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { signal: ctrl.signal, redirect:'error', ...(token?{headers:{Authorization:`Bearer ${token}`}}:{}) })
      if (!res.ok) {
        // 错误响应缺 body（或非 JSON）是意料之中——status code 本身就承载了意义，
        // 这里退化成 {} 是合理默认，上一层 classifyError 靠 err.status 兜底分类。
        const body = await res.json().catch(() => ({}))
        const err = new Error(body.error ?? `HTTP ${res.status}`)
        err.status = res.status
        err.body = body // 整体带上：可操作字段必须活着
        throw err
      }
      // 2xx 但 body 解析失败，绝不能退化成 {}——上一层（fleet_overview 等）会把
      // {} 当成"servers:[] pending:0"这类自信的空结果吐给 LLM，一句"集群空空如也"
      // 掩盖了真相"hub 说了什么我读不懂"。这是与"错误响应缺 body 时退化成 {}"
      // 完全相反的语义：那里状态码已经说明了失败，这里 2xx 本该有内容却读不出来，
      // 是"我不知道"，必须原样冒泡成异常，交给上层 classifyError 分类。
      try {
        return await res.json()
      } catch (parseErr) {
        const err = new Error(`hub 返回了 2xx 但 body 无法解析为 JSON：${parseErr.message}`)
        err.status = res.status
        err.cause = parseErr
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    getState: () => get('/api/state'),
    // since != null（而非真值判断）：游标 0 是合法值，与"未传"语义不同，不能被当假值吞掉
    getEvents: (id, since) => get(`/api/session/${encodeURIComponent(id)}/events${since != null ? `?since=${encodeURIComponent(since)}` : ''}`),
    getPending: () => get('/api/pending'),
    getProgress: (params = {}) => get(`/api/assistant/progress?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
    getTaskEvidence: id => get(`/api/assistant/evidence?id=${encodeURIComponent(id)}`),
    // 长程历史（history_search 用）：GET /api/v2/events，读 Mongo 持久投影——与 getEvents
    // （agent 内存/JSONL 的实时窗口）是两个互补的数据源，不是同一个端点的别名。
    // 这里只做参数拼接，不做语义判断（是否要收窄查询是 tools.js 的责任）；
    // 空/undefined 值一律不进 query string，避免 hub 端把 `session=` 空串当成"要按空会话过滤"。
    getHistory: (params = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      }
      const q = qs.toString()
      return get(`/api/v2/events${q ? `?${q}` : ''}`)
    },
  }
}
