import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import {
  credentialContext,
  credentialTokenHash,
  sealCredential,
  type CredentialService,
  type CredentialsStatus,
} from '../src/credentialCrypto'
import { credentialEnv } from '../src/credentials'
import { ensureSchema } from '../src/sync'
import type { Env } from '../src/env'

const TOKEN = 'credential-tests-only-token',
  BASE = 'https://worker.example'
let bindings: Env
beforeEach(async () => {
  bindings = {
    ...env,
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    SYNC_TOKEN_SHA256: await credentialTokenHash(TOKEN),
  }
  await ensureSchema(bindings.DB!)
  await bindings.DB!.prepare('DELETE FROM service_credentials').run()
})
afterEach(() => vi.restoreAllMocks())
async function call(
  path: string,
  init: RequestInit = {},
  auth = true,
  overrides: Partial<Env> = {},
) {
  const ctx = createExecutionContext(),
    headers = new Headers(init.headers)
  if (auth) headers.set('Authorization', `Bearer ${TOKEN}`)
  const result = await app.request(
    BASE + '/v1' + path,
    { ...init, headers },
    { ...bindings, ...overrides },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return result
}
async function save(
  service: CredentialService,
  fields: Record<string, string>,
  version = '',
  remove = false,
) {
  const envelope = await sealCredential(
    bindings.SYNC_TOKEN_SHA256!,
    credentialContext('transport', service, BASE),
    { fields, version, remove },
  )
  return call('/me/credentials/' + service, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
}
async function status() {
  return (await (await call('/me/credentials')).json()) as CredentialsStatus
}

describe('Encrypted credential vault', () => {
  it('matches the independently generated Tencent signing vector in the client', async () => {
    const { translationRequest, translationConfig } = await import('../src/translationProvider')
    const request = await translationRequest(
      'tencent',
      { text: 'Hello world', source: 'en', target: 'zh' },
      translationConfig(),
      { id: 'id', key: 'secret' },
      Date.parse('2026-11-14T01:23:45Z'),
    )
    expect(new Headers(request.init.headers).get('Authorization')).toContain(
      'Signature=771de971470a73d9a6df38ce552dc85c7cfc4f4375868906b24150bde8152e93',
    )
    expect(request.init.redirect).toBe('manual')
  })
  it('requires authentication and D1/token bindings; status contains no secrets', async () => {
    expect((await call('/me/credentials', {}, false)).status).toBe(401)
    expect(
      (await call('/me/credentials/github', { method: 'PUT', body: '{}' }, false)).status,
    ).toBe(401)
    expect(
      (await call('/me/credentials/github', { method: 'PUT', body: '{}' }, true, { DB: undefined }))
        .status,
    ).toBe(501)
    expect((await call('/me/credentials')).headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('stores only at-rest ciphertext, preserves blank fields and refuses stale overwrites', async () => {
    const r = await save('github', { key: 'test-secret-github' })
    expect(r.status).toBe(200)
    expect(await r.text()).not.toContain('test-secret-github')
    const row = await bindings
      .DB!.prepare('SELECT envelope FROM service_credentials')
      .first<{ envelope: string }>()
    expect(row!.envelope).not.toContain('test-secret-github')
    const original = (await status()).services.github.version
    expect((await save('github', { key: '' }, original)).status).toBe(200)
    expect((await credentialEnv(bindings)).GITHUB_TOKEN).toBe('test-secret-github')
    expect((await save('github', { key: 'stale-secret' }, original)).status).toBe(409)
    const v = (await status()).services.github.version
    expect((await save('github', {}, v, true)).status).toBe(200)
    expect((await status()).services.github.configured).toBe(false)
    expect((await credentialEnv(bindings)).GITHUB_TOKEN).toBeUndefined()
    expect((await save('github', { key: 'stale-secret' }, v)).status).toBe(409)
  })
  it('rejects plaintext, modified envelopes, wrong services/origins and invalid fields', async () => {
    const original = await sealCredential(
      bindings.SYNC_TOKEN_SHA256!,
      credentialContext('transport', 'github', BASE),
      { fields: { key: 'test-secret' }, version: '' },
    )
    for (const body of [{ fields: { key: 'plaintext' } }, { ...original, iv: 'bad' }])
      expect(
        (await call('/me/credentials/github', { method: 'PUT', body: JSON.stringify(body) }))
          .status,
      ).toBe(400)
    expect(
      (await call('/me/credentials/deepl', { method: 'PUT', body: JSON.stringify(original) }))
        .status,
    ).toBe(400)
    expect((await save('github', { unexpected: 'x' })).status).toBe(400)
    expect((await save('qweather', { host: 'evil.example', key: 'test-secret' })).status).toBe(400)
    expect((await save('baidu', { key: 'missing-id' })).status).toBe(400)
    expect(
      (
        await save('openai', {
          key: 'k',
          endpoint: 'https://127.0.0.1/chat/completions',
          model: 'm',
        })
      ).status,
    ).toBe(400)
  })
  it('isolates concurrently saved services and refreshes authenticated features', async () => {
    const responses = await Promise.all([
      save('github', { key: 'test-github' }),
      save('qweather', { key: 'test-weather', host: 'test.qweatherapi.com' }),
    ])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const me = (await (await call('/me')).json()) as any
    expect(me.features).toMatchObject({ githubPrivate: true, qweather: true, credentials: true })
    expect(me.features.credentialRevision).toBeTruthy()
    expect(JSON.stringify(me)).not.toContain('test-github')
    const health = (await (await call('/health', {}, false)).json()) as any
    expect(health.features.githubPrivate).toBe(false)
  })
  it('uses saved GitHub credentials only for authenticated calls', async () => {
    await save('github', { key: 'test-github-secret' })
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        Response.json(String(url).endsWith('/user') ? { login: 'test' } : []),
      )
    expect((await call('/github?user=test&org=&section=repositories', {}, false)).status).toBe(200)
    expect(
      fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has('Authorization')),
    ).toBe(true)
    fetcher.mockClear()
    expect((await call('/me/github?section=notifications')).status).toBe(200)
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer test-github-secret',
    )
  })
  it('executes every saved official translator and an endpoint-bound model without returning keys', async () => {
    const sources = {
      deepl: { translations: [{ text: '译文' }] },
      baidu: { trans_result: [{ dst: '译文' }] },
      youdao: { errorCode: '0', translation: ['译文'] },
      tencent: { Response: { TargetText: '译文' } },
      microsoft: [{ translations: [{ text: '译文' }] }],
      openai: { choices: [{ message: { content: '译文' } }] },
    }
    for (const [service, result] of Object.entries(sources)) {
      expect(
        (
          await save(service as CredentialService, {
            key: 'test-secret',
            ...(['baidu', 'youdao', 'tencent'].includes(service) ? { id: 'test-id' } : {}),
            ...(service === 'openai'
              ? { endpoint: 'https://model.example/v1/chat/completions', model: 'test-model' }
              : {}),
          })
        ).status,
      ).toBe(200)
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json(result))
      const response = await call('/me/translate', {
        method: 'POST',
        body: JSON.stringify({
          text: 'Hello\n\n- World',
          source: 'en',
          target: 'zh',
          provider: service,
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ text: '译文\n\n- 译文' })
      expect(fetcher.mock.calls[0]![1]?.redirect).toBe('manual')
      fetcher.mockRestore()
    }
    const v = (await status()).services.openai.version
    expect(
      (await save('openai', { endpoint: 'https://another.example/v1/chat/completions' }, v)).status,
    ).toBe(400)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    expect(
      (
        await call('/me/translate', {
          method: 'POST',
          body: JSON.stringify({
            text: 'Hello',
            source: 'en',
            target: 'zh',
            provider: 'openai',
            settings: { baseUrl: 'https://evil.example/v1', model: 'm' },
          }),
        })
      ).status,
    ).toBe(502)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses saved Unsplash keys and handles token rotation without exposing old ciphertext', async () => {
    await save('unsplash', { key: 'test-unsplash-secret' })
    expect((await credentialEnv(bindings)).UNSPLASH_ACCESS_KEY).toBe('test-unsplash-secret')
    const rotated = await credentialEnv({
      ...bindings,
      SYNC_TOKEN_SHA256: await credentialTokenHash('rotated-test-token'),
    })
    expect(rotated.UNSPLASH_ACCESS_KEY).toBeUndefined()
    const { readCredentials } = await import('../src/credentials')
    expect((await readCredentials(rotated)).status.services.unsplash.locked).toBe(true)
  })
})
