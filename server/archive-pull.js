// server/archive-pull.js — 中心侧采集驱动（openspec change: execution-history-archive，P0）
//
// ★ 方向订正（2026-08-29，实测推翻了 design D11 的初稿）：
//   初稿写「`.189.4` 没有出站 SSH ⇒ 采集只能 agent 主动推」。**那个推理是错的**——
//   隧道是各 agent **主动建**的反向隧道，hub 用的是本机转发口（`hub-config.json` 的
//   `agents[].url`），它每 5 秒就靠这条路轮询 `/api/state`。hub 拉取**不需要任何出站 SSH，
//   也不需要新链路**。
//
//   而且 hub 拉严格更好：**checkpoint 集中在中心**，于是「中心确认后才推进水位」
//   （design D4 的硬要求）变成**天然成立**——落盘和推进水位在同一个进程、同一个函数里，
//   不存在"agent 以为送到了、其实中心没落库"的窗口。agent 侧只需两个只读端点。
//
// 本模块是纯驱动：I/O 全部注入，可脱离机器测试。

import { planFileReads, frameBatches, idempotencyKey } from './archive-plan.js'

/** 每台机每轮的读取上限——限速闸。源机磁盘 77~95%，不能一轮拉几百 MB。 */
export const PULL_ROUND_BYTES = Number(process.env.WA_ARCHIVE_ROUND_BYTES) || 8 * 1024 * 1024

/** path → engine，供轮转用 */
const byPathEngine = (files) => new Map((files ?? []).map((f) => [f.path, f.engine ?? 'unknown']))

/** 把计划按引擎轮转交错，让每个引擎每轮都有进展（否则靠后的引擎会被前面的大引擎饿死）。 */
export function interleaveByEngine(plans, engineOf) {
  const buckets = new Map()
  for (const p of plans ?? []) {
    const e = engineOf.get(p.path) ?? 'unknown'
    if (!buckets.has(e)) buckets.set(e, [])
    buckets.get(e).push(p)
  }
  const lists = [...buckets.values()]
  const out = []
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i])
  }
  return out
}

/**
 * 拉一台 agent 一轮。
 *
 * @param client   { inventory(): Promise<file[]>, read(path, from, len): Promise<string> }
 *                 file = { engine, project, session, path, st:{ino,size} }
 * @param store    archive-store 的实例（accept 幂等）
 * @param ckpt     该机的 checkpoint 对象（**由调用方持久化**）
 * @returns {{files, frames, lines, bytes, blocked, error?}}
 */
export async function pullOnce({ host, client, store, ckpt, roundBytes = PULL_ROUND_BYTES }) {
  let files
  try { files = await client.inventory() } catch (e) {
    // agent 不可达：本轮什么都不做，**水位一动不动**。下轮原地重来。
    return { files: 0, frames: 0, lines: 0, bytes: 0, blocked: true, error: String(e?.message ?? e) }
  }
  // ★ 按引擎轮转（2026-08-29 实测修正）：枚举顺序是 claude → codex → kimi，而每轮有字节上限。
  //   实测 177-188 上 claude 待采 393.8 MB、codex 171.7 MB、kimi 1.0 MB，8 MB/轮 ⇒
  //   **claude 要跑 50 轮才轮得到 codex，kimi 要等 70 轮**。那不是"路不通"，是被顺序饿死，
  //   但对账看到的是一样的 0 —— 分不清「还没轮到」和「根本没通」，是最坏的一种。
  //   轮转后每轮三个引擎都有进展，对账的 byEngine 立刻具备判别力。
  const plans = interleaveByEngine(planFileReads(files, ckpt), byPathEngine(files))
  const byPath = new Map((files ?? []).map((f) => [f.path, f]))

  let frames = 0, lines = 0, bytes = 0, touched = 0
  for (const p of plans) {
    if (bytes >= roundBytes) break
    const meta = byPath.get(p.path)
    if (!meta) continue
    // ★ 单文件配额（2026-08-29 实测补齐）：只做引擎轮转还不够——**一个大文件仍会吃掉整轮**。
    //   实测存在 74 MB 的单会话，没有这道闸它会永远霸占每一轮，后面的文件/引擎永远轮不到，
    //   而对账看到的仍旧是 0，分不清「还没轮到」和「根本没通」。
    //   给每个文件切一片，保证一轮里至少有若干个文件/引擎都能推进。
    //   配额按轮预算等比例切（生产 8 MB/轮 ⇒ 每文件 1 MB）。**不要加固定下限**——
    //   下限一旦大于 roundBytes 就把整个配额机制架空了（我第一版写 64 KB 下限，
    //   测试里 roundBytes=3000 时它直接失效，配额形同虚设）。
    const perFile = Math.max(1, Math.floor(roundBytes / 8))
    const want = Math.min(p.to - p.from, roundBytes - bytes, perFile)

    let text
    try { text = await client.read(p.path, p.from, want) } catch (e) {
      // 单个文件读失败不该拖垮整轮，但**该文件的水位不推进**
      return { files: touched, frames, lines, bytes, blocked: true, error: String(e?.message ?? e) }
    }
    const { batches, safeEnd } = frameBatches({ from: p.from, text })
    if (!batches.length) continue

    for (const b of batches) {
      const r = await store.accept({
        host, engine: meta.engine, project: meta.project, session: meta.session,
        filePath: p.path, generation: p.generation, from: b.from, to: b.to,
        key: idempotencyKey({ host, path: p.path, generation: p.generation, from: b.from, to: b.to }),
        lines: b.lines,
      })
      // ★ 落库没成功就立刻停手且不推进水位 —— 宁可停采也不丢（design D4）。
      //   前科：2026-08-01 spool 涨破上限后**按策略丢弃了最旧一半历史**。
      if (!r || (r.rejected && !r.duplicate)) {
        return { files: touched, frames, lines, bytes, blocked: true, error: 'store rejected' }
      }
      frames += 1
      lines += r.written ?? 0
    }
    ckpt[p.path] = { generation: p.generation, fileSize: meta.st.size, offset: safeEnd }
    bytes += Buffer.byteLength(text)
    touched += 1
  }
  return { files: touched, frames, lines, bytes, blocked: false }
}
