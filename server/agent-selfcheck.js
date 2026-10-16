// server/agent-selfcheck.js — agent 自检与停摆形态判别（2026-08-30 事故整改 R4）。纯函数。
//
// 事故：agent 停止服务 **65 分钟**，而 systemd 全程 active(running)、Restart 一次都没触发。
// ★★ 崩溃/冻住但**不退出**，会把自动重启机制一起废掉——systemd 只看进程在不在。
//   所以必须有**独立于 systemd 的**判活三件套，且判据要能被外部（非本进程）执行。

/**
 * ⚠️ **`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`** —— 光用 `Number.isFinite`
 *   挡不住"读不到"，它会被当成一个合法的 0（这里就是"HTTP 状态码 0 = 挂了"）。
 *   本轮整改里这个坑咬了三次（archive-vector 的 load、archive-recon 的覆盖率、这里）。
 *   ⇒ 统一用这个判据：**只有真的是有限数字才算读到了**。
 */
const got = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))

/** accept 队列占用超过这个比例就认为"在听但不 accept"。 */
const ACCEPT_FULL_RATIO = 0.5

/**
 * 判活三件套。
 * ⚠️ **读不到指标时判健康**：未知 ≠ 故障。否则采集一坏告警就长鸣，几天后没人再看
 *   （本仓库前科：0 订阅者时告警全推进虚空，10 天没人发现）。
 */
export function checkHealth({ recvQ, sendQ, httpCode, zombies } = {}) {
  const reasons = []
  const unknown = []

  const rq = Number(recvQ); const sq = Number(sendQ)
  if (got(recvQ) && got(sendQ) && sq > 0) {
    if (rq >= sq * ACCEPT_FULL_RATIO) reasons.push(`accept 队列 ${rq}/${sq} —— 端口在听但已经不 accept`)
  } else unknown.push('accept 队列')

  const hc = Number(httpCode)
  if (got(httpCode)) {
    // ⚠️ 探活端点必须真实存在：`/api/health` **不存在**，返 404。
    //    拿它探活等于永远报故障——这是"看门狗结构上永远响"的镜像错误。
    if (hc === 404) reasons.push('HTTP 自探 404 —— 探活端点用错了（/api/health 不存在，用 /api/projects）')
    else if (hc !== 200) reasons.push(`HTTP 自探 ${hc}`)
  } else unknown.push('HTTP 自探')

  const z = Number(zombies)
  if (got(zombies)) { if (z > 0) reasons.push(`名下僵尸进程 ${z} 个 —— 事件循环没在转`) }
  else unknown.push('僵尸计数')

  return {
    healthy: reasons.length === 0,
    reasons,
    note: unknown.length ? `以下指标读不到，按未知处理（不误报）：${unknown.join('、')}` : '',
  }
}

/**
 * 停摆形态判别。**两种形态的处置完全相反**：
 *  · `crashed`   崩溃壳：journal 有 EPIPE/FATAL、僵尸堆积 ⇒ **必须重启**
 *  · `throttled` 被节流冻住：WCHAN=mem_cgroup_handle_over_high、零致命错误
 *                ⇒ **别重启**，解节流/减负即可，队列会自己排空
 *
 * ★ 误判代价不对称：把「冻住」当「已死」去重启，会白白腰斩正在跑的会话。
 *   本次事故正是人工清掉 5 个尸体后**未经重启 3 分钟自愈**（load 35.37 → 0.83）。
 *   所以**只有证据明确指向崩溃时才建议重启**；含糊一律不重启。
 */
export function classifyStall({ wchan, fatalCount, zombies } = {}) {
  const throttled = typeof wchan === 'string' && wchan.includes('mem_cgroup_handle_over_high')
  const fatal = Number(fatalCount) > 0
  const z = Number(zombies) > 0

  if (throttled && fatal) {
    return {
      kind: 'ambiguous', shouldRestart: false,
      action: '两类特征同时出现，保守处理：先解节流/减负观察，别重启（重启会腰斩正在跑的会话），必要时交人判断',
    }
  }
  if (throttled) {
    return {
      kind: 'throttled', shouldRestart: false,
      action: '被 cgroup 节流冻住：抬 memory.high 或清掉尸体会话减负即可，**别重启**——队列会自己排空',
    }
  }
  if (fatal || z) {
    return { kind: 'crashed', shouldRestart: true, action: '崩溃壳（有致命错误/僵尸堆积）：需要重启' }
  }
  return { kind: 'unknown', shouldRestart: false, action: '证据不全，不自动重启；先补齐 WCHAN 与 journal 证据' }
}
