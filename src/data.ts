import type { Env } from './env'

/**
 * 小型数据接口：节假日、粗略地理位置、Unsplash 每日壁纸。
 * 短期结果缓存在 KV；没有 KV 时退回 Cache API（由路由层处理）。
 */

/* ---------------- KV 缓存 ---------------- */

interface Cached<T> {
  at: number
  value: T
}

/**
 * 读取缓存，过期（maxAge 秒）后调用 load 刷新；刷新失败时返回旧值。
 * KV 条目本身保留 staleTtl 秒，供离线兜底。
 */
export async function cached<T>(
  env: Env,
  key: string,
  maxAge: number,
  load: () => Promise<T>,
  staleTtl = 30 * 86400,
): Promise<T> {
  const kv = env.CACHE
  const hit = kv ? await kv.get<Cached<T>>(key, 'json') : null
  if (hit && Date.now() - hit.at < maxAge * 1000) return hit.value
  try {
    const value = await load()
    await kv?.put(key, JSON.stringify({ at: Date.now(), value }), { expirationTtl: staleTtl })
    return value
  } catch (e) {
    if (hit) return hit.value
    throw e
  }
}

/* ---------------- 节假日 ---------------- */

const HOLIDAY_SOURCES = [
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
]

export class NotFound extends Error {}

/** 原样返回 holiday-cn 的 JSON（{ year, days: [...] }），客户端用同一个解析函数 */
export async function fetchHolidays(year: number): Promise<unknown> {
  let last: unknown = new Error('no source')
  for (const tpl of HOLIDAY_SOURCES) {
    try {
      const res = await fetch(tpl.replace('{year}', String(year)), {
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 404) return { year, days: [] }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      last = e
    }
  }
  throw last
}

export function holidays(env: Env, year: number) {
  return cached(env, `holidays:${year}`, 86400, () => fetchHolidays(year), 365 * 86400)
}

/** Cron：刷新今年（第四季度再加上明年）的节假日 */
export async function refreshHolidays(env: Env, now = new Date()) {
  if (!env.CACHE) return
  const years = [now.getUTCFullYear()]
  if (now.getUTCMonth() >= 9) years.push(years[0]! + 1)
  for (const y of years) {
    try {
      const value = await fetchHolidays(y)
      await env.CACHE.put(`holidays:${y}`, JSON.stringify({ at: Date.now(), value }), {
        expirationTtl: 365 * 86400,
      })
    } catch {
      /* 下次再试 */
    }
  }
}

/* ---------------- 地理位置 ---------------- */

export function geoOf(req: Request) {
  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf
  return {
    country: cf?.country ?? null,
    region: cf?.region ?? null,
    city: cf?.city ?? null,
    timezone: cf?.timezone ?? null,
    latitude: cf?.latitude ? Number(cf.latitude) : null,
    longitude: cf?.longitude ? Number(cf.longitude) : null,
  }
}

/* ---------------- Unsplash ---------------- */

export interface DailyWallpaper {
  url: string
  /** 小图，用于设置面板预览 */
  thumb: string
  color: string | null
  author: string
  authorUrl: string
  link: string
}

interface UnsplashPhoto {
  color?: string
  urls: { raw: string; small: string }
  links: { html: string; download_location: string }
  user: { name: string; links: { html: string } }
}

const REF = '?utm_source=myriad&utm_medium=referral'

/** 每天一张（按 UTC 日期 + 主题缓存）。遵守 Unsplash 要求：触发 download 统计、注明作者 */
export function unsplashDaily(
  env: Env,
  query: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<DailyWallpaper> {
  const day = new Date().toISOString().slice(0, 10)
  const q = query.trim().slice(0, 40) || 'nature'
  return cached(env, `unsplash:${day}:${q}`, 86400, async () => {
    const api = new URL('https://api.unsplash.com/photos/random')
    api.searchParams.set('orientation', 'landscape')
    api.searchParams.set('content_filter', 'high')
    api.searchParams.set('query', q)
    const res = await fetch(api, {
      headers: {
        Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`,
        'Accept-Version': 'v1',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`)
    const p = (await res.json()) as UnsplashPhoto
    waitUntil(
      fetch(p.links.download_location, {
        headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
      }).catch(() => undefined),
    )
    return {
      url: `${p.urls.raw}&w=2560&q=80&fm=jpg&fit=max`,
      thumb: p.urls.small,
      color: p.color ?? null,
      author: p.user.name,
      authorUrl: p.user.links.html + REF,
      link: p.links.html + REF,
    }
  })
}
