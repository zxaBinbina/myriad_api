import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { setJwksForTesting } from '../src/auth'
import type { Env } from '../src/env'
import { app, scheduled } from '../src/index'
import { maybeCompact } from '../src/sync'

const TEAM = 'https://myriad-test.cloudflareaccess.com'
const BASE = 'https://myriad.example.com'

let privateKey: CryptoKey
let token: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }
  setJwksForTesting(TEAM, createLocalJWKSet({ keys: [jwk] }))
  token = await sign({ email: 'me@example.com' })
})

function sign(claims: Record<string, unknown>, aud = 'test-aud') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(TEAM)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function call(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext()
  const headers = new Headers(init.headers)
  if (
    path.startsWith('/v1/me') &&
    !headers.has('Cf-Access-Jwt-Assertion') &&
    !headers.has('X-No-Auth')
  )
    headers.set('Cf-Access-Jwt-Assertion', token)
  const url = path.startsWith('http') ? path : BASE + path
  const res = await app.request(url, { ...init, headers }, { ...env, ...overrides }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** 模拟客户端：维护本地文档与已收到的序号 */
class Client {
  doc = new Y.Doc()
  after = 0
  private sv = Y.encodeStateVector(new Y.Doc())
  async sync(doc = 'main') {
    const update = Y.encodeStateAsUpdate(this.doc, this.sv)
    const res = await call('/v1/me/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc, after: this.after, update: b64(update) }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { seq: number; update: string | null; full: boolean }
    if (body.update) Y.applyUpdate(this.doc, unb64(body.update))
    this.after = body.seq
    this.sv = Y.encodeStateVector(this.doc)
    return body
  }
}

describe('公开接口', () => {
  it('health 列出可用功能', async () => {
    const res = await call('/v1/health')
    const body = (await res.json()) as { features: Record<string, boolean> }
    expect(body.features).toMatchObject({ sync: true, backups: true, kv: true, auth: true })
  })

  it('拒绝明文 HTTP（localhost 除外）', async () => {
    expect((await call('http://myriad.example.com/v1/health')).status).toBe(403)
    expect((await call('http://localhost/v1/health')).status).toBe(200)
  })

  it('geo 接口返回结构', async () => {
    const body = (await (await call('/v1/geo')).json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['country', 'city', 'timezone', 'latitude']),
    )
  })
})

describe('鉴权', () => {
  it('没有令牌返回 401', async () => {
    const res = await call('/v1/me', { headers: { 'X-No-Auth': '1' } })
    expect(res.status).toBe(401)
  })

  it('有效令牌返回身份', async () => {
    const body = (await (await call('/v1/me')).json()) as { identity: string }
    expect(body.identity).toBe('me@example.com')
  })

  it('Service Token（common_name）也能通过', async () => {
    const t = await sign({ common_name: 'abc.access' })
    const res = await call('/v1/me', { headers: { 'Cf-Access-Jwt-Assertion': t } })
    expect(((await res.json()) as { identity: string }).identity).toBe('abc.access')
  })

  it('AUD 不符返回 401', async () => {
    const t = await sign({ email: 'me@example.com' }, 'other-aud')
    const res = await call('/v1/me', { headers: { 'Cf-Access-Jwt-Assertion': t } })
    expect(res.status).toBe(401)
  })

  it('不在白名单返回 403', async () => {
    const res = await call('/v1/me', {}, { ALLOWED_IDENTITIES: 'someone@else.com' })
    expect(res.status).toBe(403)
  })

  it('未配置 Access 时私有接口拒绝访问', async () => {
    const res = await call('/v1/me', {}, { ACCESS_AUD: '' })
    expect(res.status).toBe(503)
  })

  it('开发模式只在 localhost 上跳过校验', async () => {
    const dev = { DEV_AUTH_BYPASS: 'true' }
    const local = await call('http://localhost/v1/me', { headers: { 'X-No-Auth': '1' } }, dev)
    expect(local.status).toBe(200)
    const remote = await call('/v1/me', { headers: { 'X-No-Auth': '1' } }, dev)
    expect(remote.status).toBe(401)
  })
})

describe('跨域', () => {
  it('允许的来源可以预检私有接口', async () => {
    const res = await call('/v1/me/sync', {
      method: 'OPTIONS',
      headers: { Origin: 'https://zxabinbina.cc.cd', 'Access-Control-Request-Method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://zxabinbina.cc.cd')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('其他来源不能访问私有接口，但能读公开接口', async () => {
    const pre = await call('/v1/me/sync', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(pre.status).toBe(403)
    const pub = await call('/v1/health', { headers: { Origin: 'https://evil.example' } })
    expect(pub.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('同步', () => {
  it('两个客户端互相收到对方的更新，不会收到自己的', async () => {
    const a = new Client()
    const b = new Client()
    a.doc.getMap('data').set('title', 'A')
    const ra = await a.sync('t1')
    expect(ra.update).toBeNull()
    const rb = await b.sync('t1')
    expect(b.doc.getMap('data').get('title')).toBe('A')
    expect(rb.seq).toBe(ra.seq)

    b.doc.getMap('data').set('count', 2)
    await b.sync('t1')
    const ra2 = await a.sync('t1')
    expect(a.doc.getMap('data').toJSON()).toEqual({ title: 'A', count: 2 })
    expect(ra2.seq).toBeGreaterThan(ra.seq)
  })

  it('压缩后新客户端拿到完整状态，旧客户端继续增量', async () => {
    const a = new Client()
    for (let i = 0; i < 5; i++) {
      a.doc.getArray<number>('list').push([i])
      await a.sync('t2')
    }
    const b = new Client()
    await b.sync('t2')
    expect(await maybeCompact(env, 't2', true)).toBe(true)
    // 并发 / 重复压缩不会丢数据
    await maybeCompact(env, 't2', true)

    const fresh = new Client()
    const r = await fresh.sync('t2')
    expect(r.full).toBe(true)
    expect(fresh.doc.getArray('list').toJSON()).toEqual([0, 1, 2, 3, 4])

    a.doc.getArray<number>('list').push([5])
    await a.sync('t2')
    const rb = await b.sync('t2')
    expect(rb.full).toBe(false)
    expect(b.doc.getArray('list').toJSON()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('客户端序号比服务端新时（服务端被清空）返回完整状态', async () => {
    const a = new Client()
    a.doc.getMap('m').set('k', 1)
    await a.sync('t3')
    const stale = new Client()
    stale.after = 999999
    const r = await stale.sync('t3')
    expect(r.full).toBe(true)
    expect(stale.doc.getMap('m').get('k')).toBe(1)
  })

  it('拒绝非法参数', async () => {
    const bad = await call('/v1/me/sync', { method: 'POST', body: '{"doc":"../x"}' })
    expect(bad.status).toBe(400)
  })
})

describe('备份', () => {
  it('手动备份、列出、下载、删除', async () => {
    const a = new Client()
    a.doc.getMap('data').set('v', 'backup-me')
    await a.sync()
    const created = (await (
      await call('/v1/me/backups', { method: 'POST', body: '{"reason":"import"}' })
    ).json()) as { backup: { id: string; reason: string } }
    expect(created.backup.reason).toBe('import')

    const list = (await (await call('/v1/me/backups')).json()) as {
      backups: { id: string }[]
      config: { keep: number }
    }
    expect(list.backups.map((b) => b.id)).toContain(created.backup.id)
    expect(list.config.keep).toBe(2)

    const bin = new Uint8Array(
      await (await call(`/v1/me/backups/${created.backup.id}`)).arrayBuffer(),
    )
    const restored = new Y.Doc()
    Y.applyUpdate(restored, bin)
    expect(restored.getMap('data').get('v')).toBe('backup-me')

    expect((await call(`/v1/me/backups/${created.backup.id}`, { method: 'DELETE' })).status).toBe(
      200,
    )
    expect((await call(`/v1/me/backups/${created.backup.id}`)).status).toBe(404)
  })

  it('每日备份：内容不变时跳过，超过保留份数时删除最旧的', async () => {
    const a = new Client()
    a.doc.getMap('data').set('day', 1)
    await a.sync()
    await scheduled(env)
    await scheduled(env)
    const daily = async () =>
      (
        (await (await call('/v1/me/backups')).json()) as { backups: { reason: string }[] }
      ).backups.filter((b) => b.reason === 'daily')
    expect(await daily()).toHaveLength(1)
    for (const day of [2, 3]) {
      a.doc.getMap('data').set('day', day)
      await a.sync()
      await scheduled(env)
    }
    expect(await daily()).toHaveLength(2)

    const cfg = await call('/v1/me/backups/config', { method: 'PUT', body: '{"keep":1}' })
    expect(((await cfg.json()) as { config: { keep: number } }).config.keep).toBe(1)
    expect(await daily()).toHaveLength(1)
  })
})

describe('用户文件', () => {
  it('上传、读取、删除', async () => {
    const put = await call('/v1/me/blobs/wallpaper.test.1', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
      body: new Uint8Array([1, 2, 3, 4]),
    })
    expect(put.status).toBe(200)
    const get = await call('/v1/me/blobs/wallpaper.test.1')
    expect(get.headers.get('Content-Type')).toBe('image/png')
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([1, 2, 3, 4])
    await call('/v1/me/blobs/wallpaper.test.1', { method: 'DELETE' })
    expect((await call('/v1/me/blobs/wallpaper.test.1')).status).toBe(404)
    expect((await call('/v1/me/blobs/..%2Fx')).status).toBe(400)
  })
})
