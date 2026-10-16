import { describe, it, expect } from 'vitest'
import { Markdown } from './Markdown'

// 递归收集 React 元素树里的所有 key（用于校验跨次渲染的 key 稳定性）
function collectKeys(node: unknown, out: (string | null)[]): void {
  if (Array.isArray(node)) { node.forEach((n) => collectKeys(n, out)); return }
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const el = node as { key: string | null; props?: { children?: unknown } }
    out.push(el.key)
    collectKeys(el.props?.children, out)
  }
}

// 回归：Markdown 曾用「模块级永不归零的计数器」生成 key，导致相同文本每次渲染 key 都不同，
// React 无法就地复用 → 整棵 markdown 子树每次重渲染都卸载重挂 → 用户选中的文字被清空（看似“页面刷新”）。
// 修复后：相同文本连续渲染必须产生完全一致的 key 序列，React 才能就地复用、保住文本选区。
describe('Markdown key 稳定性', () => {
  it('相同文本两次渲染产生一致的 key 序列', () => {
    const text = '# 标题\n\n一段 **加粗** 与 `代码` 以及 [链接](https://example.com)。\n\n- 项 1\n- 项 2\n\n```js\nconst a = 1\n```'
    const a: (string | null)[] = []
    const b: (string | null)[] = []
    collectKeys((Markdown({ text }) as { props: { children: unknown } }).props.children, a)
    collectKeys((Markdown({ text }) as { props: { children: unknown } }).props.children, b)
    expect(a.length).toBeGreaterThan(3)
    expect(b).toEqual(a)
  })
})

// 数出渲染结果里 tbody 的 <tr> 条数（表头不算）
function countRows(text: string): number {
  const found: unknown[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n && typeof n === 'object' && 'props' in (n as Record<string, unknown>)) {
      const el = n as { type?: unknown; props?: { children?: unknown } }
      if (el.type === 'tbody') { const c = el.props?.children; found.push(...(Array.isArray(c) ? c : [c]).filter(Boolean)); return }
      walk(el.props?.children)
    }
  }
  walk((Markdown({ text }) as { props: { children: unknown } }).props.children)
  return found.length
}

// ── 流式残行（2026-08-02 用户截图：表格尾部多出一行、里面只有一个反引号）──
// 根因：表格行吸收条件曾是「后续行只要 includes('|') 就算一行」，于是散文、代码围栏、
// 以及**流式传到一半的半截行**都会被吞进表格。当时的原文没留下、复现不了，
// 故不猜触发串，改为结构性约束：真表格行必然以 | 开头或结尾。
describe('表格：不吞非表格行', () => {
  const T = '| A | B |\n|---|---|\n| 1 | 2 |\n'

  it('散文里带竖线不算表格行', () => {
    const md = T + '这句话里有 a|b 竖线，但它是正文\n'
    const rows = countRows(md)
    expect(rows).toBe(1)
  })

  it('★ 半截行/杂散字符不产生空行（用户实拍的反引号残行）', () => {
    expect(countRows(T + '`\n')).toBe(1)
    expect(countRows(T + '|`\n')).toBe(1)   // 半截行：有竖线但无内容
    expect(countRows(T + '|  |\n')).toBe(1) // 全空单元格
  })

  it('代码围栏紧跟表格不被吞', () => {
    expect(countRows(T + '```bash\necho "x | y"\n```\n')).toBe(1)
  })

  it('正常的后续行仍然要收进来（防止修过头）', () => {
    expect(countRows(T + '| 3 | 4 |\n')).toBe(2)
    // 无边界竖线的行只在**表头也无边界**时才收——判据跟随表头风格。
    // 纯字符层面无法把「3 | 4」和「这句话里有 a|b 竖线」区分开，靠风格一致性才能。
    expect(countRows('A | B\n---|---\n1 | 2\n3 | 4\n')).toBe(2)
  })
})
