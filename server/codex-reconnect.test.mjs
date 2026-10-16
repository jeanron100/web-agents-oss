import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReconnectRegistry, independentDaemon } from './codex-reconnect.js'

test('identities survive reload, release stays released, inputs are never persisted', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-registry-'))
  try {
    const file=path.join(dir,'sessions.json')
    const a=createReconnectRegistry(file)
    a.remember({id:'thread',cwd:dir,mode:'on-request',startedAt:10,queuedInputs:['private input'],events:['private transcript']})
    const b=createReconnectRegistry(file)
    assert.deepEqual(b.list(),[{id:'thread',cwd:dir,mode:'on-request',startedAt:10}])
    assert.equal(fs.statSync(file).mode & 0o777,0o600)
    b.forget('thread')
    assert.deepEqual(createReconnectRegistry(file).list(),[])
    const broken=createReconnectRegistry(path.join(file,'cannot-write.json'))
    broken.remember({id:'unpersisted',cwd:dir})
    assert.equal(broken.has('unpersisted'),false,'failed persistence must not permit restart')
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('restart requires the actual socket owner outside the agent cgroup', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-proc-'))
  try {
    const socket=path.join(dir,'control.sock');fs.writeFileSync(socket,'')
    for(const folder of ['net','self','12/fd'])fs.mkdirSync(path.join(dir,folder),{recursive:true})
    fs.writeFileSync(path.join(dir,'net/unix'),`Num RefCount Protocol Flags Type St Inode Path\n000: 2 0 00010000 0001 01 99 ${socket}\n`)
    fs.writeFileSync(path.join(dir,'self/cgroup'),'0::/control/agent.service\n')
    fs.writeFileSync(path.join(dir,'12/cmdline'),'codex\0app-server\0--managed-daemon\0')
    const cg=path.join(dir,'12/cgroup')
    fs.writeFileSync(cg,'0::/workers/daemon.service\n')
    fs.symlinkSync('socket:[99]',path.join(dir,'12/fd/3'))
    assert.equal(independentDaemon(socket,{procRoot:dir}).pid,12)
    fs.writeFileSync(cg,'0::/control/agent.service\n')
    assert.equal(independentDaemon(socket,{procRoot:dir}),null)
    fs.writeFileSync(cg,'0::/control/agent.service/child\n')
    assert.equal(independentDaemon(socket,{procRoot:dir}),null)
    fs.writeFileSync(cg,'0::/workers/daemon.service\n')
    fs.unlinkSync(path.join(dir,'12/fd/3'))
    assert.equal(independentDaemon(socket,{procRoot:dir}),null,'another daemon process is not proof of socket ownership')
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
