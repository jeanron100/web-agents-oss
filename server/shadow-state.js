// 影子态/平台态对账的纯函数（零依赖，可单测）。
//
// 平台(driver)会话与同一原生会话的影子文件并存时——例如 Web 端续接过该会话、SDK 进程仍在内存，
// 而用户又在 VS Code/终端里 `claude --resume <同一会话>`——driver 内存里的状态会滞后于真相：
// driver 以为会话 idle（Web 端没在驱动它），但原生进程其实正在写 JSONL。此时文件 mtime 才是真相。
// buildState 的去重逻辑默认「平台会话由 driver 提供、跳过影子文件」，会把这种正在跑的会话误显示为 idle，
// 看板「正在执行」因此计为 0。本函数按文件 mtime 刷新平台条目的活性，修正该误判。

/**
 * @param {{ state: string, lastActiveAt?: number }} ps  平台会话条目（driver.listSessions() 的一项）
 * @param {number} fileMtimeMs  对应原生会话 JSONL 的最新 mtime
 * @param {string} fileState    按 fileMtimeMs 算出的影子态（running / waiting_input / idle）
 * @returns {{ state: string, lastActiveAt: number }} 应写回平台条目的字段（纯函数，不改入参）
 */
export function refreshPlatformFromFile(ps, fileMtimeMs, fileState) {
  const driverLast = ps.lastActiveAt ?? 0
  const lastActiveAt = Math.max(driverLast, fileMtimeMs)
  let state = ps.state
  // 仅当 driver 处于「安静态」(idle/done)、且文件比 driver 记录更新、且文件本身显示有活动时才上抬状态；
  // 绝不覆盖 waiting_approval / waiting_input / plan / review / running / error 等 driver 权威态
  // （这些态由 driver 实时掌握，比文件 mtime 更准）。
  if ((ps.state === 'idle' || ps.state === 'done') && fileMtimeMs > driverLast && fileState !== 'idle') {
    state = fileState
  }
  return { state, lastActiveAt }
}

/** Native lifecycle is accumulated across incremental scans; unrelated log writes do not reopen a turn. */
export function advanceShadowTurn(previous, record, engine) {
  const p = engine === 'codex' ? record.payload : record
  if (engine === 'codex' && record.type !== 'event_msg') return previous
  const type = p?.type
  const starts = engine === 'codex' ? ['task_started'] : ['turn.prompt', 'turn.started', 'agent.turn.started']
  const ends = engine === 'codex' ? ['task_complete', 'turn_aborted'] : ['turn.ended', 'agent.turn.ended', 'prompt.completed']
  const id = p?.turn_id ?? p?.turnId ?? null
  if (starts.includes(type)) return { running: true, id }
  if (ends.includes(type)) {
    // An older turn's delayed completion must not close the current turn.
    if (id && previous?.id && id !== previous.id) return previous
    return { running: false, id: id ?? previous?.id ?? null }
  }
  return previous
}

export function isCodexSubagent(source) {
  return source === 'subagent' || !!(source && typeof source === 'object' && source.subagent)
}

/** Explicit completion wins over mtime; old transcripts without lifecycle retain the legacy fallback. */
export function shadowStateOf(mtimeMs, projActive, now, turn = null) {
  const age = now - mtimeMs
  if (turn?.running === true && (projActive || age < 90_000)) return 'running'
  if (turn?.running !== false && age < 90_000) return 'running'
  if (projActive && age < 30 * 60_000) return 'waiting_input'
  return 'idle'
}
