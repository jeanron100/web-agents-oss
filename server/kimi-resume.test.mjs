// node --test server/kimi-resume.test.mjs
//
// Kimi `wire.jsonl` 的增量续扫。
//
// 为什么（2026-08-13，用户点出来的）：我在 proposal 的 Non-goals 里写了
// 「本期不做 Kimi 侧改造——它只读 index、不读 wire.jsonl 内容，不是压力源」。
// **那句话只对 summary 路径成立。** events 路径（`cachedKimiScan`）与 Codex 改造前一模一样：
//   · 缓存键只比 mtime、不比 size
//   · `fs.readFileSync(file,'utf8')` 整份读进**一个字符串**（比 Codex 的流式更糟，是内存尖峰）
//   · 没有任何续扫能力
// 实测语料：.232 有 **1,644 个** Kimi 文件 / 48.8 MB / 最大 2.8 MB
// ⇒ 2.8MB 文件追加 4KB 要重读 2.8MB，读放大 ≈700×。
//
// ★ parseWire 累积了六样东西，任何一样丢了都会静默算错：
//   events / seq（事件 id 的一部分）/ tok 四桶 / model / lastActiveAt
//   以及最阴的 **lastTs** —— wire.jsonl 里确实有不带 `time` 的行，它们沿用**上一条**的时间。
//   跨增量边界丢了 lastTs，那些行的时间戳会变成 0 ⇒ 界面显示 1970-01-01，
//   而且按时间排序时被甩到最前面（这个 bug 本仓库修过一次，注释还在源码里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWire } from './kimi-shadow.js'

const line = (o) => JSON.stringify(o)
const usage = (t, i, o_) => line({ type: 'usage.record', time: t, model: 'kimi-k2', usage: { inputOther: i, output: o_, inputCacheRead: 0, inputCacheCreation: 0 } })
const userMsg = (t, text) => line({ type: 'context.append_message', time: t, message: { role: 'user', content: [{ type: 'text', text }] } })
/** 助手回复藏在 loop_event 里，且**自身没有 time 字段** —— 靠 lastTs 顺延。 */
const asstPart = (text) => line({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } } })

const chunk = (from, to) => {
  const out = []
  for (let i = from; i < to; i++) {
    out.push(userMsg(1700000000000 + i * 1000, `问题 ${i}`))
    out.push(asstPart(`回答 ${i}`))          // 无 time，必须继承上一行
    out.push(usage(1700000000000 + i * 1000 + 500, 10 + i, 20 + i))
  }
  return out.join('\n') + '\n'
}

test('★★ 增量续扫 ≡ 全量解析（events / tok / model / lastActiveAt 全一致）', () => {
  const a = chunk(0, 20)
  const b = chunk(20, 35)

  const full = parseWire(a + b)

  const p1 = parseWire(a)
  const p2 = parseWire(b, p1.state)

  assert.deepEqual(p2.events, full.events, 'events 必须完全相同（含 id 与 ts）')
  assert.deepEqual(p2.tok, full.tok, 'token 四桶必须相同——它们是 += 累积的')
  assert.equal(p2.model, full.model, 'model')
  assert.equal(p2.lastActiveAt, full.lastActiveAt, 'lastActiveAt')
})

test('★ lastTs 必须跨边界继承 —— 否则无 time 的行时间戳归零（1970）', () => {
  // 让增量的**第一行**就是没有 time 的助手回复：它只能靠上一段的 lastTs。
  const a = userMsg(1700000000000, '问题')
  const b = asstPart('回答') + '\n'

  const full = parseWire(a + '\n' + b)
  const p2 = parseWire(b, parseWire(a + '\n').state)

  assert.equal(p2.events.at(-1).ts, full.events.at(-1).ts, '跨边界的 ts 必须与全量一致')
  assert.ok(p2.events.at(-1).ts > 0, `无 time 的行不得退化成 0（实际 ${p2.events.at(-1).ts}）——那会显示成 1970-01-01`)
})

test('★ seq 跨边界连续 —— 事件 id 里含 seq，重号会让去重与续传出错', () => {
  const a = chunk(0, 5)
  const b = chunk(5, 8)
  const full = parseWire(a + b)
  const p2 = parseWire(b, parseWire(a).state)
  const ids = p2.events.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复')
  assert.deepEqual(ids, full.events.map((e) => e.id), 'id 必须与全量逐个相同')
})

