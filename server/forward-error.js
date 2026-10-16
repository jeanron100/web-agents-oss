// hub→agent 转发失败的线协议分类。纯函数（不碰 res/网络），单测见 forward-error.test.mjs。
//
// ⚠️ 别把「我不知道」说成「失败了」。
//
// 事故（2026-07-18 22:34–22:41）：用户在手机上连点 6 次审批全失败，报「审批未送达服务器，请重试」。
// 真相是请求**每次都送达了**：hub 的 forward() 固定 15s 超时，而 node-agent 当时事件循环被压住
// （同期 /events、/stream、/message 一起超时），15s 内没应答 → fetch 抛 AbortError → hub 兜底
// catch 压成 500 → 前端 guardWrite 见 !res.ok 就报「未送达」。而 resolveAction 本身是 O(1) 的
// 内存 Map 操作，agent 缓过来后极可能**真把审批落下了**——用户却被引导去重复提交。
// （总工绕过 hub 直连 :8788 就能批，正是因为 curl 没有那个 15s 上限，肯等。）
//
// 所以：超时 ⇒ 504 + indeterminate:true（结果未知，让前端靠下一轮 /api/state 轮询去核对，
// 而不是撺掇用户重放一个可能已生效的写操作）；上游明确的 4xx/5xx ⇒ 原样透传（连同 canForce
// 这类**可操作字段**，压平会把用户的出路吃掉）；其余才是 500。

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError'])

export function classifyForwardError(e) {
  // ① 超时/中止：hub 自己放弃了，不代表上游没做。措辞必须诚实——不许出现「未送达」。
  if (e && TIMEOUT_NAMES.has(e.name)) {
    return {
      status: 504,
      body: {
        error: '节点响应超时，该操作可能已生效（结果未知）——请勿重复提交，稍候以列表为准',
        indeterminate: true,
      },
    }
  }
  // ② 上游给了明确状态码：原样透传状态码 + 完整错误体（canForce 等可操作字段必须活着到前端）
  if (e?.status >= 400 && e.status < 600) {
    return { status: e.status, body: { error: String(e.message ?? e), ...(e.body ?? {}) } }
  }
  // ③ 其余：真·服务端错误
  return { status: 500, body: { error: String(e?.message ?? e) } }
}
