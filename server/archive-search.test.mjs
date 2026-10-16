// 检索层的回归测试（openspec change: execution-history-archive，P1）。
//
// GOAL.md 的 B 表：结构化过滤必须**独立可用**（不依赖全文/语义就位），
// 每条结果 **100% 可溯源**，「从想查到查到」≤ 30 秒。
//
// ★ 为什么结构化优先（design D8）：「哪个项目跑过这条命令」「谁改过这个文件」
//   覆盖大部分真实场景，成本最低、确定性最强；中文全文在 Mongo/MySQL 上都很弱。

import test from 'node:test'
import assert from 'node:assert/strict'
import { searchSessions, tokenize } from './archive-search.js'

const doc = (over = {}) => ({
  host: 'srv-178-232', project: '-data-web-agents', session: 's1', engine: 'claude',
  firstPrompt: '修复对话流加载慢的问题', model: 'claude-opus-5', tokens: 1000,
  startedAt: Date.parse('2026-08-20T10:00:00Z'), lastAt: Date.parse('2026-08-20T12:00:00Z'),
  commands: [{ cmd: 'npm run build', n: 2 }], files: ['/data/web_agents/server/hub.js'],
  texts: ['先分段计时定位瓶颈'],
  ...over,
})

const corpus = [
  doc(),
  doc({ session: 's2', project: '-data-invest-data', firstPrompt: '给净值曲线加涨跌', engine: 'codex',
        commands: [{ cmd: 'npx next build', n: 5 }], files: ['/data/invest_data/src/chart.tsx'],
        texts: ['把价格换成右轴'],
        startedAt: Date.parse('2026-08-21T01:00:00Z'), lastAt: Date.parse('2026-08-21T03:00:00Z') }),
  doc({ session: 's3', host: 'srv-177-188', project: '-data-doc-center', firstPrompt: '把 KB 同步脚本跑一遍',
        engine: 'kimi', commands: [], files: ['/data/doc_center/sync.py'], texts: ['先检查连通性'],
        startedAt: Date.parse('2026-08-22T05:00:00Z'), lastAt: Date.parse('2026-08-22T06:00:00Z') }),
]

// ───────────────── 结构化过滤（必须独立可用）─────────────────

test('★ 按项目过滤', () => {
  const r = searchSessions(corpus, { project: 'invest' })
  assert.deepEqual(r.hits.map((h) => h.session), ['s2'])
})

test('★ 按机器 / 引擎过滤', () => {
  assert.deepEqual(searchSessions(corpus, { host: 'srv-177-188' }).hits.map((h) => h.session), ['s3'])
  assert.deepEqual(searchSessions(corpus, { engine: 'codex' }).hits.map((h) => h.session), ['s2'])
})

test('★★ 按命令检索 —— 「哪个项目跑过这条命令」是最高频的真实问题', () => {
  const r = searchSessions(corpus, { cmd: 'next build' })
  assert.deepEqual(r.hits.map((h) => h.session), ['s2'])
})

test('★★ 按文件检索 —— 「谁改过这个文件」同样高频', () => {
  assert.deepEqual(searchSessions(corpus, { file: 'hub.js' }).hits.map((h) => h.session), ['s1'])
  assert.deepEqual(searchSessions(corpus, { file: 'sync.py' }).hits.map((h) => h.session), ['s3'])
})

test('★ 按时间窗过滤', () => {
  const r = searchSessions(corpus, { from: Date.parse('2026-08-21T00:00:00Z') })
  assert.deepEqual(r.hits.map((h) => h.session).sort(), ['s2', 's3'])
})

test('多条件是**与**关系', () => {
  assert.equal(searchSessions(corpus, { engine: 'codex', project: 'web-agents' }).hits.length, 0)
})

// ───────────────── 关键词 ─────────────────

test('★ 中文关键词能命中提问', () => {
  assert.deepEqual(searchSessions(corpus, { q: '净值曲线' }).hits.map((h) => h.session), ['s2'])
})

