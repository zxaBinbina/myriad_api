import { cached } from './data'
import type { Env } from './env'
const FRANK = 'https://api.frankfurter.dev/v1'
const ER = 'https://open.er-api.com/v6'
const FAWAZ = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api'
async function json(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error('upstream')
  return res.json<Record<string, unknown>>()
}
export const currencyCode = (value: string) =>
  /^[A-Za-z]{2,12}$/.test(value) ? value.toUpperCase() : null
export function currencyRate(env: Env, base: string, quote: string, date = 'latest') {
  return cached(
    env,
    `currency:${base}:${quote}:${date}`,
    12 * 3600,
    async () => {
      if (base === quote)
        return {
          base,
          quote,
          rate: 1,
          date: date === 'latest' ? new Date().toISOString().slice(0, 10) : date,
          provider: 'identity',
        }
      const sources: { provider: string; url: string; key: string }[] = [
        {
          provider: 'Frankfurter',
          url: `${FRANK}/${date}?base=${base}&symbols=${quote}`,
          key: 'rates',
        },
        ...(date === 'latest'
          ? [{ provider: 'ExchangeRate-API', url: `${ER}/latest/${base}`, key: 'rates' }]
          : []),
        {
          provider: 'Currency API',
          url: `${FAWAZ}@${date}/v1/currencies/${base.toLowerCase()}.json`,
          key: base.toLowerCase(),
        },
      ]
      for (const source of sources) {
        try {
          const data = await json(source.url)
          const rates = data[source.key] as Record<string, unknown> | undefined
          const rate = rates?.[source.key === 'rates' ? quote : quote.toLowerCase()]
          if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) continue
          return {
            base,
            quote,
            rate,
            provider: source.provider,
            date:
              typeof data.date === 'string'
                ? data.date
                : typeof data.time_last_update_unix === 'number'
                  ? new Date(data.time_last_update_unix * 1000).toISOString().slice(0, 10)
                  : '',
          }
        } catch {
          /* 换用不需要 Key 的备用源 */
        }
      }
      throw new Error('currency-unavailable')
    },
    7 * 86400,
  )
}
export function currencyHistory(env: Env, base: string, quote: string, from: string, to: string) {
  return cached(
    env,
    `currency-history:${base}:${quote}:${from}:${to}`,
    12 * 3600,
    async () => {
      const data = await json(`${FRANK}/${from}..${to}?base=${base}&symbols=${quote}`)
      const rates = data.rates as Record<string, Record<string, unknown>> | undefined
      const history = Object.entries(rates ?? {})
        .flatMap(([date, values]) => {
          const rate = values[quote]
          return typeof rate === 'number' && rate > 0 && Number.isFinite(rate)
            ? [{ date, rate }]
            : []
        })
        .sort((a, b) => a.date.localeCompare(b.date))
      if (!history.length) throw new Error('history-unavailable')
      return { base, quote, history, provider: 'Frankfurter' }
    },
    7 * 86400,
  )
}
