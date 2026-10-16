// server/projection-store.js — JSONL 派生态的持久化（Persistence V1，P3）。
//
// 为什么存在：`summaryCache` 是裸 Map，agent 一重启全丢 ⇒ 首个 /api/state 对每个会话全量重扫。
// 而 checkpoint 的结构 `{generation, offset, evSeq}` 在 agent.js 里**早就算好了，只是从没写过盘**。
//
// ★ 只存字节 offset 是**不够的**，存了也白存。
//   解析是有状态的：tok 四桶 / daily / dailyCost / dayTokComp / hourly / hourlyCost /
//   activeMs / prevTs / dailyActiveMs / firstPrompt 全是跨行累积量。
//   从第 N 字节续算，必须同时知道"截至 N 时这些量是多少"。
//   （这也正是 Fluent Bit 的 offset DB 顶不上用的原因——它只记字节。）
//
// ★ 范围：**只持久化 summary 侧，不持久化 events。**
//   `/api/state` 只要 summary；events 是用户点开某个会话才要的，那时冷扫一个文件可接受。
//   若把 400 条事件 × 上千会话也写盘，分片会失控，收益全被 IO 吃掉。
//
// ★ 分片：按项目一片。全局单文件要装上万条，每次更新整份重写（数 MB）不可接受；
//   按项目分片后单片通常 <100KB，且天然对齐 ~/.claude/projects/<enc-cwd>/ 的结构。
//
// 原子写复用 session-store.js 的 atomicWriteFile / loadStore（tmp→fsync→rename→fsync(dir)
// →0600，主文件坏回退 .bak）——那套范式在本仓库已长期运行，不重新发明。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteFile, loadStore } from './session-store.js'

/** 投影文件格式版本。改变分片结构时 +1，旧分片一律作废重建。 */
export const PROJECTION_VERSION = 1
/** 解析语义版本。改 parser 的产出含义时 +1（由 agent.js 传入）。 */
// 2 = assistant token 按 message.id 去重（2026-09-05）。
// ⚠️ 必须 bump：磁盘上那批检查点里的 `tok`/`daily`/`hourly`/`dayTokComp` 是**按旧语义
//   逐行累加出来的虚高值**（实测虚高 52.8%）。不作废它们，续扫会在错的基数上接着加，
//   而且界面看不出任何异常——只是数字一直是错的。
// 3 = Codex response_item assistant replies are included in summaries/activity.
export const DEFAULT_PARSER_VERSION = 3

export const DEFAULT_DIR = path.join(os.homedir(), '.web-agents', 'projection')

/** 分片形状校验。必须传给 loadStore/atomicWriteFile——它们默认认的是 platform-sessions 的形状。 */
function parseShard(text) {
  const d = JSON.parse(text)
  if (!d || typeof d !== 'object' || d.projectionVersion === undefined || typeof d.entries !== 'object' || d.entries === null) {
    throw new Error('projection shard: 形状不符')
  }
  return d
}

const shardName = (projectKey) => `${crypto.createHash('sha1').update(String(projectKey)).digest('hex').slice(0, 16)}.json`

/** 只保留可持久化的字段——events 明确排除（见文件头）。 */
function toPersist(rec) {
  if (!rec || typeof rec !== 'object') return null
  const { generation, fileSize, offset, mtimeMs, evSeq, summary,
    codexPrevCum, codexPrev } = rec
  const out = { generation, fileSize, offset, mtimeMs, evSeq, summary }
  // Codex 专有的两组累积量：daily/dayTokComp 走的是 token 累计值的**差值**，
  // 不带走它们，跨重启续算出来的每日 token 会全错（且不报错）。
  if (codexPrevCum !== undefined) out.codexPrevCum = codexPrevCum
  if (codexPrev !== undefined) out.codexPrev = codexPrev
  return out
}

/**
 * @param {object} o
 * @param {string} o.dir 分片目录
 * @param {number} o.parserVersion 解析语义版本；与分片内记录不一致则该分片作废
 */
export function createProjectionStore({ dir = DEFAULT_DIR, parserVersion = DEFAULT_PARSER_VERSION } = {}) {
  const mem = new Map()        // filePath -> record
  const owner = new Map()      // filePath -> projectKey
  const dirty = new Set()      // 脏分片名
  let diskOk = true            // 目录不可写时降级为纯内存

  const shardPath = (name) => path.join(dir, name)

  return {
    /** 启动时读全部分片。任何一片坏掉只作废那一片，绝不影响其它项目，绝不抛。 */
    load() {
      let names = []
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return }
      for (const name of names) {
        let shard
        try { shard = loadStore(shardPath(name), { parseWith: parseShard }) } catch { continue }
        if (!shard || typeof shard !== 'object') continue
        // 版本不符 ⇒ 整片作废。沿用旧 parser 的产物会让新旧语义混在同一份数据里，
        // 症状是数字慢慢变得不可解释，而不是报错。
        if (shard.projectionVersion !== PROJECTION_VERSION) continue
        if (shard.parserVersion !== parserVersion) continue
        const entries = shard.entries
        if (!entries || typeof entries !== 'object') continue
        for (const [file, rec] of Object.entries(entries)) {
          if (!rec || typeof rec !== 'object') continue
          mem.set(file, rec)
          if (shard.projectKey) owner.set(file, shard.projectKey)
        }
      }
    },

    get(file) { return mem.get(file) },

    put(file, projectKey, rec) {
      const p = toPersist(rec)
      if (!p) return
      mem.set(file, p)
      owner.set(file, projectKey)
      dirty.add(shardName(projectKey))
    },

    remove(file) {
      const key = owner.get(file)
      mem.delete(file)
      owner.delete(file)
      if (key) dirty.add(shardName(key))
    },

    /** 只写脏分片。无改动时一个文件都不碰（避免每轮轮询都触发写盘）。 */
    flush() {
      if (!dirty.size || !diskOk) { dirty.clear(); return }
      // 按分片归集
      const byShard = new Map()
      for (const [file, rec] of mem) {
        const key = owner.get(file)
        if (!key) continue
        const name = shardName(key)
        if (!dirty.has(name)) continue
        let s = byShard.get(name)
        if (!s) { s = { projectionVersion: PROJECTION_VERSION, parserVersion, projectKey: key, entries: {} }; byShard.set(name, s) }
        s.entries[file] = rec
      }
      for (const name of dirty) {
        const shard = byShard.get(name) || { projectionVersion: PROJECTION_VERSION, parserVersion, projectKey: '', entries: {} }
        try {
          atomicWriteFile(shardPath(name), JSON.stringify(shard), { validate: parseShard })
        } catch (e) {
          // 磁盘满/权限问题不该让 agent 起不来——投影没了大不了回到今天的行为（重扫）。
          // 但必须喊一声，否则"投影一直没生效"会伪装成"性能没改善"。
          if (diskOk) console.error(`[projection] 落盘失败（${e?.message}）——降级为纯内存，重启后仍会全量重扫`)
          diskOk = false
        }
      }
      dirty.clear()
    },

    stats() {
      const shards = new Set()
      for (const k of owner.values()) shards.add(shardName(k))
      return { entries: mem.size, shards: shards.size, diskOk, parserVersion, projectionVersion: PROJECTION_VERSION }
    },
  }
}
