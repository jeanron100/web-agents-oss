// server/archive-recon.js — 归档对账（openspec change: execution-history-archive，P0 验收线）
//
// 纯函数：拿「源机器清单」与「中心 manifest」两条路径对账，报出**差集**。
//
// ★ 为什么这是验收线而不是锦上添花：一个「看着在跑其实没在采」的采集器，外观与正常的
//   **完全相同**——没有报错、指标也在动。本仓库多次证明只有"拿两条路径对账"才能发现
//   静默缺陷（`/api/state` 曾返回 72 条会话却只有 71 个唯一 id，任何测试都没发现，
//   是影子对照报出 `kind:"length" a:31 b:32` 才挖出来的）。
//
// ★★ 必须报**差集**而不是总数：总数相等不代表内容相同（可能两边各多一条），
//   而且"少了 3 条"无法行动——你得知道少的是**哪三条**才能去查。

const idOf = (x) => `${x.host}/${x.project}/${x.session}`

/**
 * @param source   源机器清单 [{host, project, session, engine, lines}]
 * @param archived 中心 manifest，同构
 * @param opts.limit 差集封顶条数（真实数量仍如实报在 *Total 里）
 */
export function reconcile(source = [], archived = [], { limit = 200 } = {}) {
  const srcMap = new Map((source ?? []).map((x) => [idOf(x), x]))
  const arcMap = new Map((archived ?? []).map((x) => [idOf(x), x]))

  const missing = []   // 源有、中心没有
  const extra = []     // 中心有、源没有（源被清理过，或坐标算错了）
  const partial = []   // 两边都有但行数对不上（"半采"——最危险：清单里有它，看着像完整）

  for (const [id, s] of srcMap) {
    const a = arcMap.get(id)
    if (!a) { missing.push(s); continue }
    // 源仍在增长时采集领先一拍是正常的，只有**归档少于源**才算缺口
    if (Number(a.lines || 0) < Number(s.lines || 0)) {
      partial.push({
        host: s.host, project: s.project, session: s.session,
        source: Number(s.lines || 0), archived: Number(a.lines || 0),
      })
    }
  }
  for (const [id, a] of arcMap) if (!srcMap.has(id)) extra.push(a)

  const byEngine = {}
  const bump = (e, k) => {
    const g = byEngine[e] ?? (byEngine[e] = { source: 0, archived: 0 })
    g[k] += 1
  }
  for (const s of srcMap.values()) bump(s.engine || 'unknown', 'source')
  for (const [id, a] of arcMap) if (srcMap.has(id)) bump(a.engine || 'unknown', 'archived')
  for (const e of Object.keys(byEngine)) if (!byEngine[e].archived) byEngine[e].archived = 0

  const sourceTotal = srcMap.size
  const covered = sourceTotal - missing.length
  return {
    sourceTotal,
    archivedTotal: arcMap.size,
    // ⚠️ 源为空时返回 **null 不是 1**：返回 1 会被看门狗判成"完美覆盖"，
    //    等于空闲期把告警焊死在绿灯上（与 state_full_ratio 样本不足返回 null 同理）。
    coverage: sourceTotal ? Number((covered / sourceTotal).toFixed(4)) : null,
    missing: missing.slice(0, limit),
    missingTotal: missing.length,
    extra: extra.slice(0, limit),
    extraTotal: extra.length,
    partial: partial.slice(0, limit),
    partialTotal: partial.length,
    truncated: missing.length > limit || extra.length > limit || partial.length > limit,
    byEngine,
  }
}
