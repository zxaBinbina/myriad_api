import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { app } from '../src/index'
import { currencyRate } from '../src/currency'
import {
  decodeVarInt,
  encodeVarInt,
  minecraftAddress,
  minecraft,
  minecraftEndpoint,
  publicIp,
  queryMinecraft,
  readMinecraftPacket,
} from '../src/minecraft'
afterEach(() => vi.restoreAllMocks())
describe('Minecraft SLP', () => {
  it('公网服务器 TCP 握手失败时使用固定免费来源并保留零人在线', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      return url.hostname === 'api.mcstatus.io'
        ? Response.json({
            online: true,
            players: { online: 0, max: 20 },
            version: { name_clean: '1.21' },
            motd: { raw: 'hello' },
          })
        : Response.json({
            Status: 0,
            Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '8.8.8.8' }] : [],
          })
    })
    const result = await minecraft(
      {},
      minecraftAddress('mc.example.com:25565')!,
      'java',
      async () => {
        throw new Error('proxy refused')
      },
    )
    expect(result).toMatchObject({ online: true, playersOnline: 0, provider: 'mcstatus.io' })
    expect(fetch.mock.calls.at(-1)?.[0].toString()).toBe(
      'https://api.mcstatus.io/v2/status/java/mc.example.com%3A25565',
    )
  })
  it('DNS 解析到内网时不会进入第三方回退', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }),
      )
    const probe = vi.fn()
    await expect(
      minecraft({}, minecraftAddress('mc.example.com:25565')!, 'java', probe),
    ).rejects.toThrow('non-public-address')
    expect(probe).not.toHaveBeenCalled()
    expect(
      fetch.mock.calls.every(([url]) => String(url).startsWith('https://cloudflare-dns.com/')),
    ).toBe(true)
  })
  it('拒绝内网地址与不合法端口，接受公网地址', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.2',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.2',
      '100.64.0.1',
      '::1',
      'fc00::1',
    ])
      expect(publicIp(ip)).toBe(false)
    for (const value of [
      'localhost:25565',
      'example.local',
      '10.0.0.1:25565',
      'example.com:65536',
      '[2001:::1]',
    ])
      expect(minecraftAddress(value)).toBeNull()
    expect(minecraftAddress('mc.example.com')).toEqual({
      host: 'mc.example.com',
      port: 25565,
      explicitPort: false,
    })
    expect(minecraftAddress('8.8.8.8:25703')?.port).toBe(25703)
  })
  it('遵循 SRV 优先级，校验并固定解析后的 IP', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = new URL(String(input)),
        type = u.searchParams.get('type')
      return Response.json({
        Status: 0,
        Answer:
          type === 'SRV'
            ? [
                { type: 33, data: '10 1 25566 other.example.com.' },
                { type: 33, data: '0 1 25703 target.example.com.' },
              ]
            : type === 'A'
              ? [{ type: 1, data: '8.8.8.8' }]
              : [],
      })
    })
    expect(
      await minecraftEndpoint(minecraftAddress('mc.example.com')!, new AbortController().signal),
    ).toEqual({ host: '8.8.8.8', port: 25703 })
  })
  it('DNS 失败或解析到内网时拒绝连接', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ Status: 2 }))
    await expect(
      minecraftEndpoint(minecraftAddress('mc.example.com')!, new AbortController().signal),
    ).rejects.toThrow()
    fetch.mockImplementation(async () =>
      Response.json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }),
    )
    await expect(
      minecraftEndpoint(minecraftAddress('mc.example.com:25565')!, new AbortController().signal),
    ).rejects.toThrow('non-public-address')
  })
  it('处理分片状态包、零人在线，并在完成后关闭连接', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        version: { name: '1.21', protocol: 1 },
        players: { online: 0, max: 20 },
        description: 'hello',
      }),
    )
    const packet = Buffer.concat([encodeVarInt(0), encodeVarInt(payload.length), payload])
    const frame = Buffer.concat([encodeVarInt(packet.length), packet])
    class Fake extends EventEmitter {
      destroyed = false
      write() {
        this.emit('data', frame.subarray(0, 2))
        this.emit('data', frame.subarray(2))
        return true
      }
      destroy() {
        this.destroyed = true
        this.emit('close')
        return this
      }
    }
    const socket = new Fake()
    const promise = queryMinecraft(
      { host: '8.8.8.8', port: 25565 },
      'mc.example.com',
      new AbortController().signal,
      () => {
        queueMicrotask(() => socket.emit('connect'))
        return socket as unknown as Socket
      },
    )
    expect((await promise).players.online).toBe(0)
    expect(socket.destroyed).toBe(true)
    expect(readMinecraftPacket(packet).version.name).toBe('1.21')
    expect(decodeVarInt(Buffer.from([128]))).toBeNull()
    expect(() => decodeVarInt(Buffer.from([255, 255, 255, 255, 255]))).toThrow()
  })
  it('中止未完成的握手时关闭连接', async () => {
    class Fake extends EventEmitter {
      destroyed = false
      destroy() {
        this.destroyed = true
        return this
      }
    }
    const socket = new Fake(),
      ctrl = new AbortController()
    const promise = queryMinecraft(
      { host: '8.8.8.8', port: 25565 },
      'mc.example.com',
      ctrl.signal,
      () => socket as unknown as Socket,
    )
    ctrl.abort(new Error('test-abort'))
    await expect(promise).rejects.toThrow('test-abort')
    expect(socket.destroyed).toBe(true)
  })
})
describe('汇率主备来源', () => {
  it('Frankfurter 不支持币种时换用 ER，再换用 Currency API', async () => {
    const calls: string[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('frankfurter')) return new Response('', { status: 404 })
      return Response.json({ rates: { USD: 7 }, time_last_update_unix: 1794614400 })
    })
    expect(await currencyRate({}, 'XYZ', 'USD')).toMatchObject({
      rate: 7,
      provider: 'ExchangeRate-API',
    })
    expect(calls).toHaveLength(2)
    fetch.mockImplementation(async (input) =>
      String(input).includes('jsdelivr')
        ? Response.json({ date: '2026-11-14', btc: { usd: 20 } })
        : new Response('', { status: 404 }),
    )
    expect(await currencyRate({}, 'BTC', 'USD')).toMatchObject({
      rate: 20,
      provider: 'Currency API',
    })
  })
  it('历史指定日期不会退回今天的 ER 报价', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input).includes('jsdelivr')
          ? Response.json({ date: '2026-11-01', btc: { usd: 10 } })
          : new Response('', { status: 404 }),
      )
    expect(await currencyRate({}, 'BTC', 'USD', '2026-11-01')).toMatchObject({
      date: '2026-11-01',
      rate: 10,
    })
    expect(fetch.mock.calls.some(([url]) => String(url).includes('open.er-api'))).toBe(false)
  })
  it('身份换算不访问上游；拒绝非法查询', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect((await currencyRate({}, 'CNY', 'CNY')).rate).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    for (const path of [
      '/currency?base=../../bad',
      '/currency?date=2026-02-30',
      '/currency/history?from=2026-01-01&to=2026-11-01',
      '/minecraft?address=127.0.0.1',
    ]) {
      const ctx = createExecutionContext()
      const res = await app.request(`https://myriad.test/v1${path}`, {}, {}, ctx)
      expect(res.status).toBe(400)
      await waitOnExecutionContext(ctx)
    }
  })
})