test('★ 关键词同时覆盖提问、命令、文件、要点 —— 用户记得什么就能用什么找', () => {
  assert.deepEqual(searchSessions(corpus, { q: 'chart.tsx' }).hits.map((h) => h.session), ['s2'])
  assert.deepEqual(searchSessions(corpus, { q: '分段计时' }).hits.map((h) => h.session), ['s1'])
})

test('★ 多词按**全部命中**收敛（AND），否则搜"净值 曲线"会把不相关的也捞回来', () => {
  assert.equal(searchSessions(corpus, { q: '净值 涨跌' }).hits.length, 1)
  assert.equal(searchSessions(corpus, { q: '净值 不存在的词' }).hits.length, 0)
})

// ───────────────── 溯源与排序 ─────────────────

test('★★ 每条结果必须带完整坐标 —— GOAL 的硬指标：可溯源率 100%', () => {
  for (const h of searchSessions(corpus, {}).hits) {
    for (const k of ['host', 'project', 'session', 'engine', 'startedAt', 'lastAt']) {
      assert.ok(h[k] !== undefined && h[k] !== '', `缺坐标 ${k}: ${JSON.stringify(h)}`)
    }
  }
})

test('★ 默认按最近活跃倒序 —— 找"上次怎么解的"通常是找最近那次', () => {
  assert.deepEqual(searchSessions(corpus, {}).hits.map((h) => h.session), ['s3', 's2', 's1'])
})

test('★ 有关键词时按相关度排序，提问命中权重高于要点', () => {
  const c = [
    doc({ session: 'a', firstPrompt: '无关', texts: ['缓存穿透的处理'] }),
    doc({ session: 'b', firstPrompt: '缓存穿透怎么处理', texts: [] }),
  ]
  assert.equal(searchSessions(c, { q: '缓存穿透' }).hits[0].session, 'b')
})

test('★ 结果封顶且如实报总数 —— 跨境链路上一次不能吐几千条', () => {
  const many = Array.from({ length: 500 }, (_, i) => doc({ session: `s${i}` }))
  const r = searchSessions(many, {}, { limit: 20 })
  assert.equal(r.hits.length, 20)
  assert.equal(r.total, 500)
})

test('★ 结果里不得夹带原文全文 —— 首屏字节是 GOAL C 表的硬指标（≤15KB gzip）', () => {
  const r = searchSessions(corpus, {}, { limit: 20 })
  const bytes = Buffer.byteLength(JSON.stringify(r))
  assert.ok(bytes < 4000, `3 条结果就 ${bytes} B，500 条会撑爆首屏`)
  assert.equal(r.hits[0].lines, undefined, '不得把原文行塞进检索结果')
})

test('空条件返回全部（按时间倒序），不抛', () => {
  assert.equal(searchSessions(corpus, {}).total, 3)
  assert.equal(searchSessions([], {}).total, 0)
})

test('tokenize：中英混合按空白切，中文保留整串（不做分词，靠子串匹配）', () => {
  assert.deepEqual(tokenize('净值曲线 next build'), ['净值曲线', 'next', 'build'])
  assert.deepEqual(tokenize('   '), [])
})

// ───────── 用户实测反馈（2026-08-31）：命中了却看不到命中在哪 ─────────
//
// 用户在 daily_feedback 里问了「目前你有国内和国外端吗?」，去执行历史搜同一句话，
// 界面显示「命中 1」，但卡片上是那条会话的**开场白**（firstPrompt，讲的是产品经理/手机端），
// 与搜索词毫无关系 ⇒ 看起来像匹配错了，**其实是匹配对了但没给他看**。
//
// ★★ 结论：检索结果必须带**匹配片段**。没有片段的"命中"对用户等于噪声——
//   他无法判断这条是不是他要的，也无法判断系统是不是坏的。
//   这比"多召回几条"重要得多：**看不懂的命中，召回率再高也没用**。

