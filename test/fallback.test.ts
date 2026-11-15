import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Env } from '../src/env'
import { app } from '../src/index'
import { createBackup, deleteBackup, getBackup, listBackups } from '../src/backups'
import {
  deleteObject,
  getObject,
  listObjects,
  MAX_D1_OBJECT_BYTES,
  putObject,
} from '../src/objects'
import { exchange, maybeCompact, setConfig } from '../src/sync'

const TOKEN = 'private-connection-token-for-the-test-suite-only'
let fallback: Env

beforeAll(async () => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN)),
  )
  fallback = {
    ...env,
    BUCKET: undefined,
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    SYNC_TOKEN_SHA256: [...digest].map((n) => n.toString(16).padStart(2, '0')).join(''),
    SYNC_IDENTITY: 'owner-test',
  }
})

async function call(
  path: string,
  init: RequestInit = {},
  token: string | null = TOKEN,
  overrides: Partial<Env> = {},
) {
  const ctx = createExecutionContext()
  const headers = new Headers(init.headers)
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const res = await app.request(
    'https://myriad.example.com' + path,
    { ...init, headers },
    { ...fallback, ...overrides },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('独立令牌鉴权', () => {
  it('无 Access / R2 时列出可用功能，不暴露凭据', async () => {
    const res = await call('/v1/health', {}, null)
    const text = await res.text()
    expect(JSON.parse(text).features).toMatchObject({
      auth: true,
      sync: true,
      backups: true,
      blobs: true,
      blobMaxBytes: MAX_D1_OBJECT_BYTES,
    })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(fallback.SYNC_TOKEN_SHA256)
    expect(((await (await call('/v1/me')).json()) as { identity: string }).identity).toBe(
      'owner-test',
    )
  })

  it('所有私有功能拒绝缺失或错误的令牌', async () => {
    for (const [path, method] of [
      ['/v1/me', 'GET'],
      ['/v1/me/sync', 'POST'],
      ['/v1/me/backups', 'GET'],
      ['/v1/me/backups', 'POST'],
      ['/v1/me/blobs/test', 'GET'],
      ['/v1/me/blobs/test', 'PUT'],
      ['/v1/me/blobs/test', 'DELETE'],
    ]) {
      expect((await call(path!, { method }, null)).status).toBe(401)
      expect((await call(path!, { method }, 'wrong-token')).status).toBe(401)
    }
    expect((await call('/v1/me', {}, TOKEN, { SYNC_TOKEN_SHA256: '0'.repeat(64) })).status).toBe(
      401,
    )
    expect((await call('/v1/me', {}, TOKEN, { SYNC_TOKEN_SHA256: '' })).status).toBe(503)
    expect((await call('/v1/me', {}, TOKEN, { SYNC_TOKEN_SHA256: 'invalid' })).status).toBe(503)
  })

  it('允许网页预检 Authorization，但不放行未列出的来源', async () => {
    const res = await call(
      '/v1/me/sync',
      { method: 'OPTIONS', headers: { Origin: 'https://zxabinbina.cc.cd' } },
      null,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(
      (
        await call(
          '/v1/me/sync',
          { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } },
          null,
        )
      ).status,
    ).toBe(403)
  })
})

describe('D1 分块文件存储', () => {
  it('超过 D1 单个 BLOB 上限的文件可以往返，覆盖和删除会清理旧分块', async () => {
    const bytes = Uint8Array.from({ length: 2_100_007 }, (_, i) => i % 251)
    const put = await call('/v1/me/blobs/big-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) },
      body: bytes,
    })
    expect(put.status).toBe(200)
    const get = await call('/v1/me/blobs/big-file')
    expect(get.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes)
    expect(
      await fallback
        .DB!.prepare('SELECT COUNT(*) AS n FROM object_chunks WHERE key = ?')
        .bind('blobs/big-file')
        .first('n'),
    ).toBe(3)
    await putObject(fallback, 'blobs/big-file', new Uint8Array([7, 8]))
    expect(
      new Uint8Array(await (await getObject(fallback, 'blobs/big-file'))!.arrayBuffer()),
    ).toEqual(new Uint8Array([7, 8]))
    expect(
      await fallback
        .DB!.prepare('SELECT COUNT(*) AS n FROM object_chunks WHERE key = ?')
        .bind('blobs/big-file')
        .first('n'),
    ).toBe(1)
    expect((await call('/v1/me/blobs/big-file', { method: 'DELETE' })).status).toBe(200)
    expect((await call('/v1/me/blobs/big-file')).status).toBe(404)
    expect(
      await fallback
        .DB!.prepare('SELECT COUNT(*) AS n FROM object_chunks WHERE key = ?')
        .bind('blobs/big-file')
        .first('n'),
    ).toBe(0)
  })

  it('拒绝超限与错误长度，保留已有文件', async () => {
    await putObject(fallback, 'blobs/limit', new Uint8Array([1]))
    expect(
      (
        await call('/v1/me/blobs/limit', {
          method: 'PUT',
          headers: { 'Content-Length': String(MAX_D1_OBJECT_BYTES + 1) },
          body: new Uint8Array([2]),
        })
      ).status,
    ).toBe(413)
    expect(
      (
        await call('/v1/me/blobs/limit', {
          method: 'PUT',
          headers: { 'Content-Length': '1' },
          body: new Uint8Array([2, 3]),
        })
      ).status,
    ).toBe(400)
    expect(new Uint8Array(await (await getObject(fallback, 'blobs/limit'))!.arrayBuffer())).toEqual(
      new Uint8Array([1]),
    )
  })

  it('存储在 D1 的旧文件，增加 R2 后仍能读取、列出和删除', async () => {
    const key = 'migration/old-file'
    await putObject(fallback, key, new Uint8Array([1, 2]), { metadata: { reason: 'manual' } })
    expect(new Uint8Array(await (await getObject(env, key))!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2]),
    )
    expect((await listObjects(env, 'migration/')).map((o) => o.key)).toContain(key)
    await deleteObject(env, key)
    expect(await getObject(fallback, key)).toBeNull()
  })

  it('分块写入中途失败会回滚，不损坏已有文件', async () => {
    const key = 'atomic/keep-original'
    await putObject(fallback, key, new Uint8Array([3, 4]))
    await fallback.DB!.exec(
      "CREATE TRIGGER fail_test_chunk BEFORE INSERT ON object_chunks WHEN NEW.key = 'atomic/keep-original' AND NEW.part = 1 BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    )
    try {
      await expect(putObject(fallback, key, new Uint8Array(1_100_000).fill(5))).rejects.toThrow()
      expect(new Uint8Array(await (await getObject(fallback, key))!.arrayBuffer())).toEqual(
        new Uint8Array([3, 4]),
      )
    } finally {
      await fallback.DB!.exec('DROP TRIGGER fail_test_chunk')
    }
  })
})

describe('无 R2 的同步与备份', () => {
  it('大快照压缩后，新设备仍能获取完整内容', async () => {
    const a = new Y.Doc()
    a.getMap('data').set('large', 'x'.repeat(1_100_000))
    const sv = Y.encodeStateVector(a)
    await exchange(fallback, 'large-snapshot', 0, Y.encodeStateAsUpdate(a))
    a.getMap('data').set('second', 'y'.repeat(1_100_000))
    await exchange(fallback, 'large-snapshot', 0, Y.encodeStateAsUpdate(a, sv))
    expect(await maybeCompact(fallback, 'large-snapshot', true)).toBe(true)
    const r = await exchange(fallback, 'large-snapshot', 0, null)
    expect(r.full).toBe(true)
    const b = new Y.Doc()
    Y.applyUpdate(b, r.update!)
    expect(b.getMap('data').get('large')).toBe('x'.repeat(1_100_000))
    expect(b.getMap('data').get('second')).toBe('y'.repeat(1_100_000))
    // 数据继续改变时，旧对象必须被替换并清理。
    const before = Y.encodeStateVector(a)
    a.getMap('data').set('third', 3)
    await exchange(fallback, 'large-snapshot', r.seq, Y.encodeStateAsUpdate(a, before))
    await maybeCompact(fallback, 'large-snapshot', true)
    expect(await listObjects(fallback, 'sync/large-snapshot/')).toHaveLength(1)
  })

  it('备份可恢复、每日去重和保留份数在 D1 上也有效', async () => {
    const doc = new Y.Doc()
    doc.getMap('data').set('value', 'original')
    await exchange(fallback, 'backup-fallback', 0, Y.encodeStateAsUpdate(doc))
    const manual = (await createBackup(fallback, 'backup-fallback', 'manual'))!
    const snapshot = await getBackup(fallback, 'backup-fallback', manual.id)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, new Uint8Array(await snapshot!.arrayBuffer()))
    expect(restored.getMap('data').get('value')).toBe('original')
    await setConfig(fallback, 'backup', { enabled: true, keep: 1 })
    await createBackup(fallback, 'backup-fallback', 'daily')
    expect(await createBackup(fallback, 'backup-fallback', 'daily')).toBeNull()
    const sv = Y.encodeStateVector(doc)
    doc.getMap('data').set('value', 'updated')
    await exchange(fallback, 'backup-fallback', 0, Y.encodeStateAsUpdate(doc, sv))
    await createBackup(fallback, 'backup-fallback', 'daily')
    expect(
      (await listBackups(fallback, 'backup-fallback')).filter((b) => b.reason === 'daily'),
    ).toHaveLength(1)
    await deleteBackup(fallback, 'backup-fallback', manual.id)
    expect(await getBackup(fallback, 'backup-fallback', manual.id)).toBeNull()
  })
})
