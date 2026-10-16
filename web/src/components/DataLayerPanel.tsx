import {useEffect,useState} from 'react'
import {useLanguage} from '../lib/language'
type Health={status:string;latencyMs?:number;error?:string}
type Stats={redis:Health;mongo:Health;mysql:Health;flags:Record<string,boolean>;projection:{written:number;skipped:number;spooled?:number;spoolCount:number;spoolBytes:number;lastRun?:number};counts:{events:number;byType:{type:string;n:number}[]}|null}
const dot=(s:string)=>s==='ok'?'var(--st-done)':s==='disabled'?'var(--text-3)':'var(--st-error)'
function Row({name,h}:{name:string;h:Health}){
 const [language]=useLanguage()
 const label=h.status==='ok'?(language==='en'?'Healthy':'正常'):h.status==='disabled'?(name==='MySQL'?(language==='en'?'Not configured':'未配置'):(language==='en'?'Not enabled · Optional':'未启用 · 可选')):(language==='en'?'Connection issue':'连接异常')
 return <div className="dl-row"><span className="dl-row__dot" style={{background:dot(h.status)}}/><span className="dl-row__name">{name}</span><span className="dl-row__state" style={{color:dot(h.status)}}>{label}</span>{h.latencyMs!=null&&<span className="dl-row__lat mono">{h.latencyMs}ms</span>}{h.error&&<span className="dl-row__note" style={{color:'var(--st-error)'}}>{String(h.error).slice(0,40)}</span>}</div>
}
export function DataLayerPanel(){
 const [language]=useLanguage(),[s,setS]=useState<Stats|null>(null),[err,setErr]=useState(false)
 const t=(zh:string,en:string)=>language==='en'?en:zh
 useEffect(()=>{
  let alive=true
  const load=()=>fetch('/api/v2/stats').then(r=>{if(!r.ok)throw new Error();return r.json()}).then(d=>{if(alive){setS(d);setErr(false)}}).catch(()=>{if(alive)setErr(true)})
  void load();const timer=setInterval(()=>void load(),10000)
  return()=>{alive=false;clearInterval(timer)}
 },[])
 if(err)return <section className="detail-section"><h2>{t('数据存储','Data storage')}</h2><p className="dl-empty">{t('暂时无法读取状态，请检查控制台连接。','Status is unavailable. Check the console connection.')}</p></section>
 if(!s)return <section className="detail-section"><h2>{t('数据存储','Data storage')}</h2><p className="dl-empty">{t('加载中…','Loading…')}</p></section>
 const spoolMB=s.projection.spoolBytes/1048576,spoolWarn=s.projection.spoolCount>0
 const projectionOn=s.flags.WA_MONGO_ENABLED&&s.flags.WA_EVENT_SHADOW_WRITE
 const doc=`https://github.com/jeanron100/web-agents-oss/blob/main/docs/public/${language==='en'?'en/':''}data-storage.md`
 return <section className="detail-section storage-panel" lang={language==='en'?'en':'zh-CN'}>
  <h2>{t('数据存储与可选增强','Data storage and optional capabilities')}</h2>
  <p className="muted">{t('默认使用 MySQL 保存统计与任务证据，执行节点保留 CLI 原始记录。Redis 和 MongoDB 是按需添加的增强，不是首次使用的必备项。','MySQL stores statistics and task evidence by default; execution nodes retain original CLI records. Redis and MongoDB are optional additions, not first-use prerequisites.')}</p>
  <div className="storage-feature"><Row name="MySQL" h={s.mysql}/><p>{t('基础持久化：保存项目用量、活跃时长、项目小助理任务证据和归档数据。默认 Compose 已包含。','Core persistence for project usage, active time, assistant task evidence and archived data. Included in the default Compose installation.')}</p></div>
  <div className="storage-feature"><Row name="Redis" h={s.redis}/><p>{t('开启收益：缓存额度和节点短期状态，减少控制台重启后的额度冷探测，并在去重有效期内减少重复待办通知。','Benefits: cache quota readings and short-lived node state, reduce cold quota probes after console restarts, and reduce repeated pending-action notifications within the deduplication window.')}</p><details><summary>{t('什么时候需要？如何启用？','When is it useful, and how do I enable it?')}</summary><p>{t('适合节点较多、额度探测较慢或经常重启控制台的环境。需要额外运行一个 Redis 服务，配置连接地址和认证，再启用控制台的 Redis 开关。缓存过期或丢失后会重新采集；不会提升模型本身的响应速度，也不等于支持多 Hub 高可用。','Useful with multiple nodes, slow quota probes or frequent console restarts. Run a Redis service, configure its URL and authentication, then enable Redis in the console environment. Expired or lost caches are rebuilt. This does not speed up model inference or provide multi-Hub high availability.')}</p><pre className="setup-command">{'WA_REDIS_ENABLED=1\nWA_REDIS_URL=redis://your-redis:6379\nWA_REDIS_PASS=<your-password>'}</pre><p>{t('保存部署配置后，仅重新创建控制台。状态变为“正常”，并确认额度缓存或通知去重可用，才算完成接入。','After saving deployment configuration, recreate only the console. Confirm a healthy status and working quota caching or notification deduplication.')}</p></details></div>
  <div className="storage-feature"><Row name="MongoDB" h={s.mongo}/><p>{t('开启收益：为符合采集条件的执行事件建立中央索引，提供历史时间线、会话概要与审批/节点状态审计查询。','Benefits: centrally index eligible execution events for historical timelines, session summaries, approval audits and node-status history.')}</p><details><summary>{t('与现有历史有什么区别？如何启用？','How does it differ from existing history, and how do I enable it?')}</summary><p>{t('MySQL 中的任务证据与归档仍可独立使用；MongoDB 增加的是结构化事件查询层。需要额外运行 MongoDB，并同时启用连接与事件影子写两个开关。仅连接成功不表示已经开始采集，也不会自动补齐所有引擎的全部旧记录。','MySQL task evidence and archives remain available independently. MongoDB adds a structured event-query layer. Run MongoDB and enable both the connection and event-projection switches. A successful connection alone does not mean events are being collected or that all older records from every engine have been imported.')}</p><pre className="setup-command">{'WA_MONGO_ENABLED=1\nWA_EVENT_SHADOW_WRITE=1\nWA_MONGO_URI=mongodb://<user>:<password>@your-mongo:27017/webagents_v2?authSource=admin'}</pre><p>{t('仅重新创建控制台；检查 MongoDB 状态、投影开关和新任务的事件计数。事件保留 180 天，审批审计 365 天；MongoDB 需要单独的存储、备份和维护。','Recreate only the console. Check MongoDB health, the projection switch and event counts from a new eligible task. Events are retained for 180 days and approval audits for 365 days. MongoDB needs its own storage, backups and maintenance.')}</p></details></div>
  {(s.flags.WA_MONGO_ENABLED||spoolWarn)&&<><p className="dl-hint">{t('事件投影：','Event projection: ')}{projectionOn?t('已开启','Enabled'):t('未开启；需同时启用 MongoDB 与事件影子写','Not enabled; both MongoDB and event projection must be enabled')}</p><div className="dl-stat"><div className="dl-stat__box"><div className="dl-stat__label">{t('已索引事件','Indexed events')}</div><div className="dl-stat__val mono">{s.counts?s.counts.events.toLocaleString():'—'}</div></div><div className="dl-stat__box"><div className="dl-stat__label">{t('待补写事件','Events awaiting replay')}</div><div className="dl-stat__val mono">{s.projection.spoolCount}{spoolMB>=0.1&&<span className="dl-stat__unit"> · {spoolMB.toFixed(1)}MB</span>}</div></div></div></>}
  {spoolWarn&&<p className="dl-note">{t(`有 ${s.projection.spoolCount} 条事件暂存控制台本地，MongoDB 恢复且投影开启后会尝试幂等补写。`,`There are ${s.projection.spoolCount} locally queued events. Replay is attempted when MongoDB recovers and event projection is enabled.`)}</p>}
  <p className="dl-hint">{t('Redis / MongoDB 未启用时，仍可创建会话、审批和使用终端。MySQL 异常会影响统计与历史持久化，应单独处理。','Sessions, approvals and terminals remain usable without Redis or MongoDB. MySQL faults affect statistics and historical persistence and need separate attention.')}</p>
  <a href={doc} target="_blank" rel="noreferrer">{t('查看启用条件、完整配置与验证方法 →','Read requirements, full configuration and validation steps →')}</a>
 </section>
}
