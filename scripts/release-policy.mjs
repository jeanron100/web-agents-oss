import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export function releasePolicy(version, expectedVersion) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version || '')
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('Use a version tag such as v0.1.0 or v0.1.0-rc.1 (without build metadata).')
  }
  if (version !== expectedVersion) throw new Error('Tag and release/version must match exactly.')
  return { version, prerelease: !!match[4], latest: !match[4] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = releasePolicy(process.argv[2], fs.readFileSync('release/version', 'utf8').trim())
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${policy.prerelease}\nlatest=${policy.latest}\n`)
  }
  console.log(JSON.stringify(policy))
}
