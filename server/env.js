// server/env.js — 把 server/.env 载入 process.env（db-redis-mongo-phase1 / P1）
//
// 为什么需要它：`.env` 里的 WA_REDIS_* / WA_MONGO_* / WA_*_ENABLED 是给 flags.js / redis.js / mongo.js
// 用的，但它们读的是 `process.env`。而本仓原本**没有任何地方把 .env 灌进 process.env**——db.js 的
// loadEnv() 只是自己解析成对象取 mysql_* 键，hub 的 systemd 也没有 EnvironmentFile。
// 结果就是：往 .env 写 WA_REDIS_ENABLED=1 **完全不生效**（踩过：翻了开关但 health 仍报 disabled）。
//
// 规则：**已存在的真实环境变量优先**（不覆盖），便于 systemd/命令行临时覆盖开关做验证与回滚。
// 用法：在进程入口（hub.js / agent.js）**第一个** import 它。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')

try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    if (process.env[m[1]] !== undefined) continue // 真实环境变量优先，不覆盖
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* 没有 .env 就什么都不做 */ }
