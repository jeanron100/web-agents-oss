import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

test('resume rejoins daemon, retains active approval and deduplicates concurrent restores', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-daemon-'))
  fs.mkdirSync(path.join(dir, 'app-server-control'))
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const calls = []
  wss.on('connection', ws => ws.on('message', raw => {
    const m = JSON.parse(raw); calls.push(m)
    const send = value => ws.send(JSON.stringify(value))
    if (m.method === 'initialize') send({ id: m.id, result: {} })
    if (m.method === 'thread/resume') {
      // Requests may arrive before the resume response. They must not be declined or lost.
      send({ id: 90, method: 'item/commandExecution/requestApproval', params: { threadId: 'target', turnId: 'turn', command: 'echo approval' } })
      send({ id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'other-client', command: 'echo external' } })
      send({ id: m.id, result: { model: 'test-model', approvalPolicy: 'on-request', thread: { id: 'target', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [{ id: 'turn', status: 'inProgress' }] } } })
    }
  }))
  await new Promise(resolve => server.listen(path.join(dir, 'app-server-control/app-server-control.sock'), resolve))
  try {
    const script = `
      import assert from 'node:assert/strict';
      import * as driver from ${JSON.stringify(new URL('./codex-driver.js', import.meta.url).href)};
      try {
        const opts={cwd:${JSON.stringify(dir)},resume:'target'};
        const [a,b]=await Promise.all([driver.createSession(opts),driver.createSession(opts)]);
        assert.equal(a,b);
        assert.equal(a.state,'waiting_approval');
        assert.equal(a.curTurnId,'turn');
        assert.equal(a.turnActive,true);
        assert.equal(driver.pendingActions().length,1);
        const again=await driver.createSession(opts);
        assert.equal(again,a);
        await driver.sendMessage(a.id,'queued input',[],{behavior:'queue'});
        assert.equal(a.queuedInputs.length,1);
        process.exit(0);
      } catch(e) { console.error(e);process.exit(1); }
    `
    const env = { ...process.env, CODEX_HOME: dir, WA_CODEX_RECONNECT_FILE: path.join(dir, 'reconnect.json') }; delete env.CODEX_BIN
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env })
    let error = ''; child.stderr.on('data', b => { error += b })
    const code = await new Promise((resolve,reject) => { child.on('error',reject); child.on('exit',resolve) })
    assert.equal(code,0,error)
    assert.equal(calls.filter(m=>m.method==='thread/resume').length,1)
    assert.equal(calls.filter(m=>m.method==='turn/start').length,0)
    assert.equal(calls.filter(m=>m.id===90 || m.id===91).length,0,'No automatic decision for replayed or unrelated approvals')
    assert.equal(calls.find(m=>m.method==='thread/resume').params.sandbox,undefined,'Do not change original thread sandbox while reconnecting')
    // A fresh driver (agent restart) must reconnect without a user clicking restore.
    const restartScript = `
      import assert from 'node:assert/strict';
      import * as driver from ${JSON.stringify(new URL('./codex-driver.js', import.meta.url).href)};
      try {
        await driver.restoreManagedSessions();
        assert.equal(driver.listSessions().find(s=>s.id==='target').state,'waiting_approval');
        assert.equal(driver.pendingActions().length,1);
        await driver.restoreManagedSessions();
        process.exit(0);
      } catch(e) { console.error(e);process.exit(1); }
    `
    const restarted = spawn(process.execPath, ['--input-type=module','-e',restartScript], {env})
    let restartError='';restarted.stderr.on('data',b=>{restartError+=b})
    const restartCode=await new Promise((resolve,reject)=>{restarted.on('error',reject);restarted.on('exit',resolve)})
    assert.equal(restartCode,0,restartError)
    assert.equal(calls.filter(m=>m.method==='thread/resume').length,2)
    assert.equal(calls.filter(m=>m.method==='turn/start').length,0,'Reconnection must never start or duplicate a turn')
  } finally {
    for(const client of wss.clients) client.terminate()
    await new Promise(resolve=>wss.close(resolve))
    await new Promise(resolve=>server.close(resolve))
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
