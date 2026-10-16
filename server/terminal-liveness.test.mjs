// node --test server/terminal-liveness.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasDescendantProcess, protectedTerminalSessions } from './terminal.js'

function procTree(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-proc-'))
  for (const [pid, children] of Object.entries(entries)) {
    const dir = path.join(root, pid, 'task', pid)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'children'), children.join(' '))
  }
  return root
}

test('idle shell without children is reclaimable', () => {
  const root = procTree({ 100: [] })
  try { assert.equal(hasDescendantProcess(100, root), false) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('shell background job is detected as a live descendant', () => {
  const root = procTree({ 100: [101], 101: [] })
  try { assert.equal(hasDescendantProcess(100, root), true) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('invalid or vanished pane pid does not throw', () => {
  assert.equal(hasDescendantProcess('bad', '/missing'), false)
  assert.equal(hasDescendantProcess(999999, '/missing'), false)
})

test('one busy pane protects a multi-pane tmux session', () => {
  const root = procTree({ 100: [], 101: [] })
  try {
    const rows = [
      'wt-a\x1fbash\x1f100',
      'wt-a\x1ftop\x1f101',
      'wt-b\x1fbash\x1f100',
    ].join('\n')
    assert.deepEqual([...protectedTerminalSessions(rows, root)], ['wt-a'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
