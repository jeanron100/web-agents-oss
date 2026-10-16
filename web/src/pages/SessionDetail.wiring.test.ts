import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 接线层护栏：**纯函数测试证明不了页面真的在调用它们**。
//
// 实测（2026-08-21）：把 SessionDetail 里的 `resolveReleaseTarget` / `pickSuccessorSession`
// 调用改回原来的裸实现，`store.test.ts` 的 7 条新用例**依然全绿**——它们测的是函数本身。
// 而死循环恰恰发生在接线处：函数写对了、页面没用它，等于没修。
//
// 这跟 `styles/layout.test.ts` 直接读 CSS 源码断言是同一种手法：当一条不变量落在
// 单测覆盖不到的接线层时，就直接对源码断言，别让它无人看守。
// （真浏览器断言闸 verify-ui.sh 覆盖不到这条：要触发它得先制造一个 error 态会话。）

const SRC = readFileSync(resolve(__dirname, './SessionDetail.tsx'), 'utf-8')

describe('出错会话清理：接线不得被改回裸实现', () => {
  it('★ release 后的跳转必须过 resolveReleaseTarget —— 不得盲信 realId', () => {
    expect(SRC).toContain('resolveReleaseTarget(')
    // 原实现的特征串：无条件跳 realId。它一旦回来，死循环的第一环就复活了。
    expect(SRC).not.toMatch(/navigate\(`\/session\/\$\{data\.realId\}`/)
  })

  it('★ 「会话不存在」挑后继必须过 pickSuccessorSession —— 不得跳进另一个 error 会话', () => {
    expect(SRC).toContain('pickSuccessorSession(')
    // 原实现的特征串：不看状态直接 find/兜底取第一条。
    expect(SRC).not.toMatch(/sameProject\.find\(\(s\) => s\.engine === meta\.engine\) \?\? sameProject\[0\]/)
  })
})

// ── 2026-09-22 用户实拍：审批卡在对话流里**根本没出现** ─────────────────────────────
//
// 现场：website_operator 的 Claude 会话 ps-mttknv9v-5885 处于 waiting_approval、
//   待办 act-muc44gxh-181 在 /api/state 里明明白白，而用户在页面上完全看不到审批卡，
//   是我告诉他有审批他才去查的。URL 是 `/session/session_28c90249-…`（一个 **6 天前的
//   Kimi 影子会话**），Tab 停在「Claude 对话流」。
//
// ★★ 根因：这几处渲染被 `isFlowCurrent` 挡着，而它的注释写的是
//     「当前会话是 Claude 时**恒真**」—— 那是个**未被满足的假设**。
//   URL 会话是 Kimi、Tab 看 Claude 时 isFlowCurrent === false ⇒ 审批卡与实时指示**被静默吞掉**。
//   而 flowApprovals/flowRunning/liveSecs/queueState **全部是按 flowSession 算的**，
//   它们描述的正是屏幕上那条流 ⇒ 用「URL 会话是谁」去闸它们，判据本身就错了。
//
// ★ 同一条教训在 composer 上**已经修过**（源码注释：「恒为当前流的会话……才能"恒可操作"
//   而不是在跨会话展示时隐藏成死胡同」），只是没推广到这里 —— 又一次「只落实一半」。
//
// ⚠️ 本文件的断言**必须先剥注释**：上面这段说明里引用了反例原文，
//   不剥的话会在代码已改对的情况下误报（我在 ChatMessage 那次踩过）。
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('跨会话展示时，属于"这条流"的东西不得被 URL 会话闸掉', () => {
  it('★★ 审批卡不得被 isFlowCurrent 挡住 —— 它已按 flowSession 过滤过了', () => {
    expect(CODE).not.toMatch(/isFlowCurrent\s*&&\s*flowApprovals/)
    expect(CODE).toMatch(/flowApprovals\.map/)   // 仍然是列表渲染，别退回 find()
  })

  it('★ 「正在执行 / N 秒」实时指示同理 —— 挡住它就等于让界面看起来卡死', () => {
    // 用户的原话是「感觉卡顿，而且老是不刷新」：指示被吞掉后，
    // 一条正在跑的流在屏幕上和一条死流完全一样。
    expect(CODE).not.toMatch(/isFlowCurrent\s*&&\s*flowRunning/)
  })

  it('★ 「处理中/排队中」角标同理（processingId/queuedIds 也来自 flowEvents）', () => {
    expect(CODE).not.toMatch(/if\s*\(!isFlowCurrent\)\s*return undefined/)
  })
})
