// Durable task evidence uses the existing MySQL pool. No retention deletion:
// the small recent cache is only a cache, not the history's source of truth.
import { inflateSync } from 'node:zlib'
export function createProgressRepository({ enabled, query }) {
  let initialized, countCache
  const ensure = async () => {
    if (!enabled()) throw new Error('任务知识库暂不可用，新增证据已留在本地待同步')
    if (!initialized) initialized = query(`CREATE TABLE IF NOT EXISTS project_task_evidence (
      id CHAR(24) PRIMARY KEY, server_id VARCHAR(64) NOT NULL,
      project VARCHAR(255) NOT NULL, session_id VARCHAR(128) NOT NULL,
      updated_at BIGINT NOT NULL, status VARCHAR(32) NOT NULL,
      evidence MEDIUMTEXT NOT NULL, search_text MEDIUMTEXT NOT NULL, quality TINYINT NOT NULL DEFAULT 0,
      INDEX idx_scope (server_id, project, updated_at), INDEX idx_time (updated_at)
    ) DEFAULT CHARSET=utf8mb4`).then(async () => {
      try { await query('ALTER TABLE project_task_evidence ADD COLUMN quality TINYINT NOT NULL DEFAULT 0') }
      catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e }
    }).catch(e => { initialized = null; throw e })
    await initialized
  }
  return {
    async put(tasks) {
      await ensure()
      for (let offset = 0; offset < tasks.length; offset += 20) {
        const chunk = tasks.slice(offset, offset + 20)
        const args = chunk.flatMap(t => [t.id,t.serverId,t.project,t.sessionId,t.updatedAt,t.status,JSON.stringify(t),[t.project,t.subject,t.context,t.request,t.result,...(t.causes || []),...(t.lessons || []),...(t.actions || [])].join('\n'), (t.sourceTruncated ? 0 : 2) + (t.causes ? 1 : 0)])
        const newer = '(VALUES(updated_at)>updated_at OR (VALUES(updated_at)=updated_at AND VALUES(quality)>=quality))'
        await query(`INSERT INTO project_task_evidence (id,server_id,project,session_id,updated_at,status,evidence,search_text,quality)
          VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')} ON DUPLICATE KEY UPDATE
          evidence=IF(${newer},VALUES(evidence),evidence),
          search_text=IF(${newer},VALUES(search_text),search_text),
          status=IF(${newer},VALUES(status),status),
          quality=IF(${newer},VALUES(quality),quality),
          updated_at=GREATEST(updated_at,VALUES(updated_at))`, args)
      }
      countCache = null
    },
    async find({ host = '', project = '', from = 0, terms = [], limit = 100 } = {}) {
      await ensure()
      const where = ['updated_at>=?'], args = [from]
      if (host) { where.push('server_id=?'); args.push(host) }
      if (project) { where.push('project=?'); args.push(project) }
      if (terms.length) {
        where.push('(' + terms.slice(0, 12).map(() => "search_text LIKE ? ESCAPE '='").join(' OR ') + ')')
        args.push(...terms.slice(0, 12).map(t => '%' + String(t).replace(/[=%_]/g, c => '=' + c) + '%'))
      }
      // This MySQL is across a slow network. Never transfer hundreds of complete
      // progress arrays to rank candidates. COMPRESS is MySQL's zlib frame with a
      // four-byte length prefix; detailed evidence is fetched individually.
      const value = (key, fallback = "JSON_ARRAY()") => `COALESCE(JSON_EXTRACT(evidence,'$.${key}'),${fallback})`
      const text = (key, length) => `LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(evidence,'$.${key}')),''),${length})`
      const projection = `JSON_OBJECT('id',id,'serverId',server_id,'project',project,'sessionId',session_id,'updatedAt',updated_at,'status',status,
        'title',${text('title',160)},'request',${text('request',800)},'context',${text('context',800)},'subject',${text('subject',300)},
        'engine',${text('engine',16)},'result',${text('result',6000)},'risks',${value('risks')},'causes',${value('causes')},'lessons',${value('lessons')},
        'actions',${value('actions')},'progress',JSON_ARRAY(),'sourceKind',${text('sourceKind',32)},'archiveProject',${text('archiveProject',255)},
        'sourceTruncated',${value('sourceTruncated','false')},'requestMissing',${value('requestMissing','false')},'excerptTimestampUnknown',${value('excerptTimestampUnknown','false')},'detailsPartial',true)`
      const [rows] = await query(`SELECT COMPRESS(${projection}) AS evidence_z FROM project_task_evidence WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${Math.min(100, Math.max(1, Math.floor(limit) || 100))}`, args)
      return rows.flatMap(row => {
        try {
          const t = JSON.parse(inflateSync(row.evidence_z.subarray(4)).toString('utf8'))
          // MySQL/MariaDB JSON_OBJECT may stringify JSON booleans/coalesced SQL
          // integers. "false" and "0" must never become truthy source warnings.
          for (const key of ['sourceTruncated','requestMissing','excerptTimestampUnknown','detailsPartial']) t[key] = t[key] === true || t[key] === 1 || t[key] === 'true' || t[key] === '1'
          for (const key of ['risks','causes','lessons','actions','progress']) {
            if (typeof t[key] === 'string') { try { t[key] = JSON.parse(t[key]) } catch { t[key] = [] } }
            if (!Array.isArray(t[key])) t[key] = []
          }
          t.updatedAt = Number(t.updatedAt) || 0
          return [t]
        } catch { return [] }
      })
    },
    async get(id) {
      await ensure()
      const [rows] = await query('SELECT COMPRESS(evidence) AS evidence_z FROM project_task_evidence WHERE id=?', [id])
      return rows.length ? JSON.parse(inflateSync(rows[0].evidence_z.subarray(4)).toString('utf8')) : null
    },
    async stats() {
      await ensure()
      if (countCache && Date.now() - countCache.at < 60000) return countCache.value
      const [rows] = await query('SELECT COUNT(*) AS tasks,MIN(updated_at) AS oldestAt,MAX(updated_at) AS newestAt FROM project_task_evidence')
      const value = { tasks: Number(rows[0].tasks), oldestAt: Number(rows[0].oldestAt), newestAt: Number(rows[0].newestAt) }
      countCache = { at: Date.now(), value }; return value
    },
  }
}
