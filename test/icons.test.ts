import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { findCandidates, handleIcon, iconTarget, rankCandidates } from '../src/icons'

afterEach(() => vi.restoreAllMocks())

const PNG = new Uint8Array(200).fill(7)

describe('图标代理', () => {
  it('只接受公网 http(s) 地址', () => {
    expect(iconTarget('github.com')?.hostname).toBe('github.com')
    expect(iconTarget('https://www.bilibili.com/video')?.origin).toBe('https://www.bilibili.com')
    for (const bad of [
      'javascript:alert(1)',
      'http://localhost',
      'http://10.0.0.1',
      'http://[::1]',
      'ftp://a.com',
      'printer.local',
      null,
    ])
      expect(iconTarget(bad)).toBeNull()
  })

  it('从 HTML 中解析图标并按尺寸排序', async () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="https://cdn.example.com/big.png" sizes="192x192">
      <link rel="stylesheet" href="/a.css">
      <link rel="mask-icon" href="/mask.svg">
    </head></html>`
    const list = await findCandidates(
      new Response(html, { headers: { 'Content-Type': 'text/html' } }),
      'https://example.com/',
    )
    expect(list.map((c) => c.href)).toEqual([
      'https://example.com/favicon-32.png',
      'https://example.com/apple.png',
      'https://cdn.example.com/big.png',
    ])
    expect(rankCandidates(list, 128).map((c) => c.size)).toEqual([180, 192, 32])
  })

  it('抓取后缓存到 R2，第二次不再请求源站；找不到时返回 404', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://icons.example.org/')
        return new Response('<link rel="apple-touch-icon" href="/touch.png">', {
          headers: { 'Content-Type': 'text/html' },
        })
      if (url === 'https://icons.example.org/touch.png')
        return new Response(PNG, { headers: { 'Content-Type': 'image/png' } })
      return new Response('nope', { status: 404 })
    })
    const target = iconTarget('https://icons.example.org/page')!
    const first = await handleIcon(env, target, 128)
    expect(first.status).toBe(200)
    expect(first.headers.get('Content-Type')).toBe('image/png')
    expect(first.headers.get('Content-Security-Policy')).toContain('sandbox')
    const calls = fetchSpy.mock.calls.length

    const second = await handleIcon(env, target, 128)
    expect(second.status).toBe(200)
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(PNG)
    expect(fetchSpy.mock.calls.length).toBe(calls)

    const missing = await handleIcon(env, iconTarget('no-icon.example.org')!, 128)
    expect(missing.status).toBe(404)
    const callsAfterMiss = fetchSpy.mock.calls.length
    expect((await handleIcon(env, iconTarget('no-icon.example.org')!, 128)).status).toBe(404)
    expect(fetchSpy.mock.calls.length).toBe(callsAfterMiss)
  })
})
