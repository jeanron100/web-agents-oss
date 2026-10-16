import fs from 'node:fs'
import { codexQuotaSamples } from './quota-history.js'
import { initDb, insertQuotaSamples } from './db.js'

const apply = process.argv.includes('--apply')
const files = process.argv.slice(2).filter(arg => arg !== '--apply')
if (!files.length) { console.error('Usage: node import-quota-history.mjs [--apply] collected.json ...'); process.exit(1) }
try {
  const rows = [], reports = []
  for (const file of files) {
    const input = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!/^srv-[\w-]+$/.test(input.server) || !Array.isArray(input.accounts)) throw new Error('Invalid collection report')
    if (input.accounts.some(a => a.sourceServerId !== `historical:${input.server}`)) throw new Error('Collection source mismatch')
    const samples = codexQuotaSamples(input.accounts)
    rows.push(...samples)
    reports.push({ server: input.server, files: input.files, events: input.events, errors: input.errors, samples: samples.length })
  }
  if (apply && !await initDb()) throw new Error('Quota database is not available')
  const inserted = apply ? await insertQuotaSamples(rows, { strict: true }) : 0
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', reports, samples: rows.length, inserted, skipped: apply ? rows.length - inserted : 0 }))
  process.exit(0)
} catch (e) { console.error(e.message); process.exit(1) }
