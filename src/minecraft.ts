import { Buffer } from 'node:buffer'
import { createConnection, isIP, type Socket } from 'node:net'
import { cached } from './data'
import type { Env } from './env'
export interface Endpoint {
  host: string
  port: number
  explicitPort: boolean
}
export function publicIp(ip: string) {
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:db8:/i.test(ip)
  if (isIP(ip) !== 4) return false
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return false
  const [a, b] = parts as [number, number, number, number]
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  )
}
export function minecraftAddress(value: string, defaultPort = 25565): Endpoint | null {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value.trim())
  if (!m) return null
  const host = m[1]!.replace(/^\[|\]$/g, '').toLowerCase()
  const port = m[2] ? Number(m[2]) : defaultPort
  if (
    port < 1 ||
    port > 65535 ||
    host.length > 253 ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (host.includes(':') || /^[\d.]+$/.test(host)
      ? !publicIp(host)
      : !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host))
  )
    return null
  return { host, port, explicitPort: !!m[2] }
}
async function dns(name: string, type: 'SRV' | 'A' | 'AAAA', signal: AbortSignal) {
  const url = new URL('https://cloudflare-dns.com/dns-query')
  url.search = new URLSearchParams({ name, type }).toString()
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal })
  if (!res.ok) throw new Error('dns-unavailable')
  const data = await res.json<{ Status: number; Answer?: { type: number; data: string }[] }>()
  if (data.Status !== 0 && data.Status !== 3) throw new Error('dns-unavailable')
  return data.Answer ?? []
}
export async function minecraftEndpoint(address: Endpoint, signal: AbortSignal) {
  let { host, port } = address
  if (!address.explicitPort && !publicIp(host)) {
    const answers = await dns(`_minecraft._tcp.${host}`, 'SRV', signal)
    const records = answers
      .filter((a) => a.type === 33)
      .map((a) => {
        const [priority, weight, p, target] = a.data.trim().split(/\s+/)
        const endpoint = minecraftAddress(`${target?.replace(/\.$/, '')}:${p}`)
        if (!endpoint || !/^\d+$/.test(priority ?? '') || !/^\d+$/.test(weight ?? ''))
          throw new Error('bad-srv')
        return { ...endpoint, priority: Number(priority), weight: Number(weight) }
      })
    if (records.length) {
      const priority = Math.min(...records.map((r) => r.priority))
      const candidates = records.filter((r) => r.priority === priority)
      const total = candidates.reduce((sum, r) => sum + r.weight, 0)
      let choice = Math.random() * (total || candidates.length)
      const pick = candidates.find((r) => (choice -= total ? r.weight : 1) < 0) ?? candidates[0]!
      host = pick.host
      port = pick.port
    }
  }
  if (publicIp(host)) return { host, port }
  const answers = [...(await dns(host, 'A', signal)), ...(await dns(host, 'AAAA', signal))].filter(
    (a) => a.type === 1 || a.type === 28,
  )
  if (!answers.length || answers.some((a) => !publicIp(a.data)))
    throw new Error('non-public-address')
  // 连接已验证的数值地址，避免第二次 DNS 解析改变目标。
  return { host: answers[0]!.data, port }
}
export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let rest = value >>> 0
  do {
    let b = rest & 127
    rest >>>= 7
    if (rest) b |= 128
    bytes.push(b)
  } while (rest)
  return Buffer.from(bytes)
}
export function decodeVarInt(buffer: Buffer, offset = 0): { value: number; next: number } | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const b = buffer[offset + i]
    if (b === undefined) return null
    value += (b & 127) * 2 ** (7 * i)
    if (!(b & 128)) {
      if (value > 0x7fffffff) throw new Error('bad-varint')
      return { value, next: offset + i + 1 }
    }
  }
  throw new Error('bad-varint')
}
export function statusRequest(host: string, port: number) {
  const bytes = Buffer.from(host, 'utf8'),
    p = Buffer.alloc(2)
  p.writeUInt16BE(port)
  const handshake = Buffer.concat([
    encodeVarInt(0),
    encodeVarInt(-1),
    encodeVarInt(bytes.length),
    bytes,
    p,
    encodeVarInt(1),
  ])
  return Buffer.concat([encodeVarInt(handshake.length), handshake, Buffer.from([1, 0])])
}
export function readMinecraftPacket(packet: Buffer) {
  const id = decodeVarInt(packet)
  if (!id || id.value !== 0) throw new Error('bad-packet')
  const size = decodeVarInt(packet, id.next)
  if (!size || size.next + size.value !== packet.length) throw new Error('bad-packet')
  const data = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(packet.subarray(size.next)),
  )
  if (
    typeof data.version?.name !== 'string' ||
    !Number.isInteger(data.players?.online) ||
    data.players.online < 0 ||
    !Number.isInteger(data.players?.max) ||
    data.players.max < 0
  )
    throw new Error('bad-status')
  return {
    online: true,
    status: 'operational',
    version: data.version,
    players: data.players,
    description: data.description,
    favicon: data.favicon,
  }
}
export function queryMinecraft(
  endpoint: { host: string; port: number },
  handshakeHost: string,
  signal: AbortSignal,
  connect: (target: { host: string; port: number }) => Socket = (target) =>
    createConnection(target),
) {
  signal.throwIfAborted()
  return new Promise<ReturnType<typeof readMinecraftPacket>>((resolve, reject) => {
    const socket = connect(endpoint)
    let received = Buffer.alloc(0)
    let done = false
    const finish = (error?: unknown, result?: ReturnType<typeof readMinecraftPacket>) => {
      if (done) return
      done = true
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    socket.once('error', (e) => finish(e))
    socket.once('close', () => finish(new Error('closed')))
    socket.once('connect', () => {
      if (!done) socket.write(statusRequest(handshakeHost, endpoint.port))
    })
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      try {
        if (received.length + chunk.length > 131077) throw new Error('packet-too-large')
        received = Buffer.concat([received, chunk])
        const frame = decodeVarInt(received)
        if (!frame) return
        if (frame.value > 131072) throw new Error('packet-too-large')
        if (received.length >= frame.next + frame.value)
          finish(
            undefined,
            readMinecraftPacket(received.subarray(frame.next, frame.next + frame.value)),
          )
      } catch (e) {
        finish(e)
      }
    })
    if (signal.aborted) abort()
  })
}
async function thirdPartyStatus(name: string, kind: 'java' | 'bedrock') {
  const res = await fetch(`https://api.mcstatus.io/v2/status/${kind}/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error('upstream')
  const data = await res.json<Record<string, unknown>>()
  if (typeof data.online !== 'boolean') throw new Error('bad-status')
  const players = data.players as { online?: number; max?: number } | undefined
  const version = data.version as { name?: string; name_clean?: string } | undefined
  return {
    address: name,
    online: data.online,
    players: data.players,
    playersOnline: players?.online ?? null,
    playersMax: players?.max ?? null,
    version: version?.name_clean ?? version?.name ?? '',
    motd: (data.motd as { raw?: string })?.raw ?? '',
    favicon: data.icon,
    latencyMs: data.round_trip_latency,
    provider: 'mcstatus.io',
  }
}
export function minecraft(
  env: Env,
  address: Endpoint,
  kind: 'java' | 'bedrock',
  probe: typeof queryMinecraft = queryMinecraft,
) {
  return cached(
    env,
    `minecraft:${kind}:${address.host}:${address.port}:${address.explicitPort}`,
    60,
    async () => {
      const name =
        (address.host.includes(':') ? `[${address.host}]` : address.host) + `:${address.port}`
      const queryName = address.explicitPort
        ? name
        : address.host.includes(':')
          ? `[${address.host}]`
          : address.host
      if (kind === 'bedrock') return thirdPartyStatus(queryName, kind)
      const signal = AbortSignal.timeout(8000)
      const endpoint = await minecraftEndpoint(address, signal),
        started = performance.now()
      try {
        const data = await probe(endpoint, address.host, signal)
        return { ...data, address: queryName, latencyMs: Math.round(performance.now() - started) }
      } catch {
        // Cloudflare 不允许 Worker TCP 连接到部分托管 / 代理地址，换用固定第三方。
        // 公网 DNS 验证在此之前完成；不对无效或内网地址进行回退。
        return thirdPartyStatus(queryName, 'java')
      }
    },
    3600,
  )
}
