import test from 'node:test'
import assert from 'node:assert/strict'
import { releasePolicy } from './release-policy.mjs'

test('stable tags publish a stable latest release', () => {
  assert.deepEqual(releasePolicy('v1.2.3', 'v1.2.3'), { version: 'v1.2.3', prerelease: false, latest: true })
})
test('release candidates and other prereleases do not replace stable latest', () => {
  for (const version of ['v0.1.0-rc.9', 'v1.0.0-beta-1', 'v2.0.0-alpha.2']) {
    assert.deepEqual(releasePolicy(version, version), { version, prerelease: true, latest: false })
  }
})
test('version mismatch is refused before a build', () => {
  assert.throws(() => releasePolicy('v1.2.3', 'v1.2.4'), /must match/)
})
test('branches, shell metacharacters and malformed or ambiguous versions are refused', () => {
  for (const version of ['', 'main', 'v1.2', '1.2.3', 'v01.2.3', 'v1.2.3-rc..1', 'v1.2.3-01', 'v1.2.3+build', 'v1.2.3;echo bad']) {
    assert.throws(() => releasePolicy(version, version))
  }
})
