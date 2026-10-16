// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scrollTopOf } from '../components/PullRefresh'

// 布局护栏 —— 盯着一个「修好过、又被改回去、又复发」的 bug。
//
// 底栏漂到屏幕中间：2026-07-10 修过一次（去掉 backdrop-filter），2026-07-13 复发。
// 根因是 iOS/WebKit 把 position:fixed 元素并进滚动合成层。这个 bug **chromium 复现不出**，
// 所以没有任何浏览器测试能守住它——只能在**源码层面**把危险构造禁掉。
//
// 一句话：底栏不许是 fixed。它是 app-shell flex column 里的流内元素，没有"漂"的自由度。
//
// 注：这里必须用 node:fs 读源文件，不能 `import css from './global.css?raw'`
// —— vitest 的 CSS 插件会把它吞成空字符串，测试会"全过"但其实什么都没检查。

const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8')

/** 取某个选择器的规则体（只取顶层第一处定义，不含媒体查询里的覆写）。 */
function ruleBody(selector: string): string {
  const i = css.indexOf(`\n${selector} {`)
  expect(i, `找不到选择器 ${selector}`).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf('}', i))
}

describe('移动端底栏：绝不可回退成 position: fixed', () => {
  it('.tabbar 不是 fixed —— 这是那个「漂到屏幕中间」bug 的唯一结构性防线', () => {
    const body = ruleBody('.tabbar')
    expect(body, '.tabbar 一旦变回 position:fixed，iOS 上就会重新漂走（且 chromium 测不出来）').not.toMatch(/position:\s*fixed/)
  })

  it('.tabbar 上没有 backdrop-filter / transform / will-change（合成层触发器）', () => {
    const body = ruleBody('.tabbar')
    expect(body).not.toMatch(/backdrop-filter/)
    expect(body).not.toMatch(/transform:/)
    expect(body).not.toMatch(/will-change/)
  })

  it('内容区是唯一滚动容器（底栏靠它才能待在底下）', () => {
    expect(css).toMatch(/\.shell--tabs\s*\{[^}]*height:\s*100dvh/s)
    expect(css).toMatch(/\.shell--tabs\s*\{[^}]*overflow:\s*hidden/s)
    const main = css.slice(css.indexOf('.shell--tabs .shell__main'))
    expect(main.slice(0, main.indexOf('}'))).toMatch(/overflow-y:\s*auto/)
    // min-height:0 少一条，flex 子项就会被内容撑破、外壳照样滚动、底栏照样被推走
    expect(main.slice(0, main.indexOf('}'))).toMatch(/min-height:\s*0/)
  })
})

describe('scrollTopOf：两种滚动模型都要成立', () => {
  const mk = (overflowY: string, scrollTop: number, scrollable: boolean) => {
    const el = document.createElement('div')
    el.style.overflowY = overflowY
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: scrollable ? 999 : 10, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 10, configurable: true })
    return el
  }

  it('找得到真正的滚动祖先（app-shell 模型）', () => {
    const scroller = mk('auto', 300, true)
    const child = document.createElement('div')
    scroller.appendChild(child)
    expect(scrollTopOf(child)).toBe(300)
  })

  it('祖先没有滚动容器时退回 window.scrollY（沉浸页 / 桌面的 body 滚动模型）', () => {
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true })
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    expect(scrollTopOf(plain)).toBe(120)
  })

  it('overflow:auto 但内容没溢出 ⇒ 不算滚动容器（否则会误判"已在顶部"）', () => {
    Object.defineProperty(window, 'scrollY', { value: 55, configurable: true })
    const notScrollable = mk('auto', 0, false)
    const child = document.createElement('div')
    notScrollable.appendChild(child)
    document.body.appendChild(notScrollable)
    expect(scrollTopOf(child)).toBe(55)
  })
})

describe('代码高亮层：只许改颜色（两层编辑器的生死线）', () => {
  // react-simple-code-editor = 透明 textarea 逐像素叠在高亮 pre 上。
  // 高亮层只要有一个 token 改了 font-size/padding/white-space，两层换行点就不同 → 文字互相压盖。
  // 真实事故：应用类 `.code-block`（审批详情的命令框）与 **Prism markdown 的 code-block token 同名**，
  // 打开任何 .md 文件就把高亮层撑歪。Prism 的 token 名全是常见词，撞车只是时间问题。

  it('存在防御性重置：编辑器里的 .token 不得带 padding/背景/字号', () => {
    const i = css.indexOf('.file-editor__area .token')
    expect(i, '重置规则被删了——任何和 Prism token 同名的应用类都会再次把两层撑歪').toBeGreaterThan(-1)
    const rule = css.slice(i, css.indexOf('}', i))
    for (const prop of ['font: inherit', 'white-space: inherit', 'padding: 0', 'background: none', 'display: inline']) {
      expect(rule, `重置缺了 ${prop}`).toContain(prop)
    }
  })

  it('没有裸的 .code-block 应用类（Prism 的 token 就叫这个名字）', () => {
    expect(css).not.toMatch(/^\.code-block\s*\{/m)
  })

  it('应用类名不得与 Prism token 名撞车', () => {
    // 只查顶层裸类选择器（`.xxx {`），Prism 的 token 名是极常见的词
    const PRISM_TOKENS = ['code', 'code-block', 'string', 'keyword', 'function', 'comment',
      'number', 'operator', 'punctuation', 'variable', 'property', 'tag', 'url', 'bold', 'title']
    const collisions = PRISM_TOKENS.filter((t) => new RegExp(`^\\.${t}\\s*\\{`, 'm').test(css))
    expect(collisions, `这些应用类名和 Prism token 同名，会污染高亮层：${collisions.join(', ')}`).toEqual([])
  })
})
