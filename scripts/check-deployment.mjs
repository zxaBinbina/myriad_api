import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = process.argv[2] || 'https://myriad.zxabinbina.cc.cd'
const token = (
  await readFile(new URL('../.local/connection-token.txt', import.meta.url), 'utf8')
).trim()
const docId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const blobKey = `smoke.${docId}`
let wroteDoc = false
let wroteBlob = false

async function request(path, init = {}, credential = token) {
  const headers = new Headers(init.headers)
  if (credential !== null) headers.set('Authorization', `Bearer ${credential}`)
  return fetch(base + path, {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
}

async function exchange(after, update) {
  const response = await request('/v1/me/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doc: docId,
      after,
      update: update ? Buffer.from(update).toString('base64') : undefined,
    }),
  })
  assert.equal(response.status, 200, 'Sync request failed')
  wroteDoc = true
  return response.json()
}

try {
  const health = await request('/v1/health', {}, null)
  assert.equal(health.status, 200)
  const { features } = await health.json()
  for (const key of ['auth', 'sync', 'backups', 'blobs', 'kv']) assert.equal(features[key], true)
  assert.equal((await request('/v1/me', {}, null)).status, 401)
  assert.equal((await request('/v1/me', {}, 'invalid-token')).status, 401)
  const me = await request('/v1/me')
  assert.equal(me.status, 200)
  assert.ok((await me.json()).identity)
  process.stdout.write('PASS health, authorized identity, rejected missing/invalid tokens\n')

  const a = new Y.Doc()
  a.getMap('probe').set('first', 'device-a')
  const first = await exchange(0, Y.encodeStateAsUpdate(a))
  const b = new Y.Doc()
  const second = await exchange(0)
  Y.applyUpdate(b, Buffer.from(second.update, 'base64'))
  assert.equal(b.getMap('probe').get('first'), 'device-a')
  const before = Y.encodeStateVector(b)
  b.getMap('probe').set('second', 'device-b')
  await exchange(second.seq, Y.encodeStateAsUpdate(b, before))
  const third = await exchange(first.seq)
  Y.applyUpdate(a, Buffer.from(third.update, 'base64'))
  assert.equal(a.getMap('probe').get('second'), 'device-b')
  process.stdout.write('PASS bidirectional Yjs sync on an isolated test document\n')

  const bytes = Uint8Array.from({ length: 2_100_007 }, (_, i) => i % 251)
  const put = await request(`/v1/me/blobs/${blobKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  assert.equal(put.status, 200, 'Chunked file upload failed')
  wroteBlob = true
  const get = await request(`/v1/me/blobs/${blobKey}`)
  assert.equal(get.status, 200)
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), bytes)
  const backups = await request('/v1/me/backups')
  assert.equal(backups.status, 200)
  assert.ok(Array.isArray((await backups.json()).backups))
  process.stdout.write('PASS D1 chunked file round trip and authenticated backup listing\n')
} finally {
  if (wroteBlob) {
    const response = await request(`/v1/me/blobs/${blobKey}`, { method: 'DELETE' })
    assert.equal(response.status, 200, 'Test file cleanup failed')
  }
  if (wroteDoc) {
    const cleanup = spawnSync(
      fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url)),
      [
        'd1',
        'execute',
        'myriad',
        '--remote',
        '--config',
        'wrangler.local.toml',
        '--command',
        `DELETE FROM sync_updates WHERE doc = '${docId}'; DELETE FROM sync_docs WHERE id = '${docId}';`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_LOG_PATH: '/tmp/myriad-wrangler-logs',
        },
        encoding: 'utf8',
      },
    )
    assert.equal(cleanup.status, 0, 'Test document cleanup failed')
  }
  process.stdout.write('PASS test data cleaned up\n')
}
