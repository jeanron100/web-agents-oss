import {useEffect,useState} from 'react'

export default function Ops() {
  const [opsUrl,setOpsUrl]=useState('')
  useEffect(()=>{fetch('/api/installation').then(r=>r.ok?r.json():{monitorUrl:''}).then(d=>setOpsUrl(d.monitorUrl||'')).catch(()=>{})},[])
  if(!opsUrl)return <div className="page"><h1>监控</h1><p>尚未配置外部监控页面，可在设置中填写。</p></div>
  return (
    <div className="ops-embed">
      <div className="ops-embed__bar">
        <span className="ops-embed__title">监控</span>
        <a className="ops-embed__open" href={opsUrl} target="_blank" rel="noreferrer">↗ 新标签打开</a>
      </div>
      <iframe className="ops-embed__frame" src={opsUrl} title="监控看板" referrerPolicy="no-referrer" />
    </div>
  )
}
