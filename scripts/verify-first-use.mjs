// Optional real-browser acceptance. Run only against an isolated fresh installation.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {chromium} from '../web/node_modules/playwright-core/index.mjs'
const base=process.argv[2]||'http://127.0.0.1:5188',tokenFile=process.argv[3],out=process.argv[4]||'/tmp/wa-release-ui'
if(!tokenFile||!process.env.WA_CHROMIUM)throw new Error('Provide setup-token file and WA_CHROMIUM executable path')
fs.mkdirSync(out,{recursive:true,mode:0o700})
const credentialsFile=tokenFile+'.smoke-admin.json',credentials=fs.existsSync(credentialsFile)?JSON.parse(fs.readFileSync(credentialsFile,'utf8')):{user:'smoke-admin',password:'browser-'+crypto.randomBytes(18).toString('hex')}
const browser=await chromium.launch({executablePath:process.env.WA_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
const results=[],errors=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message))
 await page.goto(base,{waitUntil:'domcontentloaded'})
 await page.getByLabel('用户名',{exact:true}).fill(credentials.user)
 await page.getByLabel('密码',{exact:true}).fill(credentials.password)
 if(await page.getByRole('heading',{name:'初始化管理员'}).count()){
  await page.getByLabel('初始化令牌',{exact:true}).fill(fs.readFileSync(tokenFile,'utf8').trim());await page.getByRole('button',{name:'创建管理员',exact:true}).click()
  await page.getByRole('button',{name:'登录',exact:true}).waitFor();await page.getByLabel('密码',{exact:true}).fill(credentials.password)
  fs.writeFileSync(credentialsFile,JSON.stringify(credentials),{mode:0o600})
 }
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.getByRole('heading',{name:'看板',exact:true}).waitFor()
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:950});await page.goto(base+'/settings');await page.getByRole('heading',{name:'服务器管理',exact:true}).waitFor()
  await page.getByRole('button',{name:'添加服务器',exact:true}).click()
  await page.getByRole('heading',{name:'添加服务器',exact:true}).waitFor()
  const size=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}))
  assert(size.width<=size.viewport+1,`Horizontal overflow at ${width}: ${size.width}`)
  await page.getByRole('heading',{name:'添加服务器',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(out,`settings-${width}.png`),fullPage:true});results.push({width,overflow:false})
 }
 await page.getByLabel('服务器ID',{exact:true}).fill('browser-proof')
 await page.getByLabel('显示名称',{exact:true}).fill('Browser proof')
 await page.getByLabel('Agent地址',{exact:true}).fill('http://127.0.0.1:9')
 await page.getByLabel('接入令牌',{exact:true}).fill(crypto.randomBytes(32).toString('hex'))
 await page.getByRole('button',{name:'保存服务器',exact:true}).click()
 await page.getByText('服务器配置已保存并生效。',{exact:true}).waitFor()
 const row=page.locator('.node-row').filter({hasText:'browser-proof'})
 await row.getByRole('button',{name:'编辑',exact:true}).click()
 assert.equal(await page.getByLabel('接入令牌',{exact:true}).inputValue(),'')
 await page.getByRole('button',{name:'取消',exact:true}).click()
 await row.getByRole('button',{name:'禁用',exact:true}).click()
 await row.getByText('· 已禁用',{exact:false}).waitFor()
 await row.getByRole('button',{name:'移除',exact:true}).click()
 await page.getByRole('button',{name:'确认移除',exact:true}).click()
 await page.getByText('节点已移除，历史记录保留；原CLI进程未停止。',{exact:true}).waitFor()
 assert.equal(await row.count(),0)
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,results,consoleErrors:errors}))
}finally{await browser.close()}
