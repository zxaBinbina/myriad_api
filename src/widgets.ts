import { cached } from './data'
import type { Env } from './env'

async function json(url: URL) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`upstream-${res.status}`)
  return res.json<Record<string, unknown>>()
}

export function coordinates(lat: string | undefined, lon: string | undefined) {
  if (!lat?.trim() || !lon?.trim()) return null
  const latitude = Number(lat)
  const longitude = Number(lon)
  if (
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    return null
  return {
    latitude: Math.round(latitude * 100) / 100,
    longitude: Math.round(longitude * 100) / 100,
  }
}

export function weather(env: Env, latitude: number, longitude: number, air: boolean) {
  return cached(
    env,
    `weather:${latitude}:${longitude}:${air}`,
    1800,
    async () => {
      const url = new URL('https://api.open-meteo.com/v1/forecast')
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        timezone: 'auto',
        forecast_days: '7',
        current: 'temperature_2m,apparent_temperature,weather_code,is_day',
        hourly: 'temperature_2m,weather_code',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
      }).toString()
      const aqiUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
      aqiUrl.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: 'us_aqi',
      }).toString()
      const [data, aqi] = await Promise.all([
        json(url),
        air ? json(aqiUrl).catch(() => null) : Promise.resolve(null),
      ])
      return { ...data, aqi: (aqi?.current as { us_aqi?: number } | undefined)?.us_aqi ?? null }
    },
    86400,
  )
}

export function cities(env: Env, name: string, language: 'zh' | 'en') {
  return cached(env, `cities:${language}:${name}`, 86400, async () => {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
    url.search = new URLSearchParams({ name, language, count: '8', format: 'json' }).toString()
    return json(url)
  })
}

export function dailyQuote(env: Env, day: string, categories: string) {
  return cached(
    env,
    `quote:${day}:${categories}`,
    86400,
    async () => {
      const url = new URL('https://v1.hitokoto.cn/')
      for (const c of categories) url.searchParams.append('c', c)
      const quote = await json(url)
      if (typeof quote.hitokoto !== 'string' || !quote.hitokoto.trim())
        throw new Error('invalid-quote')
      return quote
    },
    3 * 86400,
  )
}
