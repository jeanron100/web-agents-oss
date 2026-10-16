// Fail before dependency installation if the public source depends on a private mirror.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root=path.resolve(process.argv[2]||'.')
for(const file of ['server/package-lock.json','web/package-lock.json']){
 const lock=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'))
 for(const [name,entry] of Object.entries(lock.packages||{})){
  if(!entry.resolved)continue
  const u=new URL(entry.resolved)
  if(u.protocol!=='https:'||u.hostname!=='registry.npmjs.org'||u.username||u.password)throw new Error(`Non-public dependency source: ${file} ${name}`)
  if(!entry.integrity)throw new Error(`Dependency integrity missing: ${file} ${name}`)
 }
}
const manifestFile=path.join(root,'SOURCE-MANIFEST.json')
if(!fs.existsSync(manifestFile)){
 if(process.argv.includes('--artifact'))throw new Error('Missing public source manifest')
 console.log(JSON.stringify({publicDependencySources:true,sourceCheckout:true}));process.exit(0)
}
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'))
for(const file of manifest.files){
 const target=path.resolve(root,file.path)
 if(!target.startsWith(root+path.sep)||fs.lstatSync(target).isSymbolicLink())throw new Error('Invalid source path: '+file.path)
 const sum=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
 if(sum!==file.sha256)throw new Error('Source checksum differs: '+file.path)
}
console.log(JSON.stringify({publicDependencySources:true,verifiedSourceFiles:manifest.files.length}))
