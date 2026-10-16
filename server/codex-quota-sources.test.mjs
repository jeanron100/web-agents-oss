import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureQuotaSources, probeCodexAccounts } from './codex-quota-sources.js'

const CODEX_SHARED_ACCOUNT='test-shared-account'
configureQuotaSources({groups:[{accountId:CODEX_SHARED_ACCOUNT,serverIds:['srv-178-232','srv-185-34']}],historyAliases:{'historical:srv-178-232':CODEX_SHARED_ACCOUNT,'historical:srv-185-34':CODEX_SHARED_ACCOUNT}})

const agents = ['srv-185-34', 'srv-177-42', 'srv-178-232'].map(id => ({ id }))
const observation = (accountId = CODEX_SHARED_ACCOUNT) => ({ accountId, at: Date.now(), primary: { pct: 0, windowMin: 10080 } })
test('shared account probes .232 only, while independent servers remain covered', async () => {
  const calls = []
  const result = await probeCodexAccounts(agents, async a => {
    calls.push(a.id)
    return observation(a.id === 'srv-177-42' ? 'other-account' : CODEX_SHARED_ACCOUNT)
  })
  assert.deepEqual(calls.sort(), ['srv-177-42', 'srv-178-232'])
  assert.equal(result.length, 2)
  assert.equal(result.find(r => r.accountId === CODEX_SHARED_ACCOUNT).sourceServerId, 'srv-178-232')
})
test('failed, stale, empty and invalid primary source fall back to .34', async () => {
  for (const bad of [null, { ...observation(), stale: true }, { ...observation(), error: 'failed' },
    { ...observation(), primary: null }, { ...observation(), at: NaN },
    { ...observation(), primary: { pct: 101, windowMin: 10080 } }, 'throw']) {
    const calls = []
    const result = await probeCodexAccounts(agents.filter(a => a.id !== 'srv-177-42'), async a => {
      calls.push(a.id)
      if (a.id !== 'srv-178-232') return observation()
      if (bad === 'throw') throw new Error('offline')
      return bad
    })
    assert.deepEqual(calls, ['srv-178-232', 'srv-185-34'])
    assert.equal(result.length, 1)
    assert.equal(result[0].sourceServerId, 'srv-185-34')
  }
})
test('changed login is kept separate and does not suppress the confirmed account', async () => {
  const result = await probeCodexAccounts(agents.filter(a => a.id !== 'srv-177-42'), async a =>
    observation(a.id === 'srv-178-232' ? 'changed-login' : CODEX_SHARED_ACCOUNT))
  assert.deepEqual(result.map(r => r.accountId).sort(), [CODEX_SHARED_ACCOUNT, 'changed-login'].sort())
})
test('all sources unavailable return no fake zero account; absent preferred source uses fallback', async () => {
  assert.deepEqual(await probeCodexAccounts(agents, async () => null), [])
  const result = await probeCodexAccounts([{ id: 'srv-185-34' }], async () => observation())
  assert.equal(result[0].sourceServerId, 'srv-185-34')
})
