import fs from 'node:fs'
import path from 'node:path'
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.woff2':'font/woff2'}
export function serveWeb(req,res,root){
  if(!root||!['GET','HEAD'].includes(req.method))return false
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://local').pathname)}catch{return false}
  if(pathname.includes('\0'))return false
  const base=path.resolve(root),candidate=path.resolve(base,'.'+pathname)
  if(candidate!==base&&!candidate.startsWith(base+path.sep))return false
  let file=candidate
  try{if(!fs.statSync(file).isFile())file=path.join(base,'index.html')}catch{
    if(path.extname(pathname)){res.writeHead(404);res.end();return true}
    file=path.join(base,'index.html')
  }
  try{
    const resolved=fs.realpathSync(file);if(!resolved.startsWith(fs.realpathSync(base)+path.sep))return false
    const stat=fs.statSync(resolved),ext=path.extname(resolved)
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':stat.size,'X-Content-Type-Options':'nosniff','Cache-Control':ext==='.html'||path.basename(file)==='sw.js'?'no-cache':'public, max-age=3600'})
    if(req.method==='HEAD')res.end();else fs.createReadStream(resolved).pipe(res)
    return true
  }catch{return false}
}
