import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

// 图片必须「点击才加载」的接线护栏（2026-09-11 事故）。
//
// ★ 为什么是读源码断言：本仓库没有 React 渲染测试基建，而**纯函数测试证明不了组件在用它**
//   （SessionDetail.resolveReleaseTarget 那次：7 条纯函数单测全绿，页面根本没接线）。
//   同 styles/layout.test.ts 与 SessionDetail.wiring.test.ts 的手法。
//
// ★★ 它守的不是"好看"，是**跨境链路不被单条会话吃光**：
//   两张截图 936 KB ÷ ~11 KB/s ≈ 87 秒独占链路 ⇒ /api/state 排队超时 ⇒「与服务器失联」。
//   一旦有人把 src 改回无条件绑定，这个故障会原样复现，而**功能看起来完全正常**
//   （图能显示、点击能放大）——只有在跨境链路上才暴露。这正是最难靠人工发现的那类回归。

const RAW = fs.readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8')

/**
 * ⚠️ **源码断言必须剥掉注释**，否则注释里引用的"反例"会让断言误报。
 *   实测：我在组件里写了事故说明，原话引用了 `<img src={url} loading="lazy">`，
 *   于是「不得再用 loading="lazy"」这条**在代码已经改对的情况下照样变红**。
 *   ★ 误报的护栏会被无视，然后某天真红了也没人信 —— 本仓库已有三次同族前科。
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SRC = stripComments(RAW)

describe('会话里的图片必须点击才加载', () => {
  it('★★ 缩略图的 src 必须是条件渲染，不能一进视口就拉全尺寸原图', () => {
    expect(SRC).toMatch(/opened\.has\(img\.url\)\s*\?/)
  })

  it('★ 不得再用 loading="lazy" 冒充懒加载', () => {
    // 原实现写着 `loading="lazy"` 且注释自称"懒加载缩略图"，但：
    //   ① lazy 只延迟到**进入视口**，滚到就拉；② 服务端根本没有缩略图，拉的是原图。
    // 注释里的词和代码做的事不是一回事 —— 这类误导比没注释更贵。
    expect(SRC).not.toMatch(/loading="lazy"/)
  })

  it('★ 占位符必须把代价写出来（体积 + 预计耗时），别让用户盲点', () => {
    expect(SRC).toMatch(/imageHint\(/)
    expect(SRC).toMatch(/from '\.\.\/lib\/image-cost'/)
  })

  it('★ 已加载状态要按 url 记，别用数组下标', () => {
    // 事件流会增量合并、按 seq upsert，下标会漂；url 是稳定键。
    expect(SRC).toMatch(/useState<Set<string>>/)
  })
})
