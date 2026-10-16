import fs from 'node:fs/promises'
import { progressEvents, tasksFromEvents } from './progress-evidence.js'

// Checkpoints advance only after evidence is durably committed. Read bounded
// chunks from existing local archives; never re-enable wholesale CLI capture.
export function createProgressBackfill({ listSources, readSource, repository, checkpointFile, now = Date.now }) {
  let checkpoints = {}, loaded, running, lastError = null, summary = { total: 0, imported: 0, partial: 0, failed: 0 }
  const ready = () => loaded ||= fs.readFile(checkpointFile, 'utf8').then(t => { checkpoints = JSON.parse(t) }).catch(() => {})
  const status = () => ({ ...summary, running: !!running, error: lastError })
  return {
    status,
    run() {
      if (running) return running
      running = (async () => {
        await ready()
        const listing = await listSources(), sources = Array.isArray(listing) ? listing : listing.sources, deadline = now() + 2500
        summary = { total: sources.length, imported: 0, partial: 0, failed: 0 }
        if (listing.unavailableSources?.length) summary.unavailableSources = listing.unavailableSources
        for (const s of sources) {
          const p = checkpoints[s.key]
          if (p?.done && p.lines === s.lines && !p.skippedLines) summary.imported++
          else if (p?.offset) summary.partial++
          if (p?.error) summary.failed++
        }
        let bytes = 0, files = 0, storeFailed = false
        for (const s of [...sources].sort((a,b) => (checkpoints[a.key]?.checkedAt || 0)-(checkpoints[b.key]?.checkedAt || 0))) {
          if (now() > deadline || bytes >= 8 * 1024 * 1024 || files >= 500) break
          const prev = checkpoints[s.key] || {}
          if (prev.done && prev.lines === s.lines) continue
          // Retry failed files on later rounds without starving all later sources.
          if (prev.error && !String(prev.error).includes('读取上限') && now() - prev.checkedAt < 300000) continue
          files++
          let fd, storing = false
          try {
            if (!readSource) fd = await fs.open(s.file, 'r')
            const st = readSource ? { size: s.size } : await fd.stat()
            const offset = prev.offset > st.size ? 0 : prev.offset || 0
            const want = Math.min(4 * 1024 * 1024, st.size-offset)
            let buffer, bytesRead
            if (readSource) {
              buffer = Buffer.from(await readSource(s, offset, want), 'utf8')
              bytesRead = buffer.length
            } else {
              buffer = Buffer.alloc(want)
              bytesRead = (await fd.read(buffer, 0, buffer.length, offset)).bytesRead
            }
            let skippedLines = prev.skippedLines || 0, first = 0
            const newline = buffer.indexOf(10)
            // Huge image/tool rows must not permanently block all later dialogue.
            // Preserve the original file and disclose the gap; clear the task
            // carry because the unread row may have been a new instruction.
            if (newline < 0 && want && (prev.discardingLine || offset+want<st.size || want>=4*1024*1024)) {
              storing = true; await repository.put([]); storing = false
              checkpoints[s.key] = { offset:offset+want,done:offset+want>=st.size,lines:s.lines,checkedAt:now(),
                skippedLines:skippedLines+(prev.discardingLine?0:1),discardingLine:true,timestamp:prev.timestamp }
              bytes += want; continue
            }
            let correction = 0
            if (readSource && prev.discardingLine && buffer.subarray(0,3).toString('utf8') === '\uFFFD') {
              // A string-only remote range can start inside a UTF-8 character.
              // Locate the physical newline with at most seven one-byte probes,
              // rather than drifting the byte checkpoint after replacement chars.
              for (let delta=0;delta<=6;delta++) if (await readSource(s,offset+newline-delta,1)==='\n') { correction=delta;break }
            }
            if (prev.discardingLine) first=newline+1
            let end = bytesRead
            if (offset+want < st.size) end=buffer.subarray(0,end).lastIndexOf(10)+1
            const consumed = readSource && offset+want>=st.size ? want : end-correction
            const text = buffer.subarray(first,end).toString('utf8')
            const carry = offset && !prev.discardingLine ? prev.carry || (prev.lastTaskId && repository.get ? await repository.get(prev.lastTaskId) : null) : null
            const tasks = tasksFromEvents(progressEvents(text, s.engine, { timestamp: prev.timestamp }), {
              serverId: s.serverId, project: s.project, sessionId: s.sessionId, engine: s.engine,
              sourceKind: readSource ? 'native_history' : 'archive', archiveProject: s.archiveProject, sourceTruncated: skippedLines>0,
            }, { carry, limit: 10000 })
            storing = true
            await repository.put(tasks)
            storing = false
            const done = offset + consumed >= st.size
            checkpoints[s.key] = { offset: offset + consumed, done, lines: s.lines, checkedAt: now(),skippedLines,
              lastTaskId: tasks.at(-1)?.id || prev.lastTaskId, timestamp: tasks.at(-1)?.updatedAt || prev.timestamp,
              ...(!done || readSource ? { carry: tasks.at(-1) || carry || null } : {}) }
            if (done) summary.imported++
            bytes += consumed
          } catch (e) {
            // Stop on store failure: continuing would consume archives without
            // committing them. Individual missing files can be skipped and retried.
            if (storing) { lastError = '历史沉淀暂停：知识库存储暂不可用，检查点未推进'; storeFailed = true; break }
            checkpoints[s.key] = { ...prev, error: String(e.message).slice(0, 200), checkedAt: now() }; summary.failed++
          } finally { await fd?.close() }
          if (files % 10 === 0) await new Promise(resolve => setTimeout(resolve, 15))
        }
        await fs.writeFile(checkpointFile + '.tmp', JSON.stringify(checkpoints), { mode: 0o600 })
        await fs.rename(checkpointFile + '.tmp', checkpointFile)
        summary.caughtUp = sources.filter(s => checkpoints[s.key]?.done && checkpoints[s.key]?.lines === s.lines).length
        summary.imported = sources.filter(s => checkpoints[s.key]?.done && checkpoints[s.key]?.lines === s.lines && !checkpoints[s.key]?.skippedLines).length
        summary.partial = sources.filter(s => checkpoints[s.key]?.offset && !(checkpoints[s.key]?.done && checkpoints[s.key]?.lines === s.lines && !checkpoints[s.key]?.skippedLines)).length
        summary.failed = sources.filter(s => checkpoints[s.key]?.error).length
        summary.limitedSources = sources.filter(s=>checkpoints[s.key]?.skippedLines).length
        summary.skippedLargeLines = sources.reduce((n,s)=>n+(checkpoints[s.key]?.skippedLines||0),0)
        if(summary.limitedSources) summary.limitWarning=`${summary.limitedSources}个来源有超大单行未解析，原始日志保留；后续文字继续沉淀，未计为完整覆盖。`
        if (!storeFailed) lastError = summary.failed ? '部分归档暂不能读取，已保留原始文件并等待重试' : summary.unavailableSources?.length ? `部分节点不可达：${summary.unavailableSources.join('、')}，保留已有证据` : null
      })().catch(() => { lastError = '历史沉淀暂不可用，原始归档未改动' }).finally(() => { running = null })
      return running
    },
  }
}
