import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { coordinates, dailyQuote, weather } from '../src/widgets'

afterEach(() => vi.restoreAllMocks())
describe('免费小组件接口', () => {
  it('验证坐标，拒绝任意目标 URL 与非法查询', async () => {
    expect(coordinates('', '0')).toBeNull()
    expect(coordinates('91', '0')).toBeNull()
    expect(coordinates('NaN', '0')).toBeNull()
    expect(coordinates('39.90421', '116.40741')).toEqual({ latitude: 39.9, longitude: 116.41 })
    for (const path of [
      '/weather?latitude=91&longitude=0',
      '/weather/cities?name=x',
      '/quote?c=bad',
      '/quote?day=bad',
    ]) {
      const ctx = createExecutionContext()
      const response = await app.request(`https://myriad.test/v1${path}`, {}, {}, ctx)
      expect(response.status).toBe(400)
      await waitOnExecutionContext(ctx)
    }
  })
  it('无 KV、无 Key 时照常返回天气；空气接口失败不阻断天气', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'air-quality-api.open-meteo.com')
        return new Response('', { status: 503 })
      expect(url.hostname).toBe('api.open-meteo.com')
      return Response.json({ current: { temperature_2m: 20 }, daily: { time: ['2026-11-14'] } })
    })
    expect(await weather({}, 39.9, 116.4, true)).toMatchObject({
      current: { temperature_2m: 20 },
      aqi: null,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('每日同分类一言只取一次，新日期取新句子', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ hitokoto: 'test', id: 42 }))
    const cfg = { CACHE: env.CACHE }
    await dailyQuote(cfg, '2026-11-14', 'ab')
    await dailyQuote(cfg, '2026-11-14', 'ab')
    expect(fetch).toHaveBeenCalledTimes(1)
    await dailyQuote(cfg, '2026-11-15', 'ab')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('公开天气不转发鉴权头，响应可缓存', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ current: { temperature_2m: 8 } }))
    const ctx = createExecutionContext()
    const response = await app.request(
      'https://myriad.test/v1/weather?latitude=0&longitude=0&air=0',
      { headers: { Authorization: 'Bearer test-secret' } },
      {},
      ctx,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('max-age=1800')
    expect(fetch.mock.calls[0]![1]?.headers).toBeUndefined()
    await waitOnExecutionContext(ctx)
  })
})
