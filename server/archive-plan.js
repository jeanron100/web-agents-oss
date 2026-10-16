// server/archive-plan.js — 归档采集的**纯决策核**（openspec change: execution-history-archive）
//
// 只回答三个问题，不做任何 I/O：
//   ① 哪些文件要采（排除探针残留）
//   ② 每个文件从哪个字节开始读
//   ③ 上报帧怎么切、幂等键怎么算
//
// ★ 为什么抽成纯函数：P0（采集 + 原文归档）是整个变更里**唯一不可逆**的一层——
//   L1~L4 都能推倒重做，而 L0 漏采的那段**永远补不回来**。所以判定逻辑必须能脱离
//   机器、脱离网络被反复验证。
//
// ★ 续扫判据**复用 `resume-guard.js#canResume`，不写第四份**。Claude/Codex/Kimi 三侧
//   已经共用它；采集器是第四个使用方。本仓库有过「同一判据写多份、迟早漂移、然后某一份
//   在最需要保守时 fail-open」的教训。

import crypto from 'node:crypto'
import { canResume } from './resume-guard.js'

/** 单个上报帧的目标字节数。单会话实测可达 74 MB，绝不能一帧发完。 */
export const ARCHIVE_BATCH_BYTES = Number(process.env.WA_ARCHIVE_BATCH_BYTES) || 256 * 1024

/** 探针 scratch 目录（语义上只可能装探针残留，可整目录忽略）。 */
const PROBE_PROJECTS = new Set(['-tmp-wa-usage-probe'])
/**
 * Kimi 额度探针的工作目录（2026-08-29 从**真实归档**里发现的，不是设计时想到的）：
 * `kimi-usage.js` 用 `tmux new-session -c /tmp` 起探针，Kimi 自己按 cwd 建
 * `wd_tmp_<hash>` / `wd_root_<hash>` 会话目录。归档里已经混进来一批
 * 「只回复两个字：就绪」这类内容——**纯噪声，会稀释检索质量**。
 * ★ 又一次印证：探针必须在采集期排除，事后在中心库里逐条判别永远做不干净。
 */
const PROBE_DIR_RE = /^wd_(tmp|root)_[0-9a-f]{6,}$/
/** `-root` 下的一次性 `--print` 记录：实测一次约 11 KB、行数极少。 */
const ROOT_PROBE_MAX_BYTES = 64 * 1024
const ROOT_PROBE_MAX_LINES = 40

/**
 * 是否是探针残留，不该进中心库。
 *
 * 实测依据：`189-4` 有 3,404 个 JSONL 却只占 50 MB；`.232` 的 `-root` 目录曾 26 天攒下
 * **8,195 个文件 / 146 MB** 全是 `claude --print /usage` 的一次性记录。
 *
 * ⚠️ **`-root` 里混着真实交互会话**（实测 8,197 个里正好有 2 个是），所以这里对 `-root`
 * 用「体量 + 行数」双阈值而不是一刀切——**误杀一条真实会话就是永久丢历史**，
 * 而漏收一条探针只是多占几 KB。两类错误的代价不对称，判据要偏向保守。
 */
export function isProbeResidue({ project, bytes = 0, lines = 0 } = {}) {
  if (!project) return false
  if (PROBE_PROJECTS.has(project)) return true
  if (PROBE_DIR_RE.test(project)) return true
  if (project === '-root') return bytes <= ROOT_PROBE_MAX_BYTES && lines <= ROOT_PROBE_MAX_LINES
  return false
}

/**
 * 每个文件本轮从哪读到哪。
 *
 * @param files [{ path, st: {ino, size} }]
 * @param checkpoints { [path]: { generation, fileSize, offset } }
 * @returns [{ path, from, to, generation, reason }] —— 无新增字节的文件**不产生任务**
 */
export function planFileReads(files, checkpoints = {}) {
  const out = []
  for (const f of files ?? []) {
    const st = f?.st
    if (!st || !Number.isFinite(st.size)) continue
    const ck = checkpoints[f.path] ?? null
    let from = 0
    let reason = 'new'
    if (ck) {
      if (canResume(ck, st)) { from = ck.offset; reason = 'resume' }
      else if (String(ck.generation) !== String(st.ino)) reason = 'generation-changed'
      else reason = 'truncated'          // 同世代但 size 变小 / offset 越界
    }
    if (from >= st.size) continue        // 稳态：没有新增字节就不产生任务，不空转
    out.push({ path: f.path, from, to: st.size, generation: String(st.ino), reason })
  }
  return out
}

/**
 * 把读到的文本切成上报帧。
 *
 * ★ `safeEnd` 必须卡在**最后一个换行符之后**——正在被写的半行本轮不碰。
 *   与 `scanFile` 同一条纪律：offset 推过半行，下轮会把后半截当成新行的开头，
 *   内容错乱**且不报错**。
 */
export function frameBatches({ from = 0, text = '' } = {}) {
  const lastNl = text.lastIndexOf('\n')
  if (lastNl < 0) return { batches: [], safeEnd: from }   // 整块无换行 ⇒ 不推进
  const usable = text.slice(0, lastNl + 1)
  const lines = usable.split('\n')
  lines.pop()                                             // split 产生的尾部空串
  const batches = []
  let cur = []
  let curBytes = 0
  let cursor = from
  let batchStart = from
  for (const line of lines) {
    const n = Buffer.byteLength(line) + 1
    if (cur.length && curBytes + n > ARCHIVE_BATCH_BYTES) {
      batches.push({ from: batchStart, to: cursor, lines: cur })
      cur = []; curBytes = 0; batchStart = cursor
    }
    cur.push(line); curBytes += n; cursor += n
  }
  if (cur.length) batches.push({ from: batchStart, to: cursor, lines: cur })
  return { batches, safeEnd: from + Buffer.byteLength(usable) }
}

/**
 * 幂等键：**只由「机器 + 路径 + 文件世代 + 字节区间」决定，与内容无关**。
 *
 * 与内容无关是关键：同一区间因重试被重读时，即便解析结果有微小差异，也必须判为同一份。
 * 若把内容纳入键，重试就会在中心库里制造重复。
 * 世代（inode）必须在键里：否则文件被重建后从 0 重采，会被当成旧文件的重发而**被丢弃**。
 */
export function idempotencyKey({ host, path, generation, from, to }) {
  return crypto.createHash('sha1')
    .update(`${host} ${path} ${generation} ${from} ${to}`)
    .digest('base64url').slice(0, 22)
}
