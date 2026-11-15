/** Read-only deployment check. Never writes test credentials or prints a connection token. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const base = process.argv[2] || 'https://myriad.zxabinbina.cc.cd'
const token = (
  await readFile(new URL('../.local/connection-token.txt', import.meta.url), 'utf8')
).trim()
const request = (path, auth = token) =>
  fetch(base + path, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  })
const health = await request('/v1/health', null)
assert.equal(health.status, 200)
assert.equal((await health.json()).features.credentials, true)
assert.equal((await request('/v1/me/credentials', null)).status, 401)
assert.equal((await request('/v1/me/credentials', 'invalid-test-token')).status, 401)
const response = await request('/v1/me/credentials')
assert.equal(response.status, 200)
assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
const status = await response.json()
assert.equal(status.enabled, true)
for (const value of Object.values(status.services)) {
  assert.deepEqual(Object.keys(value).sort(), [
    'configured',
    'fields',
    'locked',
    'source',
    'version',
  ])
  assert.equal(typeof value.configured, 'boolean')
  assert(Array.isArray(value.fields))
}
const me = await request('/v1/me')
assert.equal(me.status, 200)
assert.equal((await me.json()).features.credentials, true)
console.log('PASS deployed credential status, authentication and no-store; no credentials written')
