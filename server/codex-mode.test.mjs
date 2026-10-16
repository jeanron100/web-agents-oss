import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('新建、接管及首回合默认自动审批，手动审批仍可选择', { timeout: 15_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-mode-'))
  try {
    const bin = path.join(dir, 'codex')
    const log = path.join(dir, 'rpc.jsonl')
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.WA_TEST_RPC_LOG, line + '\\n');
  if (m.id == null || !m.method) return;
  let result = {};
  if (m.method === 'model/list') result = { data: [] };
  if (m.method === 'thread/start' || m.method === 'thread/resume') result = { thread: { id: m.params.threadId || 'new-thread' } };
  if (m.method === 'turn/start') {
    result = { turn: { id: 'turn-1' } };
    const tid = m.params.threadId;
    const say = (method, params) => process.stdout.write(JSON.stringify({method, params}) + '\\n');
    if (m.params.input.some(x => x.text === 'manual')) {
      process.stdout.write(JSON.stringify({id:m.id, method:'item/commandExecution/requestApproval', params:{threadId:tid, turnId:'turn-1', command:'echo hello'}}) + '\\n');
      setTimeout(() => say('serverRequest/resolved', {threadId:tid, requestId:m.id}), 30);
    }
    setTimeout(() => {
      say('item/completed', {threadId:tid, item:{id:'answer-' + tid, type:'agentMessage',text:'已收到消息'}});
      say('turn/completed', {threadId:tid,turn:{id:'turn-1',status:'completed'}});
    }, 60);
  }
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
});
`, { mode: 0o700 })
    const moduleUrl = new URL('./codex-driver.js', import.meta.url).href
    const script = `
      import assert from 'node:assert/strict';
      import * as driver from ${JSON.stringify(moduleUrl)};
      try {
        const fresh = await driver.createSession({ cwd: ${JSON.stringify(dir)}, prompt: 'hello' });
        assert.equal(fresh.mode, 'on-request');
        const resumed = await driver.createSession({ cwd: ${JSON.stringify(dir)}, resume: 'old-thread' });
        assert.equal(resumed.mode, 'on-request');
        assert.equal(await driver.setMode(resumed.id, 'untrusted'), true);
        await driver.sendMessage(resumed.id, 'manual');
        assert.equal(driver.pendingActions().length, 1, '同号 server request 不得误当 RPC response');
        await new Promise(r => setTimeout(r, 120));
        assert.equal(driver.pendingActions().length, 0, '已处理审批不能残留');
        assert.equal(driver.listSessions().find(s => s.id === resumed.id).state, 'idle');
        assert.equal(driver.getEvents(resumed.id).events.filter(e => e.type === 'assistant').length, 1, '无 delta 的完整回复也必须显示');
        await driver.setMode(resumed.id, 'on-request');
        await driver.sendMessage(resumed.id, 'automatic again');
        await new Promise(r => setTimeout(r, 120));
        await driver.setMode(resumed.id, 'never');
        await driver.sendMessage(resumed.id, 'full access');
        process.exit(0);
      } catch (e) { console.error(e); process.exit(1); }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CODEX_BIN: bin, WA_WORKER_SLICE: '0', WA_TEST_RPC_LOG: log },
      timeout: 10_000, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr + result.stdout + String(result.error ?? ''))
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    for (const method of ['thread/start', 'thread/resume']) {
      const call = calls.find((c) => c.method === method)
      assert.equal(call.params.approvalPolicy, 'on-request')
      assert.equal(call.params.approvalsReviewer, 'auto_review')
      assert.equal(call.params.sandbox, 'workspace-write')
    }
    const turns = calls.filter((c) => c.method === 'turn/start')
    assert.deepEqual(turns.map((c) => c.params.approvalPolicy), ['on-request', 'untrusted', 'on-request', 'never'])
    assert.deepEqual(turns.map((c) => c.params.approvalsReviewer), ['auto_review', 'user', 'auto_review', 'user'])
    assert.ok(turns.slice(0, 3).every((c) => c.params.sandboxPolicy.type === 'workspaceWrite'))
    assert.equal(turns[3].params.sandboxPolicy.type, 'dangerFullAccess')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
