// server/resume-guard.js — JSONL 增量续扫的**唯一**有效性判据。
//
// Claude / Codex / Kimi 三侧共用这一份，不许各写各的。
// 本仓库有过「同一判据写多份、迟早漂移、然后某一份在最需要保守时 fail-open」的教训
// （`deploy-agent.sh` 与 `restart.sh` 正是靠共用 `maintenance.js#restartBlockers` 才没出事）。
//
// ★ Codex 侧从「慢但对」改成「快」的过程中，最大的风险是变成「快但错」：
//   判据一旦失守，症状不是报错，而是 **offset 被推到别的文件世代上** ⇒ 事件与 token 全部错位，
//   而界面看起来完全正常。inode / truncate 判据是唯一防线。
//
// 语义逐字取自 agent.js 原 Claude 侧内联实现：
//   hit?.state && hit.state.generation === String(st.ino)
//              && st.size >= hit.size
//              && hit.state.offset <= st.size
// 等价性由 resume-guard.test.mjs 的「与 agent.js 原内联判据逐例等价」一条钉住。

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * 运行时回退开关（spec「增量实现必须与全量解析逐字段等价，且可一键回退」）。
 *
 * ★ 开关放在**判据这一层**，不放在各调用点：判据是三侧共用的唯一真相源，
 *   在这里关掉，Claude/Codex/Kimi 三条路径**一次性**全部退回全量扫描。
 *   若分散在各调用点，回退时必然漏掉一处——而漏掉的那处不报错，只是行为不一致。
 *
 * ★ **只有显式 `"0"` 才关闭**。拼错成 `WA_JSONL_INCREMENTAL=flase` 时保持开启，
 *   而不是当成关闭——静默退回全量扫描不报错、只变慢，是最难发现的一类故障。
 *
 * 回退方式：`Environment=WA_JSONL_INCREMENTAL=0` + 重启，**不需要回滚代码**。
 */
export const incrementalEnabled = () => process.env.WA_JSONL_INCREMENTAL !== '0'

/**
 * 能否从 checkpoint 继续增量解析。
 *
 * @param {{generation?: string|number, fileSize?: number, offset?: number}|null} ckpt
 *        generation = 文件世代（inode）。历史上以字符串存储，这里两种都认——
 *        若严格比较字符串与数字，会永远 false ⇒ **永远全量重扫**，而且完全静默（只是慢）。
 * @param {{ino?: number, size?: number}|null} st  fs.statSync 的结果
 * @returns {boolean} 四条件全部成立才为 true；任何不确定一律 false（保守优先）
 */
export function canResume(ckpt, st, { enabled } = {}) {
  // 开关只决定"能不能续"，不放宽任何判据——关掉后一律走全量，是**更保守**的方向。
  if (!(enabled === undefined ? incrementalEnabled() : enabled)) return false
  if (!ckpt || !st) return false

  const gen = ckpt.generation
  if (gen === undefined || gen === null) return false
  if (!finite(st.ino)) return false
  if (String(gen) !== String(st.ino)) return false          // ① 同世代（inode 未变）

  if (!finite(ckpt.fileSize) || !finite(st.size)) return false
  if (st.size < ckpt.fileSize) return false                  // ② 只增长（append-only）

  if (!finite(ckpt.offset)) return false
  if (ckpt.offset < 0 || ckpt.offset > st.size) return false // ③④ offset 合法

  return true
}

/** 从一次扫描的结果构造 checkpoint。集中在这里，避免各处各拼各的形状。 */
export function makeCheckpoint({ ino, size, offset }) {
  return { generation: String(ino), fileSize: size, offset }
}
