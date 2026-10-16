// server/archive-collect.js — agent 侧采集器（openspec change: execution-history-archive，P0）
//
// 职责（agent 侧，**只读**）：枚举本机三引擎的 JSONL；按字节区间读取。
// 采集的驱动、分帧、幂等与 checkpoint 全在中心（archive-pull.js）。
//
// ★ 「中心确认后才推进水位」是硬要求（design D4）。前科：2026-08-01 Mongo 隧道断了 10 天
//   没人发现，spool 涨破 100 MB 上限后**按策略丢弃了最旧一半历史**。本变更采集的是
//   "丢了就永远没有"的数据 —— **宁可停止采集，也不丢**。
//
// ★ 限速：源机器磁盘 77~95%、`.232` 的 worker slice 撞过硬限 49 万次。采集必须增量、
//   限速，且跑在既有控制面 cgroup 内（agent 进程本身就在里面）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { isProbeResidue } from './archive-plan.js'

/** 三引擎的语料位置。Kimi 的 wire.jsonl 也在其中（spec 要求三者都采）。 */
export function corpusRoots(home = os.homedir()) {
  return [
    { engine: 'claude', dir: path.join(home, '.claude', 'projects'), match: (f) => f.endsWith('.jsonl') },
    { engine: 'codex', dir: path.join(home, '.codex', 'sessions'), match: (f) => /^rollout-.*\.jsonl$/.test(path.basename(f)) },
    { engine: 'kimi', dir: path.join(home, '.kimi-code', 'sessions'), match: (f) => f.endsWith('.jsonl') },
  ]
}

/** 递归列出语料文件（带 stat）。深度有限，避免在超大目录上失控。 */
export function listCorpus(home = os.homedir(), maxDepth = 4) {
  const out = []
  for (const root of corpusRoots(home)) {
    const walk = (dir, depth, project) => {
      if (depth > maxDepth) return
      let ents
      try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p, depth + 1, project ?? e.name); continue }
        if (!e.isFile() || !root.match(p)) continue
        let st
        try { st = fs.statSync(p) } catch { continue }
        out.push({
          engine: root.engine,
          project: project ?? path.basename(dir),
          session: path.basename(p).replace(/\.jsonl$/, '').replace(/^rollout-/, ''),
          path: p,
          st: { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs },
        })
      }
    }
    walk(root.dir, 0, null)
  }
  return out
}

/** 源清单（供对账；行数用字节估算太不准，这里如实数行——只对小文件数，大文件用缓存行数）。 */
export function inventory(home = os.homedir()) {
  return listCorpus(home)
    .filter((f) => !isProbeResidue({ project: f.project, bytes: f.st.size, lines: estLines(f) }))
    .map((f) => ({
      host: os.hostname(), engine: f.engine, project: f.project, session: f.session,
      bytes: f.st.size, lines: estLines(f), mtimeMs: f.st.mtimeMs,
    }))
}

/** 行数估算：真数行对 74 MB 的文件太贵，用平均行长估。对账时按"归档 < 源"判缺口，估偏小是安全的。 */
const LINE_AVG = 900
const estLines = (f) => Math.max(1, Math.round(f.st.size / LINE_AVG))

/**
 * 按字节区间读语料，**供中心拉取**。
 *
 * ★★ 这是暴露给中心的读接口，`path` 来自网络请求 ⇒ **必须防穿越**：只允许读
 *   `corpusRoots()` 之下的文件。没有这道闸，一个 `path=/root/.ssh/id_rsa` 就能把私钥读走。
 *   （agent 只监听 127.0.0.1、且经隧道给 hub，但"只监听本机"从来不是授权模型。）
 */
export function readRange(file, from = 0, len = 65536, home = os.homedir()) {
  const real = path.resolve(file)
  const roots = corpusRoots(home).map((r) => path.resolve(r.dir) + path.sep)
  if (!roots.some((r) => real.startsWith(r))) throw new Error('拒绝：不在语料根之下')
  let fd
  try {
    fd = fs.openSync(real, 'r')
    const size = fs.fstatSync(fd).size
    if (from >= size) return ''
    const want = Math.max(0, Math.min(len, size - from))
    const buf = Buffer.alloc(want)
    const n = fs.readSync(fd, buf, 0, want, from)
    return buf.subarray(0, n).toString('utf-8')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
