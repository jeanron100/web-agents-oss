import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import readline from 'node:readline'
const patterns=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['literal-basic-auth',/["']Basic\s+[A-Za-z0-9+/=]{16,}["']/],
 ['literal-nginx-secret',/set\s+\$[\w]*(?:token|password|secret)[\w]*\s+["'][A-Za-z0-9._-]{12,}["']/i],
 ['vendor-key',/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,})\b/],
 ['embedded-url-password',/https?:\/\/[a-zA-Z0-9._~%-]+:[a-zA-Z0-9._~%!$&()*+,;=:-]{8,}@/],
 ['nginx-password-comparison',/\$[\w]*(?:pass|password)[\w]*\s*=\s*["'][^"']{8,}["']/i],
 ['literal-cookie-token',/\$cookie_\w+\s*(?:!=|=)\s*["'][A-Za-z0-9_-]{16,}["']/],
]
const hits=[]
const fixtures=new Set(['private-key:server/event-redaction.test.mjs','private-key:server/progress-knowledge.test.mjs','embedded-url-password:server/release-management.test.mjs','embedded-url-password:server/runtime-config.test.mjs'])
function scan(line,file,number,commit){for(const [rule,re] of patterns)if(re.test(line))hits.push({rule,file,line:number,...(fixtures.has(rule+':'+file)?{fixture:true}:{}),...(commit?{commit}:{})})}
if(process.argv.includes('--history')){
 const child=spawn('git',['log','--all','--format=WA_COMMIT:%H','--patch','--no-ext-diff','--no-renames','--','.',':!*.lock'],{stdio:['ignore','pipe','ignore']})
 let commit='',file='',line=0
 for await(const text of readline.createInterface({input:child.stdout})){if(text.startsWith('WA_COMMIT:'))commit=text.slice(10);else if(text.startsWith('+++ b/'))file=text.slice(6);else if(text.startsWith('@@'))line=Number(/\+(\d+)/.exec(text)?.[1]||0);else if(text.startsWith('+')&&!text.startsWith('+++'))scan(text.slice(1),file,line++,commit);else if(text.startsWith(' '))line++}
 await new Promise((resolve,reject)=>{if(child.exitCode!==null)return child.exitCode===0?resolve():reject(new Error('git scan failed'));child.on('exit',c=>c===0?resolve():reject(new Error('git scan failed')))})
}else{
 const root=path.resolve(process.argv[2]||'.')
 const skip=new Set(['.git','node_modules','dist','.release','.codex','.claude','.kimi-code','release-artifacts'])
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(skip.has(e.name)||e.name.startsWith('.env')||e.name==='.compose.env'||e.name.includes('.private.')||e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(?:js|mjs|ts|tsx|json|md|ya?ml|conf|sh)$/.test(e.name)&&fs.statSync(p).size<2e6)fs.readFileSync(p,'utf8').split('\n').forEach((l,i)=>scan(l,path.relative(root,p),i+1))}}
 walk(root)
}
console.log(JSON.stringify({findings:hits.filter(h=>!h.fixture).length,fixtures:hits.filter(h=>h.fixture).length,locations:hits},null,2))
if(hits.some(h=>!h.fixture))process.exitCode=1