test('★★ 结果必须带匹配片段，且片段里真的含关键词', () => {
  const docs = [{
    host: 'h', project: '-data-daily-feedback', session: 's1', engine: 'claude',
    firstPrompt: '假设你是一个专业产品经理，基于我目前的产品实现情况',
    texts: ['前面一段无关的内容', '目前你有国内和国外端吗?', '后面一段无关的内容'],
    files: [], commands: [], lastAt: 2, startedAt: 1,
  }]
  const r = searchSessions(docs, { q: '国内和国外端' })
  assert.equal(r.total, 1)
  const h = r.hits[0]
  assert.ok(Array.isArray(h.snippets) && h.snippets.length > 0, '必须返回 snippets')
  assert.ok(h.snippets.some((s) => s.text.includes('国内和国外端')), `片段里必须含关键词：${JSON.stringify(h.snippets)}`)
})

test('★ 片段要带前后文，不能只给关键词本身（没有上下文就看不懂）', () => {
  const docs = [{
    host: 'h', project: 'p', session: 's', engine: 'claude', firstPrompt: '',
    texts: ['这是一段很长的前文用来提供上下文环境说明当时在做什么事情，然后出现了关键词ABCXYZ，后面还有一段说明它的结论和影响'],
    files: [], commands: [], lastAt: 1, startedAt: 1,
  }]
  const s = searchSessions(docs, { q: 'ABCXYZ' }).hits[0].snippets[0]
  assert.ok(s.text.length > 20, `片段太短，没有上下文：${s.text}`)
  assert.ok(s.text.includes('ABCXYZ'))
})

test('★ 片段要标出匹配在哪（前端要能高亮）', () => {
  const docs = [{ host: 'h', project: 'p', session: 's', engine: 'claude', firstPrompt: '',
    texts: ['aaa 关键词 bbb'], files: [], commands: [], lastAt: 1, startedAt: 1 }]
  const s = searchSessions(docs, { q: '关键词' }).hits[0].snippets[0]
  assert.ok(Array.isArray(s.hits) && s.hits.length > 0, '要给出匹配词，前端据此高亮')
  assert.ok(s.hits.includes('关键词'))
})

test('★ 命中在提问/命令/文件上时也要给片段，并标明来源', () => {
  const docs = [{
    host: 'h', project: 'p', session: 's', engine: 'claude',
    firstPrompt: '帮我修一下 cgroup 节流的问题', texts: [],
    files: ['server/hub.js'], commands: [{ cmd: 'docker ps -a', n: 1 }], lastAt: 1, startedAt: 1,
  }]
  const byPrompt = searchSessions(docs, { q: 'cgroup' }).hits[0].snippets
  assert.ok(byPrompt.some((s) => s.from === 'prompt'), `应标明来自提问：${JSON.stringify(byPrompt)}`)
  const byCmd = searchSessions(docs, { q: 'docker' }).hits[0].snippets
  assert.ok(byCmd.some((s) => s.from === 'command'))
  const byFile = searchSessions(docs, { q: 'hub.js' }).hits[0].snippets
  assert.ok(byFile.some((s) => s.from === 'file'))
})

test('★ 片段数量与长度要有上限（首屏 ≤15KB gzip 是硬指标）', () => {
  const docs = [{
    host: 'h', project: 'p', session: 's', engine: 'claude', firstPrompt: '',
    texts: Array.from({ length: 200 }, (_, i) => `第${i}段里含有 KEY 这个词，${'填充'.repeat(200)}`),
    files: [], commands: [], lastAt: 1, startedAt: 1,
  }]
  const h = searchSessions(docs, { q: 'KEY' }).hits[0]
  assert.ok(h.snippets.length <= 3, `片段最多 3 条，实际 ${h.snippets.length}`)
  for (const s of h.snippets) assert.ok(s.text.length <= 220, `单片段过长：${s.text.length}`)
})

test('★ 无关键词（纯结构化过滤）时不返回片段，不白占字节', () => {
  const docs = [{ host: 'h', project: 'p', session: 's', engine: 'claude', firstPrompt: 'x',
    texts: ['y'], files: [], commands: [], lastAt: 1, startedAt: 1 }]
  const h = searchSessions(docs, { engine: 'claude' }).hits[0]
  assert.ok(!h.snippets || h.snippets.length === 0)
})
