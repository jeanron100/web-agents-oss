// Short maintenance lease used to close the state-check -> restart race.
// Entering is synchronous: new POST work is rejected before active sessions are inspected.

export const ACTIVE_PLATFORM_STATES = new Set(['running', 'waiting_approval', 'waiting_input'])

// 是否算「在飞、被 agent 重启即截断」的平台会话：优先用 driver 给的精确 inflight 布尔
// （回合真在飞 / 有真审批 / codex turn 未确认），回退到粗粒度 state（老形状/无 inflight 字段时）。
// 关键：回合后的 review/question 待办 inflight=false → 不再白白阻塞排空 120s（CR-006 P1-b）。
export function isInflightPlatformSession(s) {
  if (s?.origin !== 'platform') return false
  if (s.engine === 'codex' && s.restartSafe === true && !s.queuedMessages) return false
  return typeof s.inflight === 'boolean' ? s.inflight : ACTIVE_PLATFORM_STATES.has(s.state)
}

export function activePlatformSessions(...sessionLists) {
  return sessionLists.flat().filter(isInflightPlatformSession)
    .map((s) => ({ id: s.id, state: s.state, project: s.project, summary: s.summary }))
}

// excludeIds：排空豁免的平台会话 id。用于「重启是由某个本 agent 驱动的会话自己发起的」——
// 那个会话恒为 running（它正在跑 restart 命令），排空等它、它等排空 → 死锁到 TimeoutStopSec 被 SIGKILL。
// 2026-07-09 实测：232 上 drain 等 ps-mr4qzorp-1(本运维会话) 整整 120s，最后 agent 与所有 claude/codex
// 子进程被 systemd 一起硬杀——优雅排空反而制造了停机 + 全量硬杀。见 CR-008。
export function restartBlockers({ sessionLists = [], mutationCount = 0, execCount = 0, excludeIds = null } = {}) {
  let blockers = activePlatformSessions(...sessionLists)
  if (excludeIds && excludeIds.size) blockers = blockers.filter((b) => !excludeIds.has(b.id))
  if (mutationCount > 0) blockers.push({ id: 'inflight-mutation', state: 'running', project: '', summary: `${mutationCount} 个写请求仍在处理` })
  if (execCount > 0) blockers.push({ id: 'webshell-exec', state: 'running', project: '', summary: `${execCount} 个一次性命令仍在执行` })
  return blockers
}

export function createMaintenanceLease({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  let until = 0
  return {
    isActive() { return now() < until },
    enter(getActive) {
      until = now() + ttlMs
      const active = getActive()
      if (active.length) until = 0 // deployment will abort; do not leave users locked out
      return { ok: active.length === 0, active, until: active.length ? 0 : until }
    },
    clear() { until = 0 },
  }
}

/** Count accepted mutations across await boundaries; release is idempotent for finish/close races. */
export function createActivityCounter() {
  let count = 0
  return {
    begin() {
      count++
      let released = false
      return () => {
        if (released) return
        released = true
        count = Math.max(0, count - 1)
      }
    },
    count() { return count },
  }
}
