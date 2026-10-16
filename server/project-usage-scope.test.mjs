import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { projectUsageScope } from './project-usage-scope.js'

test('filter before aggregation: preserve real history, reject retired-node duplicates and unknown nodes', () => {
  const scope = projectUsageScope({ activeServerIds: ['srv-178-232', 'srv-185-34'],
    retiredServers: [{ id: 'srv-189-4', retiredAt: '2026-09-30' }] })
  // Execute the actual parameterized predicate over fixture records. SQLite and
  // MySQL share this predicate syntax; this verifies date boundaries and totals.
  const result = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3,json,sys
p=json.loads(sys.argv[1]); c=sqlite3.connect(':memory:')
c.execute('CREATE TABLE usage(day TEXT,server_id TEXT,tokens INTEGER,active_ms INTEGER)')
c.executemany('INSERT INTO usage VALUES(?,?,?,?)',[
 ('2026-10-15','srv-178-232',114,7),('2026-10-15','srv-189-4',113,7),
 ('2026-09-29','srv-189-4',5,1),('2026-09-30','srv-189-4',9,2),
 ('2026-10-15','srv-185-34',3,1),('2026-10-15','unknown',100,10)])
print(json.dumps(c.execute('SELECT SUM(tokens),SUM(active_ms) FROM usage WHERE '+p['sql'],p['params']).fetchone()))
`, JSON.stringify(scope)], { encoding: 'utf8' }))
  assert.deepEqual(result, [122, 9])
})

test('empty configured scope excludes everything; unspecified scope retains compatibility', () => {
  assert.deepEqual(projectUsageScope({ activeServerIds: [] }), { sql: '1=0', params: [] })
  assert.deepEqual(projectUsageScope(), { sql: '1=1', params: [] })
})

test('server identities stay bound parameters, including special characters', () => {
  const id = "srv-' OR 1=1 --"
  const result = projectUsageScope({ activeServerIds: [id, id] })
  assert.equal(result.sql, '(server_id IN (?))')
  assert.deepEqual(result.params, [id])
})

test('contradictory or invalid retirement configuration fails visibly', () => {
  assert.throws(() => projectUsageScope({ activeServerIds: ['same'], retiredServers: [{ id: 'same', retiredAt: '2026-09-30' }] }))
  assert.throws(() => projectUsageScope({ activeServerIds: [], retiredServers: [{ id: 'old', retiredAt: 'yesterday' }] }))
})

test('hub applies the same scope to project rows and workload series', () => {
  const hub = fs.readFileSync(new URL('./hub.js', import.meta.url), 'utf8')
  const db = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8')
  assert.match(hub, /readProjectsDaily\(days, projectUsageScope\)/)
  assert.match(hub, /readActiveDailySeries\(days, projectUsageScope\)/)
  assert.equal((db.match(/AND \$\{filter.sql\} GROUP BY/g) ?? []).length, 2)
  const config = JSON.parse(fs.readFileSync(new URL('./hub-config.json', import.meta.url), 'utf8'))
  assert.deepEqual(config.agents, [], 'public template must not contain the private fleet')
  assert.deepEqual(config.retiredAgents, [], 'private historical scope belongs in external config')
})
