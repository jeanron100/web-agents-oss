import type { ReactNode } from 'react'

// 轻量 markdown 渲染：零依赖、全部用 React 节点输出（天然防 XSS，不用 dangerouslySetInnerHTML）。
// 覆盖对话常见语法：围栏代码块 ```、表格、行内 `code`、**粗体**、*斜体*/_斜体_、# 标题、
// - / 1. 列表、[文本](链接)、段落与空行。其余复杂语法原样降级为文本。

let seq = 0
const k = () => `md${seq++}`

// 文件/相对路径链接的点击回调（由 Markdown() 在同步渲染期间设置，供 inline() 读取）。
// 同步渲染、单线程 JS，模块级暂存安全。null=无查看器(如复盘页)→退回新标签页行为。
let onFileLinkCb: ((href: string) => void) | null = null
const isExternal = (h: string) => /^(https?:)?\/\//i.test(h) || h.startsWith('mailto:')

/** 行内标记：代码 / 粗体 / 斜体 / 链接 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(<code key={k()} className="md-code">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={k()}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('[')) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)
      if (mm) {
        const href = mm[2]
        if (isExternal(href) || href.startsWith('#')) {
          out.push(<a key={k()} href={href} target="_blank" rel="noreferrer">{mm[1]}</a>)
        } else if (onFileLinkCb) {
          // 文件/相对路径：浏览器导航会被 SPA 当路由 → 404；改为在会话内文件查看器打开
          const cb = onFileLinkCb
          out.push(<a key={k()} className="md-filelink" href={href} onClick={(e) => { e.preventDefault(); cb(href) }}>{mm[1]}</a>)
        } else {
          out.push(<a key={k()} href={href} target="_blank" rel="noreferrer">{mm[1]}</a>)
        }
      } else out.push(tok)
    } else out.push(<em key={k()}>{tok.replace(/^[*_]/, '').replace(/[*_]$/, '')}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isTableSep = (s: string) => /-/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s)
const splitRow = (s: string) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

export function Markdown({ text, onFileLink }: { text: string; onFileLink?: (href: string) => void }) {
  onFileLinkCb = onFileLink ?? null
  // 每次渲染从 0 重新计数：相同文本 → 相同 key 序列，React 就地复用而非卸载重挂。
  // 否则（模块级计数器只增不减）相同内容每次渲染 key 都变，整棵子树被重挂，
  // 用户在对话里选中的文字会被 3s 轮询/1s 时钟的重渲染清空（看似“页面刷新”）。
  // 同步、单线程渲染下，Markdown() 一次调用内计数原子完成，多实例互不干扰。
  seq = 0
  const blocks: ReactNode[] = []
  // 用 ``` 切段：偶数段=普通文本，奇数段=代码块
  const parts = (text ?? '').split('```')
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n')
      const code = nl >= 0 ? part.slice(nl + 1) : part // 首行是语言名则丢弃
      blocks.push(<pre key={k()} className="md-pre"><code>{code.replace(/\n$/, '')}</code></pre>)
      return
    }
    const lines = part.split('\n')
    let para: string[] = []
    let listItems: string[] = []
    let listOrdered = false
    let inList = false
    const flushPara = () => {
      if (para.length) { blocks.push(<p key={k()} className="md-p">{inline(para.join(' '))}</p>); para = [] }
    }
    const flushList = () => {
      if (!inList) return
      const items = listItems.map((it) => <li key={k()}>{inline(it)}</li>)
      blocks.push(listOrdered ? <ol key={k()} className="md-list">{items}</ol> : <ul key={k()} className="md-list">{items}</ul>)
      listItems = []; inList = false
    }
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li]
      // 表格：当前行含 |，下一行是分隔行（---）
      if (ln.includes('|') && li + 1 < lines.length && isTableSep(lines[li + 1])) {
        flushPara(); flushList()
        const header = splitRow(ln)
        // 行吸收判据（2026-08-02）：曾经是「只要 includes('|') 就算一行」，于是散文、
        // 流式传到一半的半截行都会被吞进表格，渲染出只有一个反引号的空残行（用户实拍）。
        // 原文没留下、复现不了，故不猜触发串——改成结构性约束，让这类输入根本进不来：
        //   ① 跟随表头风格：表头带边界竖线，行也必须带（纯字符层面区分不了
        //      「3 | 4」和「这句话里有 a|b 竖线」，靠风格一致性才能）
        //   ② 单元格数必须与表头一致（半截行天然对不上）
        //   ③ 整行全空的直接丢弃
        const bordered = /^\s*\|/.test(ln) || /\|\s*$/.test(ln)
        const isTableRow = (s: string): boolean => {
          const t = s.trim()
          if (!t.includes('|')) return false
          if (bordered && !(t.startsWith('|') || t.endsWith('|'))) return false
          const cells = splitRow(s)
          return cells.length === header.length && cells.some((c) => c !== '')
        }
        const rows: string[][] = []
        li += 2
        while (li < lines.length && isTableRow(lines[li])) { rows.push(splitRow(lines[li])); li++ }
        li-- // 回退一格，外层 for 会 ++
        blocks.push(
          <div key={k()} className="md-table-wrap">
            <table className="md-table">
              <thead><tr>{header.map((c) => <th key={k()}>{inline(c)}</th>)}</tr></thead>
              <tbody>{rows.map((r) => <tr key={k()}>{r.map((c) => <td key={k()}>{inline(c)}</td>)}</tr>)}</tbody>
            </table>
          </div>,
        )
        continue
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(ln)
      const ul = /^\s*[-*]\s+(.*)$/.exec(ln)
      const ol = /^\s*\d+\.\s+(.*)$/.exec(ln)
      if (h) { flushPara(); flushList(); blocks.push(<div key={k()} className={`md-h md-h${h[1].length}`}>{inline(h[2])}</div>) }
      else if (ul) { flushPara(); if (inList && listOrdered) flushList(); inList = true; listOrdered = false; listItems.push(ul[1]) }
      else if (ol) { flushPara(); if (inList && !listOrdered) flushList(); inList = true; listOrdered = true; listItems.push(ol[1]) }
      else if (ln.trim() === '') { flushPara(); flushList() }
      else { flushList(); para.push(ln) }
    }
    flushPara(); flushList()
  })
  return <>{blocks}</>
}
