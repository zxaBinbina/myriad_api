import { importPKCS8, SignJWT } from 'jose'
import type { Env } from './env'
import { cached } from './data'
import { weather } from './widgets'

export function qweatherEnabled(env: Env) {
  return (
    /^[a-z0-9-]+\.qweatherapi\.com$/i.test(env.QWEATHER_HOST ?? '') &&
    !!(env.QWEATHER_API_KEY || (env.QWEATHER_PRIVATE_KEY && env.QWEATHER_KID && env.QWEATHER_SUB))
  )
}
function code(raw: unknown): number | null {
  const n = Number(raw)
  if (n === 100 || n === 150) return 0
  if (n >= 101 && n <= 154) return 3
  if (n >= 302 && n <= 304) return 95
  if (n >= 300 && n < 400) return 61
  if (n >= 400 && n < 500) return 71
  if (n >= 500 && n <= 515) return 45
  return null
}
const value = (v: any) =>
  typeof v?.value === 'number' && Number.isFinite(v.value) ? v.value : null
/** Current v1 APIs; v7 air/warnings were retired in 2026. Secrets never enter public routes. */
export async function personalWeather(
  env: Env,
  lat: number,
  lon: number,
  air: boolean,
  warnings: boolean,
  language: 'zh' | 'en',
  provider: string,
  signal: AbortSignal,
) {
  const fallback = async () => {
    signal.throwIfAborted()
    return {
      ...(await weather(env, lat, lon, air)),
      provider: 'open-meteo',
      warningsUnavailable: warnings,
    }
  }
  if (provider === 'open-meteo' || !qweatherEnabled(env)) return fallback()
  signal.throwIfAborted()
  return cached(
    env,
    `qweather:v2:${env.CREDENTIAL_REVISION ?? ''}:${lat}:${lon}:${air}:${warnings}:${language}`,
    900,
    async () => {
      let headers: Record<string, string>
      if (env.QWEATHER_API_KEY) headers = { 'X-QW-Api-Key': env.QWEATHER_API_KEY }
      else {
        const key = await importPKCS8(env.QWEATHER_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'EdDSA')
        const now = Math.floor(Date.now() / 1000)
        const jwt = await new SignJWT({ sub: env.QWEATHER_SUB })
          .setProtectedHeader({ alg: 'EdDSA', kid: env.QWEATHER_KID })
          .setIssuedAt(now - 30)
          .setExpirationTime(now + 300)
          .sign(key)
        headers = { Authorization: `Bearer ${jwt}` }
      }
      const get = async (path: string, params: Record<string, string> = {}) => {
        const url = new URL(`https://${env.QWEATHER_HOST}${path}/${lat}/${lon}`)
        url.search = new URLSearchParams({
          lang: language,
          localTime: 'true',
          ...params,
        }).toString()
        signal.throwIfAborted()
        const response = await fetch(url, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        })
        if (!response.ok) throw new Error('upstream')
        return response.json<any>()
      }
      try {
        const [now, hourly, daily, aq, alerts] = await Promise.all([
          get('/weather/v1/current'),
          get('/weather/v1/hourly', { hours: '24' }),
          get('/weather/v1/daily', { days: '7' }),
          air ? get('/airquality/v1/current').catch(() => null) : null,
          warnings ? get('/weatheralert/v1/current').catch(() => null) : null,
        ])
        signal.throwIfAborted()
        if (
          value(now.temperature) === null ||
          !Array.isArray(hourly.hours) ||
          !Array.isArray(daily.days)
        )
          throw new Error('upstream')
        const hours = hourly.hours.slice(0, 24),
          days = daily.days.slice(0, 7)
        const currentDate = now.validTime?.slice(0, 10)
        const currentDay =
          days.find((d: any) => d.astro?.sunrise?.slice(0, 10) === currentDate) ?? days[0]
        const isDay =
          currentDay?.astro?.sunrise && currentDay?.astro?.sunset
            ? Date.parse(now.validTime) >= Date.parse(currentDay.astro.sunrise) &&
              Date.parse(now.validTime) < Date.parse(currentDay.astro.sunset)
            : ![150, 151, 152, 153].includes(Number(now.condition?.code))
        const aqi = aq?.indexes?.find((i: any) => i.code === 'us-epa')
        return {
          provider: 'qweather',
          condition: now.condition?.text,
          current: {
            temperature_2m: value(now.temperature),
            apparent_temperature: value(now.feelsLike),
            weather_code: code(now.condition?.code),
            is_day: isDay ? 1 : 0,
            time: now.validTime,
          },
          hourly: {
            time: hours.map((h: any) => h.forecastTime),
            temperature_2m: hours.map((h: any) => value(h.temperature)),
            weather_code: hours.map((h: any) => code(h.condition?.code)),
          },
          daily: {
            time: days.map(
              (d: any) => d.astro?.sunrise?.slice(0, 10) ?? d.forecastStartTime?.slice(0, 10),
            ),
            temperature_2m_min: days.map((d: any) => value(d.temperatureMin)),
            temperature_2m_max: days.map((d: any) => value(d.temperatureMax)),
            weather_code: days.map((d: any) => code(d.daytime?.condition?.code)),
            sunrise: days.map((d: any) => d.astro?.sunrise ?? ''),
            sunset: days.map((d: any) => d.astro?.sunset ?? ''),
          },
          aqi: typeof aqi?.aqi === 'number' ? aqi.aqi : null,
          aqiStandard: 'US AQI',
          warnings: (Array.isArray(alerts?.alerts) ? alerts.alerts : [])
            .slice(0, 20)
            .map((a: any) => ({
              id: a.id,
              title: a.headline,
              text: [a.description, a.instruction].filter(Boolean).join('\n'),
              severity: a.severity,
            })),
          warningsUnavailable: warnings && !alerts,
        }
      } catch (e) {
        signal.throwIfAborted()
        return fallback()
      }
    },
    86400,
  )
}
