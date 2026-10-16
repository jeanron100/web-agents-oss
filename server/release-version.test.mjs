import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RELEASE_VERSION } from './release-version.js'

test('compiled runtime version includes the precise release suffix and matches its authority',()=>{
 const tag=fs.readFileSync(new URL('../release/version',import.meta.url),'utf8').trim()
 assert.equal(`v${RELEASE_VERSION}`,tag)
 assert.match(RELEASE_VERSION,/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
})
test('release preflight rejects stale runtime identity before building images',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-version-mismatch-'))
 try{
  for(const file of ['server/package-lock.json','web/package-lock.json','release/version']){
   const dst=path.join(dir,file);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(new URL('../'+file,import.meta.url),dst)
  }
  fs.writeFileSync(path.join(dir,'server/release-version.js'),'export const RELEASE_VERSION = "0.0.0-old"\n')
  assert.throws(()=>execFileSync(process.execPath,[new URL('../scripts/verify-release.mjs',import.meta.url).pathname,dir],{stdio:'pipe'}),error=>String(error.stderr).includes('Runtime release version differs'))
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
