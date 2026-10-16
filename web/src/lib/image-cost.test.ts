import { describe, it, expect } from 'vitest'
import { fmtBytes, crossBorderSecs, imageHint } from './image-cost'

// 图片加载代价提示（2026-09-11 事故后加）。
//
// ★ 事故经过：用户打开 invest_data 一个含两张截图的会话，两张共 **936 KB**
//   （461,767 + 496,156 字节）。跨境隧道实测只有 **~11 KB/s** ⇒ 独占链路 ~87 秒。
//   期间 `/api/state`(54KB) 排在后面等不到 ⇒ 前端 20s 超时 abort ⇒ nginx 记 499
//   ⇒ 连续失败 ⇒ 弹「与服务器失联 71 秒」。实证是隧道 SSH 连接的
//   **Send-Q 从 192,632 涨到 655,548 字节**——那 936KB 全堵在发送队列里。
//   ⚠️ `ServerAliveInterval` 没触发重连，因为**保活是小包挤得过去**，大流量才塞死 ——
//   「控制通道活着、转发通道死了」。
//
// ★ 而原实现 `<img src={url} loading="lazy">` 的注释写的是「懒加载缩略图」，
//   实际上 ① `loading="lazy"` 只延迟到**进入视口**，滚到就拉；② 服务端**根本没有缩略图**，
//   拉的是全尺寸原图。**注释里的词和代码做的事不是一回事。**
//
// ⇒ 用户定的修法（B）：默认只画占位符，**点击才加载**。
//   而占位符必须说清代价 —— 服务端 `toWire` 早就在 images[] 里带了 `bytes`
//   （注释原话「供前端预留占位尺寸/显示体积」），一直没人用。
//   **让用户在点之前就知道要等多久**，比替他决定加载或不加载更好。

describe('fmtBytes', () => {
  it('按量级给人看得懂的单位', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(461767)).toBe('451 KB')      // 事故中那张图
    expect(fmtBytes(1048576)).toBe('1.0 MB')
    expect(fmtBytes(38225 * 1024)).toBe('37.3 MB')
  })
  it('拿不到大小时不瞎编', () => {
    expect(fmtBytes(undefined)).toBe('')
    expect(fmtBytes(null as unknown as number)).toBe('')
    expect(fmtBytes(NaN)).toBe('')
    expect(fmtBytes(-1)).toBe('')
  })
})

describe('crossBorderSecs', () => {
  it('按实测 ~11KB/s 估跨境耗时', () => {
    expect(crossBorderSecs(11 * 1024)).toBe(1)
    expect(crossBorderSecs(461767)).toBe(41)     // 事故中那张图，~41 秒
    expect(crossBorderSecs(957923)).toBe(85)     // 两张合计，与实测 ~87s 吻合
  })
  it('大小未知返回 null，不返回 0', () => {
    // ⚠️ 返回 0 会被渲染成「约 0 秒」，等于骗用户说"很快"——
    //    本仓库记过这条：`Number(null)===0` 把「读不到」变成「读到了 0」，而 0 往往正好是最坏值。
    expect(crossBorderSecs(undefined)).toBeNull()
    expect(crossBorderSecs(0)).toBeNull()
  })
})

describe('imageHint', () => {
  it('★ 有大小时，把体积和预计耗时都说出来', () => {
    expect(imageHint({ name: 'shot.png', bytes: 461767 })).toBe('shot.png · 451 KB · 约 41 秒')
  })
  it('★ 小图不吓唬人：预计 ≤3 秒就不提耗时', () => {
    expect(imageHint({ name: 'icon.png', bytes: 20 * 1024 })).toBe('icon.png · 20.0 KB')
  })
  it('大小未知时只给文件名，不编数字', () => {
    expect(imageHint({ name: 'x.png' })).toBe('x.png')
    expect(imageHint({ name: '', bytes: 461767 })).toBe('451 KB · 约 41 秒')
  })
})
