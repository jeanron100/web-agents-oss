// server/archive-store.js — 中心原文归档层（openspec change: execution-history-archive，P0）
//
// 职责：把 agent 推上来的原始 JSONL 行**幂等地**落到分片文件，并维护可对账的清单。
// 落在 `.189.4`（design D11：它已是数据面中心，Mongo/Redis/hub 都在本机）。
//
// ★ 为什么原文走文件而不是 Mongo：单会话实测可达 **74 MB**，远超 Mongo 16 MB 文档上限，
//   塞进去必然要分块——那还不如按行分片存文件，与 JSONL 的 append-only 形态同构，
//   还能直接 `zcat | grep` 排障。抽取层才走 Mongo。
//
// ★ 幂等是硬要求：agent 侧「中心确认后才推进水位」意味着**重发是常态**（design D4）。
//   判重失效不会报错，只会让中心库悄悄长出重复行。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_BASE = process.env.WA_ARCHIVE_DIR
  || path.join(process.env.HOME || '/root', '.web-agents', 'archive')

/** 文件名安全化：agent 上报的坐标来自文件系统路径，**当成不可信输入**。 */
// 只保留安全字符，并把点串折叠成单点——`..` 留在文件名里逃不出去，但会误导排障的人。
const safe = (s) => String(s ?? '')
  .replace(/[^A-Za-z0-9._-]/g, '_')
  .replace(/\.{2,}/g, '.')
  .replace(/^[.]+/, '_')
  .slice(0, 120) || '_'

/**
 * 分片路径：`<base>/<host>/<project>/<session>.jsonl`。
 * ⚠️ 三段都经 `safe()`，保证结果**不可能逃出 base**（含 `..` 穿越）。
 */
export function shardPath(base, { host, project, session }) {
  return path.join(base, safe(host), safe(project), `${safe(session)}.jsonl`)
}

const metaPath = (base) => path.join(base, '_manifest.json')

/**
 * 建一个归档存储。
 *
 * ⚠️ **manifest 与幂等集合必须能从盘上恢复**：进程重启后若判重失效，中心库会长出重复行
 * 而无人察觉；即便只是重收，也会白烧跨境带宽。所以两者一起持久化。
 */
export function createArchiveStore(base = DEFAULT_BASE) {
  fs.mkdirSync(base, { recursive: true })
  let meta = { keys: {}, sessions: {} }
  try {
    const raw = fs.readFileSync(metaPath(base), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      meta = { keys: parsed.keys ?? {}, sessions: parsed.sessions ?? {} }
    }
  } catch { /* 首次运行或文件损坏：从空开始重建，重收一遍好过判重失效 */ }

  let dirty = false
  const persist = () => {
    if (!dirty) return
    const tmp = `${metaPath(base)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(meta))
    fs.renameSync(tmp, metaPath(base))          // 原子替换，避免半截文件
    dirty = false
  }

  return {
    /**
     * 收一帧。返回 `{written, duplicate?, rejected?}`。
     * 同一 `key` 重复提交只落一份（`key` 由 archive-plan.js#idempotencyKey 算，
     * 含文件世代，故文件重建后的重采**不会**被当成重发丢掉）。
     */
    async accept(frame) {
      const { host, project, session, engine, key, lines } = frame ?? {}
      if (!host || !session || !key || !Array.isArray(lines) || lines.length === 0) {
        return { written: 0, rejected: true }
      }
      if (meta.keys[key]) return { written: 0, duplicate: true }

      const f = shardPath(base, { host, project, session })
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, lines.join('\n') + '\n')   // 只追加，绝不覆盖

      meta.keys[key] = 1
      const id = `${safe(host)}/${safe(project)}/${safe(session)}`
      const prev = meta.sessions[id] ?? { host, project, session, engine, lines: 0 }
      prev.lines += lines.length
      prev.lastAt = Date.now()
      prev.engine = engine ?? prev.engine
      meta.sessions[id] = prev
      dirty = true
      persist()
      return { written: lines.length }
    },

    /** 对账用清单：每个会话的坐标与已归档行数。 */
    manifest() {
      return Object.values(meta.sessions)
    },

    stats() {
      const s = Object.values(meta.sessions)
      return {
        sessions: s.length,
        lines: s.reduce((n, x) => n + (x.lines || 0), 0),
        keys: Object.keys(meta.keys).length,
      }
    },

    base,
  }
}
