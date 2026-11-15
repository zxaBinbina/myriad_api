import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { app } from '../src/index'
import { contentTarget, fetchContent, feedSnapshot, hotFeed, summarizeArticle } from '../src/feeds'
import { webSearch } from '../src/searchService'
afterEach(() => vi.restoreAllMocks())
describe('M4 Worker', () => {
  it('reader resolves relative media after a redirect', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('dns-query'))
        return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      if (url.endsWith('/start'))
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com/articles/final' },
        })
      return new Response('<article><img src="photo.jpg"></article>')
    })
    const ctx = createExecutionContext()
    const res = await app.request(
      'https://myriad.test/v1/reader?url=https://example.com/start',
      {},
      {},
      ctx,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { blocks: unknown[] }).blocks).toEqual([
      { type: 'image', url: 'https://example.com/articles/photo.jpg', alt: '' },
    ])
    await waitOnExecutionContext(ctx)
  })
  it('public reader returns safe ordered media blocks and reuses the new cache', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input).includes('dns-query')
          ? Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
          : new Response(
              '<article><p>Article</p><img src="/image.jpg"><video src="/video.webm"></video><audio src="javascript:bad()"></audio><iframe src="https://video.example/player"></iframe></article>',
            ),
      )
    const path = `https://myriad.test/v1/reader?url=${encodeURIComponent('https://example.com/media-' + crypto.randomUUID())}`
    for (let i = 0; i < 2; i++) {
      const ctx = createExecutionContext()
      const res = await app.request(path, {}, { CACHE: env.CACHE }, ctx)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { blocks: unknown[] }).blocks).toEqual([
        { type: 'text', text: 'Article' },
        { type: 'image', url: 'https://example.com/image.jpg', alt: '' },
        { type: 'video', url: 'https://example.com/video.webm', label: 'video' },
        { type: 'unavailable', label: 'audio' },
        { type: 'unavailable', label: 'iframe', url: 'https://video.example/player' },
      ])
      await waitOnExecutionContext(ctx)
    }
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('dns-query'))).toHaveLength(1)
  })
  it('rejects private URLs, credentials, arbitrary ports and malformed queries', async () => {
    for (const url of [
      'http://127.0.0.1',
      'http://[::1]',
      'http://localhost',
      'https://a.local',
      'https://example.com:8080',
      'https://u:p@example.com',
      'file:///tmp/test',
    ])
      expect(contentTarget(url)).toBeNull()
    for (const path of [
      '/hot?source=unknown',
      '/rss?url=http://127.0.0.1',
      '/reader?url=file:///etc/passwd',
      '/search?engine=google&q=test',
      '/search?engine=npm&q=x&page=-1',
    ]) {
      const ctx = createExecutionContext(),
        res = await app.request(`https://myriad.test/v1${path}`, {}, {}, ctx)
      expect(res.status).toBe(400)
      await waitOnExecutionContext(ctx)
    }
  })
  it('public routes never forward keys, private search and AI require auth', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ objects: [], total: 0 }))
    const ctx = createExecutionContext(),
      r = await app.request(
        'https://myriad.test/v1/search?engine=npm&q=test',
        { headers: { Authorization: 'Bearer should-not-forward' } },
        { BRAVE_SEARCH_KEY: 'private' },
        ctx,
      )
    expect(r.status).toBe(200)
    expect(new Headers(spy.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false)
    expect(new Headers(spy.mock.calls[0]![1]?.headers).has('X-Subscription-Token')).toBe(false)
    await waitOnExecutionContext(ctx)
    for (const path of ['/me/search?engine=bing&q=test', '/me/summary']) {
      const c = createExecutionContext(),
        res = await app.request(
          `https://myriad.test/v1${path}`,
          { method: path.endsWith('summary') ? 'POST' : 'GET' },
          { SYNC_TOKEN_SHA256: 'a'.repeat(64) },
          c,
        )
      expect(res.status).toBe(401)
      await waitOnExecutionContext(c)
    }
  })
  it('daily cache fetches once, refreshes next bucket and returns marked stale on failure', async () => {
    const period = Date.now() - 1000,
      key = `test-${crypto.randomUUID()}`,
      load = vi.fn(async () => ({ title: 'Test', items: [], fetchedAt: Date.now() }))
    const cfg = { CACHE: env.CACHE }
    await feedSnapshot(cfg, key, period, load)
    await feedSnapshot(cfg, key, period, load)
    expect(load).toHaveBeenCalledTimes(1)
    const stale = await feedSnapshot(cfg, key, Date.now() + 1000, async () => {
      throw new Error('blocked')
    })
    expect(stale.stale).toBe(true)
  })
  it('no bindings are required for fixed free hot sources', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([{ title: 'Topic', url: 'https://v2ex.com/t/1' }]))
    const value = await hotFeed({}, 'v2ex', Date.now() - 1000, new AbortController().signal)
    expect(value.items[0]!.title).toBe('Topic')
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('manual')
  })
  it('hot and RSS requests without a period reuse the current daily cache', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('dns-query'))
        return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      if (String(input).includes('hn.algolia.com'))
        return Response.json({ hits: [{ title: 'Topic', url: 'https://example.com/topic' }] })
      return new Response(
        '<rss><channel><title>Test</title><item><title>Article</title><link>https://example.com/article</link></item></channel></rss>',
      )
    })
    for (const path of [
      '/hot?source=hackernews',
      `/rss?url=${encodeURIComponent(`https://example.com/feed-${crypto.randomUUID()}`)}`,
    ]) {
      const before = fetch.mock.calls.length
      for (let i = 0; i < 2; i++) {
        const ctx = createExecutionContext()
        const res = await app.request(
          `https://myriad.test/v1${path}`,
          {},
          { CACHE: env.CACHE },
          ctx,
        )
        expect(res.status).toBe(200)
        await waitOnExecutionContext(ctx)
      }
      const calls = fetch.mock.calls.slice(before)
      expect(calls.filter(([url]) => !String(url).includes('dns-query'))).toHaveLength(1)
    }
  })
  it('rejects redirects to private URLs and DNS answers before fetching target', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input).includes('dns-query')
          ? Response.json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] })
          : new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }),
      )
    await expect(
      fetchContent('https://example.com', new AbortController().signal),
    ).rejects.toThrow()
    expect(fetch.mock.calls.every(([url]) => String(url).includes('dns-query'))).toBe(true)
    fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
    )
    await expect(
      fetchContent('https://example.com', new AbortController().signal, {}, false),
    ).rejects.toThrow('bad-redirect')
  })
  it('Brave/Google key requests are fixed, redirect-free and pagination is bounded', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        web: {
          results: [{ title: 'Result', url: 'https://example.com', description: '<b>Safe</b>' }],
        },
        query: { more_results_available: true },
      }),
    )
    const result = await webSearch(
      { SERVICE_CREDENTIALS: { brave: { key: 'secret' } } },
      'bing',
      'query',
      0,
      new AbortController().signal,
    )
    expect(result.provider).toBe('brave')
    expect(result.items[0]!.description).toBe('Safe')
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('X-Subscription-Token')).toBe('secret')
    expect(String(fetch.mock.calls[0]![0])).toMatch(/^https:\/\/api.search.brave.com\//)
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('manual')
    await expect(webSearch({}, 'bing', 'q', 0, new AbortController().signal)).rejects.toThrow(
      'search-disabled',
    )
    expect(
      (await webSearch({ BRAVE_SEARCH_KEY: 'x' }, 'bing', 'q', 10, new AbortController().signal))
        .next,
    ).toBeNull()
  })
  it('AI is optional and repeated public article summaries reuse KV', async () => {
    await expect(
      summarizeArticle({}, 'https://example.com', 'en', new AbortController().signal),
    ).rejects.toThrow('summary-disabled')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('dns-query')
        ? Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
        : new Response('<title>Test</title><article><p>Public article body.</p></article>'),
    )
    const run = vi.fn(async () => ({ response: 'Short summary.' })),
      cfg = { CACHE: env.CACHE, AI: { run } as unknown as Ai },
      url = `https://example.com/article-${crypto.randomUUID()}`
    expect((await summarizeArticle(cfg, url, 'en', new AbortController().signal)).summary).toBe(
      'Short summary.',
    )
    await summarizeArticle(cfg, url, 'en', new AbortController().signal)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('private disabled capability responses are no-store', async () => {
    const ctx = createExecutionContext(),
      res = await app.request(
        'http://localhost/v1/me/search?engine=bing&q=test',
        {},
        { DEV_AUTH_BYPASS: 'true' },
        ctx,
      )
    expect(res.status).toBe(501)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    await waitOnExecutionContext(ctx)
  })
})
