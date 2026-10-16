// server/archive-search.js — 检索层（openspec change: execution-history-archive，P1）
//
// 纯函数：在抽取好的会话视图上做**结构化过滤 + 关键词**，并按相关度/时间排序。
//
// ★ 结构化优先（design D8）：「哪个项目跑过这条命令」「谁改过这个文件」覆盖大部分真实场景，
//   成本最低、确定性最强。中文全文在 Mongo/MySQL 上都很弱，语义检索最贵——
//   **先把这一层做扎实，再看真实查询长什么样决定要不要上向量。**
//
// ★ 这一层必须**独立可用**：全文/语义都没就位时它也能交付价值（GOAL B 表）。
//
// ⚠️ 结果里**绝不夹带原文全文**：跨境链路实测 ~11 KB/s，首屏预算只有 15 KB gzip
//   （GOAL C 表）。检索结果只给坐标 + 摘要片段，原文按需再取。

/** 中英混合：按空白切；中文不做分词，靠子串匹配（BGE 那层才做语义）。 */
export function tokenize(q) {
  return String(q ?? '').trim().split(/\s+/).filter(Boolean)
}

const hay = (d) => [
  d.firstPrompt, d.project, d.session, d.model,
  ...(d.files ?? []),
  ...(d.commands ?? []).map((c) => c.cmd),
  ...(d.texts ?? []),
].join('\n').toLowerCase()

/** 相关度：提问命中最重（用户回忆的通常正是自己当初问的话），其次文件/命令，最后正文。 */
function score(d, toks) {
  let s = 0
  const p = String(d.firstPrompt ?? '').toLowerCase()
  const f = (d.files ?? []).join(' ').toLowerCase()
  const c = (d.commands ?? []).map((x) => x.cmd).join(' ').toLowerCase()
  const t = (d.texts ?? []).join(' ').toLowerCase()
  const proj = String(d.project ?? '').toLowerCase()
  for (const tk of toks) {
    const k = tk.toLowerCase()
    if (p.includes(k)) s += 10
    if (proj.includes(k)) s += 6
    if (f.includes(k)) s += 5
    if (c.includes(k)) s += 4
    if (t.includes(k)) s += 1
  }
  return s
}


/** 单条片段最长；再长就看不完，还白占跨境字节。 */
const SNIP_LEN = 200
/** 每条结果最多几段。 */
const SNIP_MAX = 3

/**
 * 从一段文本里切出**含关键词的片段**（带前后文）。
 *
 * ★★ 为什么必须有这个（2026-08-31 用户实测反馈）：
 *   用户搜自己问过的一句话，界面显示「命中 1」，但卡片上是那条会话的**开场白**，
 *   与搜索词毫无关系 ⇒ 看起来像匹配错了，**其实是匹配对了但没给他看**。
 *   **看不懂的命中，召回率再高也没用。**
 */
function cut(text, toks, from) {
  const t = String(text ?? '')
  const low = t.toLowerCase()
  let at = -1
  const found = []
  for (const tk of toks) {
    const i = low.indexOf(tk.toLowerCase())
    if (i >= 0) { found.push(tk); if (at < 0 || i < at) at = i }
  }
  if (at < 0) return null
  // 关键词居中，前后各留一半——只给关键词本身看不懂，必须带上下文
  const pad = Math.floor((SNIP_LEN - 20) / 2)
  const start = Math.max(0, at - pad)
  const end = Math.min(t.length, start + SNIP_LEN)
  return {
    from,
    text: (start > 0 ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : ''),
    hits: found,
  }
}

/** 按「提问 > 命令 > 文件 > 正文」的顺序找片段，最多 SNIP_MAX 段。 */
function snippetsFor(d, toks) {
  if (!toks.length) return []
  const out = []
  const push = (v) => { if (v && out.length < SNIP_MAX) out.push(v) }
  push(cut(d.firstPrompt, toks, 'prompt'))
  for (const c of d.commands ?? []) { if (out.length >= SNIP_MAX) break; push(cut(c.cmd, toks, 'command')) }
  for (const f of d.files ?? []) { if (out.length >= SNIP_MAX) break; push(cut(f, toks, 'file')) }
  for (const t of d.texts ?? []) { if (out.length >= SNIP_MAX) break; push(cut(t, toks, 'text')) }
  return out
}

/**
 * @param docs 抽取好的会话视图（archive-extract#extractSession 的产物）
 * @param f    { q, project, host, engine, cmd, file, from, to }
 * @param opts { limit }
 */
export function searchSessions(docs, f = {}, { limit = 50 } = {}) {
  const toks = tokenize(f.q)
  const lc = (v) => String(v ?? '').toLowerCase()
  const matched = []

  for (const d of docs ?? []) {
    if (f.project && !lc(d.project).includes(lc(f.project))) continue
    if (f.host && !lc(d.host).includes(lc(f.host))) continue
    if (f.engine && lc(d.engine) !== lc(f.engine)) continue
    if (f.cmd && !(d.commands ?? []).some((c) => lc(c.cmd).includes(lc(f.cmd)))) continue
    if (f.file && !(d.files ?? []).some((x) => lc(x).includes(lc(f.file)))) continue
    if (f.from && !(Number(d.lastAt) >= Number(f.from))) continue
    if (f.to && !(Number(d.startedAt) <= Number(f.to))) continue
    // ★ 多词是 **AND**：否则搜「净值 曲线」会把只含"曲线"的一堆不相关会话也捞回来
    if (toks.length) {
      const h = hay(d)
      if (!toks.every((tk) => h.includes(tk.toLowerCase()))) continue
    }
    matched.push(d)
  }

  matched.sort((a, b) => {
    if (toks.length) {
      const ds = score(b, toks) - score(a, toks)
      if (ds) return ds
    }
    return Number(b.lastAt || 0) - Number(a.lastAt || 0)
  })

  return {
    total: matched.length,
    // ⚠️ 只出坐标 + 轻量摘要，**不带原文行**（首屏字节是硬指标）
    hits: matched.slice(0, limit).map((d) => ({
      host: d.host, project: d.project, session: d.session, engine: d.engine,
      startedAt: d.startedAt, lastAt: d.lastAt, model: d.model, tokens: d.tokens,
      firstPrompt: String(d.firstPrompt ?? '').slice(0, 160),
      files: (d.files ?? []).slice(0, 4).map((x) => x.split('/').slice(-2).join('/')),
      commands: (d.commands ?? []).slice(0, 3).map((c) => c.cmd.slice(0, 90)),
      // ★★ 匹配片段：没有它，"命中 N" 对用户等于噪声——他既判断不了这条是不是要找的，
      //    也判断不了系统是不是坏的（2026-08-31 用户实测反馈）。
      snippets: snippetsFor(d, toks),
    })),
  }
}
