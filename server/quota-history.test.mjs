import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexQuotaSamples, kimiQuotaSamples, quotaSeries, legacyClaudeQuotaSeries } from './quota-history.js'
import { configureQuotaSources } from './codex-quota-sources.js'

const CODEX_SHARED_ACCOUNT='test-shared-account'
configureQuotaSources({groups:[{accountId:CODEX_SHARED_ACCOUNT,serverIds:['srv-178-232','srv-185-34']}],historyAliases:{'historical:srv-178-232':CODEX_SHARED_ACCOUNT,'historical:srv-185-34':CODEX_SHARED_ACCOUNT}})

const now = 1791320000000
test('Codex preserves actual timestamp and account identity; primary need not be the long window', () => {
  const samples = codexQuotaSamples([
    { accountId: 'a', at: now - 60000, primary: { pct: 10, windowMin: 300 }, secondary: { pct: 42, windowMin: 10080 } },
    { accountId: 'b', at: now, primary: { pct: 0, windowMin: 10080, resetsAt: 1791593515 } },
  ], now)
  assert.equal(samples.length, 2)
  assert.deepEqual(samples.map(r => [r.accountKey, r.ts, r.pct, r.windowLabel]), [['a', now - 60000, 42, '本周'], ['b', now, 0, '本周']])
  assert.equal(samples[1].resetAt, 1791593515000)
})
test('legacy percent history stays Claude-only; zeros are preserved, unknowns discarded', () => {
  const series = legacyClaudeQuotaSeries([{ ts_ms: now, week_pct: '0' }, { ts_ms: now - 1000, week_pct: null }, { ts_ms: now - 2000, week_pct: 101 }])
  assert.equal(series[0].engine, 'claude')
  assert.deepEqual(series[0].points, [{ ts: now, pct: 0 }])
})
test('unidentified native observations are labeled by source instead of current login account', () => {
  const rows = [{ engine: 'codex', account_key: 'historical:srv-177-42', window_key: '10080', window_label: '本周', ts_ms: now, pct: 20 }]
  const series = quotaSeries(rows)
  assert.equal(series[0].sourceLabel, '历史 srv-177-42（账号未记录）')
  assert.notEqual(series[0].id, JSON.stringify(['codex', 'current-account', '10080']))
})
test('confirmed .232/.34 history and live identity share one series; latest sample wins even after a reset', () => {
  const start = Math.floor(now / 10800000) * 10800000
  const row = (account_key, ts_ms, pct, window_key = '10080') => ({ engine: 'codex', account_key, ts_ms, pct, window_key, window_label: '本周' })
  const series = quotaSeries([
    row('historical:srv-178-232', start + 1000, 96),
    row('historical:srv-185-34', start + 2000, 4),
    row(CODEX_SHARED_ACCOUNT, start + 3000, 0),
    row('historical:srv-185-34', start + 10801000, 10),
    row('historical:srv-178-232', start + 21601000, 20),
    row('different-login', start + 3000, 70),
    row(CODEX_SHARED_ACCOUNT, start + 3000, 30, '43200'),
  ])
  assert.equal(series.length, 3)
  const shared = series.find(s => s.id === JSON.stringify(['codex', CODEX_SHARED_ACCOUNT, '10080']))
  assert.equal(shared.sourceLabel, undefined)
  assert.deepEqual(shared.points, [{ ts: start + 3000, pct: 0 }, { ts: start + 10801000, pct: 10 }, { ts: start + 21601000, pct: 20 }])
})
test('equal-time alias conflicts prefer known identity then .232, regardless of row order', () => {
  const rows = ['historical:srv-185-34', 'historical:srv-178-232', CODEX_SHARED_ACCOUNT].map((account_key, i) =>
    ({ engine: 'codex', account_key, window_key: '10080', window_label: '本周', ts_ms: now, pct: 10 + i }))
  assert.equal(quotaSeries(rows)[0].points[0].pct, 12)
  assert.deepEqual(quotaSeries(rows), quotaSeries([...rows].reverse()))
  assert.equal(quotaSeries(rows.slice(0, 2))[0].points[0].pct, 11)
})
test('Invalid, failed or anonymous observations cannot create quota history', () => {
  const base = { accountId: 'a', at: now, primary: { pct: 10, windowMin: 10080 } }
  assert.deepEqual(codexQuotaSamples([ { ...base, stale: true }, { ...base, error: 'failed' }, { ...base, at: now + 100000 }, { ...base, primary: { pct: null, windowMin: 10080 } }, { ...base, accountId: null }, { ...base, primary: { pct: 101, windowMin: 10080 } } ], now), [])
  assert.deepEqual(kimiQuotaSamples({ ts: now, stale: true, week: { pct: 10 } }, 'srv', now), [])
})
test('Kimi Monthly is not mislabeled weekly and cache timestamp is retained', () => {
  const u = { ts: now - 60000, week: { pct: 29, label: 'Monthly' } }
  const r = kimiQuotaSamples(u, 'srv', now)[0]
  assert.equal(r.windowLabel, '本月')
  assert.equal(r.ts, u.ts)
  assert.equal(kimiQuotaSamples({ ...u, disabled: true }, 'srv', now).length, 0)
})
test('History groups accounts and windows separately instead of summing percentages', () => {
  const rows = ['a', 'b'].map(account_key => ({ engine: 'codex', account_key, window_key: '10080', window_label: '本周', ts_ms: String(now), pct: '42' }))
  const series = quotaSeries(rows)
  assert.equal(series.length, 2)
  assert.notEqual(series[0].id, series[1].id)
  assert.deepEqual(series[0].points, [{ ts: now, pct: 42 }])
})
