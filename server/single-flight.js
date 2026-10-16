// server/single-flight.js — 通用单飞去重：并发调用者共享同一个 in-flight Promise。
//
// 背景（Fix 2，2026-07-20 诊断 §3）：hub.js 的 buildState() 会被至少四路互不感知的调用者
// 并发触发——setInterval(async) 不等上一轮跑完的 5s 轮询 tick、每个浏览器 tab 每 3s 一次的
// GET /api/state、60s 一次的 KB 自动归档、以及各种"idToAgent 缓存未命中，现探一次"的
// on-demand 兜底路径。buildState() 对每个 agent 走 fetchJson（8s 超时），整函数被
// Promise.all(...) 卡住直到全部 agent settle——只要任意一个 agent 变慢/挂起，所有并发在跑
// 的 buildState() 都会被拖到差不多同一时刻才 settle，而它们又全部在写同一批模块级共享 Map
// （idToAgent/actionToAgent/idToMeta/lastAgentState）。这正是 2026-07-20 15:47 五台互不相关
// 的 agent 同一秒一起"失联又恢复"的根因：不是五台机器同时抽风，是 hub 自己的轮询堆积
// 拖慢了自己的事件循环（详见 .superpowers/sdd/alerts-diagnosis.md §3）。
//
// 修法沿用本仓库既有先例：agent.js 的 cachedScan()（inflight Map，同一份正在跑的解析被
// 并发请求共享而不是各起一份）与 SSE tick 的 busy 标记（"上一拍没跑完就丢本拍"）——都是
// 同一类"别让并发重复做同一件昂贵的事"防线。这里是通用化、可独立单测的版本。
//
// 取舍说明（对应"必须不改变需要新鲜数据的调用者的可观测行为"）：晚到的调用者会复用"已经
// 在跑的这一轮"，其底层探测可能是在它调用之前的几百毫秒就已经开始的——但这个陈旧窗口严格
// 不超过单轮耗时本身（正常 <1s，最坏是 fetchJson 的 8s 超时），并不比"它自己另起一轮"更旧：
// 单飞前，晚到的调用者本来就要等自己那一轮的网络往返；单飞后，它等的是已经在路上、可能
// 早一点点开始的同一轮——worst case（agent 真的挂起）下反而更快 settle（少排一次 8s 超时），
// 不会更慢。更关键的是：buildState() 写入的共享 Map 过去允许多个实例并发运行、彼此用不同
// 时刻的探测结果交替写同一批 Map（可能产生"半新半旧"的 Frankenstein 状态）；单飞之后任意
// 时刻只有一次连贯的写入过程，观测到的状态只会比过去更一致，不会更差。
//
// @param fn 无参数的异步函数：() => Promise<T>（多参数场景不适用——本模块只服务 buildState()
//   这类"没有输入、只有副作用/返回快照"的场景，故不做参数转发，避免"排队的调用者该用谁的
//   参数"这种没有单一正确答案的歧义）。
// @returns 同签名的函数：并发调用者共享同一个 in-flight Promise，settle 后下一次调用重新真正发起。
export function singleFlight(fn) {
  let inflight = null
  return function run() {
    if (inflight) return inflight
    inflight = (async () => fn())().finally(() => { inflight = null })
    return inflight
  }
}
