// Build a new source tree without private Git history, operational docs or runtime data.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root=process.cwd(),out=path.resolve(process.argv[2]||'.release/web-agents')
if(out===root||fs.existsSync(out))throw new Error('Choose a new, empty export directory')
const names=['README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','Dockerfile','.dockerignore','.gitattributes','compose.yaml','compose.runner.yaml','server/package.json','server/package-lock.json','server/hub-config.json','web/package.json','web/package-lock.json','web/index.html','web/tsconfig.json','web/vite.config.ts','release/export-manifest.json','.gitignore']
names.push('release/version','release/notes.md','start-macos.command','start-windows.cmd')
const trees=['web/src','web/public','server/repositories','server/mcp','docs/public','.github/workflows']
const exclude=new Set(['read-status.mjs','deploy-hub-deps.test.mjs','deploy-agent.test.mjs','nightly-restart.test.mjs'])
for(const n of fs.readdirSync('server'))if(/\.m?js$/.test(n)&&!exclude.has(n))names.push('server/'+n)
for(const n of ['quickstart.sh','quickstart.ps1','release-policy.mjs','release-policy.test.mjs','package-release.py','verify-launchers.py','backup.sh','restore.sh','export-public.mjs','scan-secrets.mjs','verify-release.mjs','container-smoke.mjs','verify-first-use.mjs','verify-provider-tasks.mjs'])names.push('scripts/'+n)
const copy=relative=>{const src=path.join(root,relative),dst=path.join(out,relative);if(!fs.existsSync(src))throw new Error('Missing export input: '+relative);if(fs.lstatSync(src).isSymbolicLink())throw new Error('Symlinks are not allowed: '+relative);if(fs.statSync(src).isDirectory()){for(const n of fs.readdirSync(src))copy(relative+'/'+n)}else{fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);fs.chmodSync(dst,(/\.(sh|command)$/.test(relative))?0o755:0o644)}}
for(const n of [...names,...trees])copy(n)
const files=[]
function hash(dir){for(const n of fs.readdirSync(dir)){const p=path.join(dir,n);if(fs.statSync(p).isDirectory())hash(p);else files.push({path:path.relative(out,p),sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')})}}
hash(out);fs.writeFileSync(path.join(out,'SOURCE-MANIFEST.json'),JSON.stringify({format:1,files},null,2)+'\n')
console.log(JSON.stringify({directory:out,files:files.length}))
