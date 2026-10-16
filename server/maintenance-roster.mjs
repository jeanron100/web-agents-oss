import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {configPath,validateConfig} from './runtime-config.js'
export const maintenanceRoster=config=>validateConfig(config).agents.filter(n=>n.enabled&&n.sshTarget).map(n=>`${n.id}|${n.sshTarget}`)
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(maintenanceRoster(JSON.parse(fs.readFileSync(process.env.WA_NIGHTLY_CONFIG||configPath(),'utf8'))).join('\n'))
