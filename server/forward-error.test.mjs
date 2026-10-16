// node --test server/forward-error.test.mjs
//
// hub→agent 转发失败的**线协议分类**（纯函数）。
//
// 这条防线来自一次真实事故（2026-07-18 22:34–22:41，用户手机连点 6 次审批全失败）：
// hub 的 forward() 固定 15s 超时，node-agent 事件循环被压住没能在 15s 内应答 →
// fetch 抛 AbortError → hub 的兜底 catch 一律压成 **500 "This operation was aborted"** →
// 前端 guardWrite 见 !res.ok 就报「审批未送达服务器，请重试」。
//
// 那句话是**假的**：请求早就送达了 agent，只是 hub 自己不等了；agent 很可能在 hub 放弃之后
// 才把审批真正落下。于是用户被引导去重复提交一个**可能已经生效**的审批。
// nginx 日志铁证：23 条 POST /api/action 全是 500（不是 404/409），49 字节响应体正好等于
// {"error":"This operation was aborted"}；journald 里 22 次 AbortError 栈顶就是 /api/action 那行。
//
// 分类原则：**别把「我不知道」说成「失败了」**。超时=结果未知(504+indeterminate)，
// 上游明确拒绝=原样透传，其余才是 500。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyForwardError } from './forward-error.js'

// undici 在 AbortSignal 触发时抛的就是这个形状（name=AbortError）
const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
const upstreamErr = (status, body) => Object.assign(new Error(body.error ?? `HTTP ${status}`), { status, body })

test('超时/中止 → 504 + indeterminate，且不得自称「未送达」', () => {
  const out = classifyForwardError(abortErr())
  assert.equal(out.status, 504)
  assert.equal(out.body.indeterminate, true)
  // 事故复盘的核心断言：文案不能宣称请求没送达
  assert.ok(!/未送达/.test(out.body.error), `504 文案不得含「未送达」，实际：${out.body.error}`)
})

test('AbortError 变体：DOMException 风格（无 message、只有 name）也识别为超时', () => {
  const e = new Error('')
  e.name = 'AbortError'
  assert.equal(classifyForwardError(e).status, 504)
})

test('TimeoutError（AbortSignal.timeout 的形状）同样归为 504', () => {
  const e = new Error('The operation was aborted due to timeout')
  e.name = 'TimeoutError'
  assert.equal(classifyForwardError(e).status, 504)
})

test('上游 409 原样透传，且保住可操作字段（canForce）', () => {
  const out = classifyForwardError(upstreamErr(409, { error: '该会话正在终端中运行，暂不可接管', canForce: true }))
  assert.equal(out.status, 409)
  assert.equal(out.body.error, '该会话正在终端中运行，暂不可接管')
  // 这个字段是用户唯一的出路，压平就等于把人堵死（hub.js fetchJson 注释里记的旧事故）
  assert.equal(out.body.canForce, true)
  assert.notEqual(out.body.indeterminate, true) // 明确的拒绝不是「结果未知」
})

test('上游 409「待办不存在或已处理」透传，不被误报成超时', () => {
  const out = classifyForwardError(upstreamErr(409, { error: '待办不存在或已处理' }))
  assert.equal(out.status, 409)
  assert.equal(out.body.error, '待办不存在或已处理')
})

test('其余异常仍是 500，且带上 message', () => {
  const out = classifyForwardError(new TypeError('cannot read x of null'))
  assert.equal(out.status, 500)
  assert.match(out.body.error, /cannot read x of null/)
  assert.notEqual(out.body.indeterminate, true)
})

test('上游状态码越界（<400 或 >=600）不当作透传，落回 500', () => {
  assert.equal(classifyForwardError(Object.assign(new Error('x'), { status: 302 })).status, 500)
  assert.equal(classifyForwardError(Object.assign(new Error('x'), { status: 700 })).status, 500)
})