test('token 四桶跨多段累积正确', () => {
  const segs = [chunk(0, 5), chunk(5, 10), chunk(10, 15)]
  let st = null
  let last
  for (const seg of segs) { last = parseWire(seg, st); st = last.state }
  assert.deepEqual(last.tok, parseWire(segs.join('')).tok)
})

test('不传 resume 时行为与改造前完全一致（向后兼容）', () => {
  const t = chunk(0, 6)
  const r = parseWire(t)
  assert.ok(Array.isArray(r.events) && r.events.length > 0)
  assert.ok(r.tok && typeof r.tok.input === 'number')
  assert.ok(r.state, '新增 state 字段供续扫用')
})

test('空增量（没有新行）不改变任何累积量', () => {
  const p1 = parseWire(chunk(0, 5))
  const p2 = parseWire('', p1.state)
  assert.deepEqual(p2.tok, p1.tok)
  assert.deepEqual(p2.events, p1.events)
  assert.equal(p2.lastActiveAt, p1.lastActiveAt)
})

test('坏行/半行被跳过，不影响累积（正在写入的文件必然有）', () => {
  const good = chunk(0, 3)
  const withBad = good + '{"type":"context.append_mess'   // 半行，无换行
  const a = parseWire(withBad)
  const b = parseWire(good)
  assert.deepEqual(a.tok, b.tok, '半行不得污染累积量')
})

// ───────── 2026-09-27：用量分桶（usageDaily/Stats 此前完全看不到 Kimi）─────────
// usage.record 自带 time，daily/hourly/dayTokComp 都必须按它落桶；且全是跨行累积量，
// 必须随 state 进检查点——丢了它们，增量续扫的桶会静默算错（同六量教训）。

const usageAt = (t, i, o_) => line({ type: 'usage.record', time: t, model: 'kimi-code/k3', usage: { inputOther: i, output: o_, inputCacheRead: 0, inputCacheCreation: 0 } })

test('★ usage.record 按 time 落 daily/hourly/dayTokComp 桶', () => {
  // 2026-09-27 08:30 与 09:45 各一条（本地时区）
  const t1 = new Date(2026, 8, 27, 8, 30).getTime()
  const t2 = new Date(2026, 8, 27, 9, 45).getTime()
  const t3 = new Date(2026, 8, 26, 23, 10).getTime() // 前一天
  const r = parseWire([usageAt(t3, 10, 20), usageAt(t1, 5, 7), usageAt(t2, 3, 4)].join('\n') + '\n')
  const day27 = '2026-09-27', day26 = '2026-09-26'
  assert.equal(r.daily[day26], 30)
  assert.equal(r.daily[day27], 12 + 7)
  assert.equal(r.dayTokComp[day27].input, 8)
  assert.equal(r.dayTokComp[day27].output, 11)
  const h08 = r.hourly[`${day27}T08`], h09 = r.hourly[`${day27}T09`]
  assert.equal(h08, 12)
  assert.equal(h09, 7)
})

test('★ 分桶量随 state 走：增量 ≡ 全量（daily/hourly/dayTokComp/dailyActiveMs）', () => {
  const t = (h, m) => new Date(2026, 8, 27, h, m).getTime()
  const a = [usageAt(t(8, 0), 10, 10), usageAt(t(8, 2), 5, 5)].join('\n') + '\n'
  const b = [usageAt(t(8, 4), 7, 7), usageAt(t(9, 30), 1, 1)].join('\n') + '\n'
  const full = parseWire(a + b)
  const p2 = parseWire(b, parseWire(a).state)
  assert.deepEqual(p2.daily, full.daily, 'daily 桶跨边界不得丢/重')
  assert.deepEqual(p2.dayTokComp, full.dayTokComp)
  assert.deepEqual(p2.hourly, full.hourly)
  assert.deepEqual(p2.dailyActiveMs, full.dailyActiveMs, '活跃时长也是跨行累积量')
  assert.equal(p2.activeMs, full.activeMs)
})

test('★ 无 time 的 usage.record 沿用上一条时间落桶，不得归零丢弃', () => {
  const t1 = new Date(2026, 8, 27, 8, 0).getTime()
  const a = line({ type: 'context.append_message', time: t1, message: { role: 'user', content: [{ type: 'text', text: '问' }] } })
  const noTime = line({ type: 'usage.record', model: 'k3', usage: { inputOther: 6, output: 6, inputCacheRead: 0, inputCacheCreation: 0 } })
  const r = parseWire(a + '\n' + noTime + '\n')
  assert.equal(r.daily['2026-09-27'], 12, '无 time 的行必须沿 lastTs 落桶，而不是被扔掉')
})
