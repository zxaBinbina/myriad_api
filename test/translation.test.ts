import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { features, type Env } from '../src/env'
import { app } from '../src/index'
import { translate, translationInput } from '../src/translation'

afterEach(() => vi.restoreAllMocks())
const body = { text: 'Hello world', source: 'en', target: 'zh', provider: 'ai' }
async function call(raw: unknown, bindings: Env = {}, hostname = 'localhost') {
  const ctx = createExecutionContext()
  const response = await app.request(
    `http://${hostname}/v1/me/translate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(raw) },
    { DEV_AUTH_BYPASS: 'true', ...bindings },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}
describe('Authenticated translation', () => {
  it('requires authentication on a public host; does not call AI for anonymous visitors', async () => {
    const run = vi.fn()
    const ctx = createExecutionContext()
    const response = await app.request(
      'https://myriad.test/v1/me/translate',
      { method: 'POST', body: JSON.stringify(body) },
      { AI: { run } as unknown as Ai, SYNC_TOKEN_SHA256: '0'.repeat(64) },
      ctx,
    )
    expect(response.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
    await waitOnExecutionContext(ctx)
  })
  it('bindings are optional and health only lists enabled providers', async () => {
    expect(features({})).toMatchObject({ translation: false, translators: [] })
    expect(features({ DEEPL_API_KEY: 'hidden-key' })).toMatchObject({
      translation: true,
      translators: ['deepl'],
    })
    expect(JSON.stringify(features({ DEEPL_API_KEY: 'hidden-key' }))).not.toContain('hidden-key')
    const response = await call(body)
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: 'translation-disabled' })
  })
  it('validates size, source language and provider before contacting any upstream', async () => {
    const run = vi.fn()
    for (const raw of [
      null,
      {},
      { ...body, text: ' ' },
      { ...body, text: 'a'.repeat(2001) },
      { ...body, source: 'auto' },
      { ...body, target: 'unknown' },
      { ...body, provider: 'https://evil.test' },
      { ...body, provider: ['ai'] },
    ]) {
      expect(translationInput(raw)).toBeNull()
      expect((await call(raw, { AI: { run } as unknown as Ai })).status).toBe(400)
    }
    expect((await call({ ...body, text: 'a'.repeat(30000) })).status).toBe(413)
    expect(run).not.toHaveBeenCalled()
  })
  it('runs m2m100 with explicit languages and never caches text', async () => {
    const run = vi.fn().mockResolvedValue({ translated_text: '你好，世界' })
    const response = await call(body, { AI: { run } as unknown as Ai })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: '你好，世界' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(run).toHaveBeenCalledWith('@cf/meta/m2m100-1.2b', {
      text: body.text,
      source_lang: 'en',
      target_lang: 'zh',
    })
  })
  it('uses fixed DeepL endpoint and its own secret only, including automatic detection', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ translations: [{ text: '你好', detected_source_language: 'EN' }] }),
      )
    const response = await call(
      { ...body, provider: 'deepl', source: 'auto', url: 'https://evil.test' },
      { DEEPL_API_KEY: 'provider-key:fx' },
    )
    expect(response.status).toBe(200)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api-free.deepl.com/v2/translate')
    expect(new Headers(init?.headers).get('Authorization')).toBe('DeepL-Auth-Key provider-key:fx')
    expect(new Headers(init?.headers).get('CF-Access-Client-Secret')).toBeNull()
    expect(init?.redirect).toBe('manual')
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('source_lang')
  })
  it('supports Microsoft regions and omits auto source; failures contain no upstream details', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json([{ translations: [{ text: '你好' }], detectedLanguage: { language: 'en' } }]),
      )
    expect(
      await translate(
        { MICROSOFT_TRANSLATOR_KEY: 'key', MICROSOFT_TRANSLATOR_REGION: 'eastasia' },
        { ...body, provider: 'microsoft', source: 'auto' },
        new AbortController().signal,
      ),
    ).toEqual({ text: '你好', detected: 'en' })
    expect(String(fetcher.mock.calls[0]![0])).not.toContain('from=')
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get('Ocp-Apim-Subscription-Region'),
    ).toBe('eastasia')
    fetcher.mockRejectedValue(new Error('sensitive text and key'))
    const response = await call(
      { ...body, provider: 'microsoft' },
      { MICROSOFT_TRANSLATOR_KEY: 'key' },
    )
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('sensitive')
  })
  it('does not contact an upstream after cancellation', async () => {
    const run = vi.fn()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      translate({ AI: { run } as unknown as Ai }, { ...body, provider: 'ai' }, ctrl.signal),
    ).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
