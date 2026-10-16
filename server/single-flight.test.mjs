// node --test server/single-flight.test.mjs
//
// 纯逻辑单测：并发调用者共享同一个 in-flight Promise，settle 后下一次调用重新真正发起。
// 这是 hub.js buildState() 单飞去重（Fix 2）背后的通用机制——见 single-flight.js 头部注释。
// 用可手动 resolve/reject 的 deferred promise 驱动，不依赖真实定时器/网络，确定性可控。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { singleFlight } from './single-flight.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('跑的时候进来的并发调用者共享同一个 in-flight，fn 只被真正调用一次', async () => {
  let calls = 0
  const gates = []
  const fn = () => {
    calls++
    const d = deferred()
    gates.push(d)
    return d.promise
  }
  const run = singleFlight(fn)

  const p1 = run()
  const p2 = run() // 此时 fn 的第一次调用还没 settle，应该复用同一个 in-flight
  const p3 = run()

  assert.equal(calls, 1, '三个并发调用者应该只触发一次真正的 fn() 调用')

  gates[0].resolve('result-A')
  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.equal(r1, 'result-A')
  assert.equal(r2, 'result-A')
  assert.equal(r3, 'result-A')
  assert.equal(calls, 1, '结果落地后 fn 调用次数仍应是 1（不是每个调用者各触发一次）')
})

test('上一轮彻底 settle 之后，新的调用会重新真正发起（不是永久缓存第一次的结果）', async () => {
  let calls = 0
  const gates = []
  const fn = () => {
    calls++
    const d = deferred()
    gates.push(d)
    return d.promise
  }
  const run = singleFlight(fn)

  const p1 = run()
  gates[0].resolve('first')
  assert.equal(await p1, 'first')
  assert.equal(calls, 1)

  const p2 = run() // 第一轮已经彻底结束，这次必须是全新一轮，而不是复用旧结果
  assert.equal(calls, 2, '上一轮 settle 之后，新调用应该重新真正发起底层 fn')
  gates[1].resolve('second')
  assert.equal(await p2, 'second', '新一轮应该拿到新一轮自己的结果，而不是第一轮缓存的值')
})

test('in-flight 拒绝时，所有共享它的并发调用者都应该收到同一个 rejection（不能被静默吞掉）', async () => {
  let calls = 0
  const gates = []
  const fn = () => {
    calls++
    const d = deferred()
    gates.push(d)
    return d.promise
  }
  const run = singleFlight(fn)

  const p1 = run()
  const p2 = run()
  gates[0].reject(new Error('agent 挂了'))

  await assert.rejects(p1, /agent 挂了/)
  await assert.rejects(p2, /agent 挂了/)
  assert.equal(calls, 1, '共享同一个 in-flight 的调用者，rejection 也应该只对应一次真正调用')
})

test('fn 同步抛错也会被规整成一个 rejected promise（不会直接炸穿调用栈）', async () => {
  const run = singleFlight(() => { throw new Error('sync boom') })
  await assert.rejects(run(), /sync boom/)
})
