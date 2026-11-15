import type { Env } from './env'
import { searchApiUrl, parseSearchJson, type SearchPage } from './search'
import { httpUrl, plainText } from './content'

export async function siteSearch(
  engine: string,
  q: string,
  page: number,
  lang: string,
  signal: AbortSignal,
): Promise<SearchPage> {
  const url = searchApiUrl(engine, q, page, lang)
  if (!url) throw new Error('unsupported-search')
  const res = await fetch(url, {
    signal,
    redirect: 'manual',
    headers: { Accept: 'application/json', 'User-Agent': 'Myriad/0.1' },
  })
  if (!res.ok) throw new Error('search-unavailable')
  return parseSearchJson(engine, await res.json(), page, lang)
}
export function webProviders(env: Env) {
  const c = env.SERVICE_CREDENTIALS
  return [
    c?.brave?.key || env.BRAVE_SEARCH_KEY ? 'brave' : '',
    (c?.google?.key || env.GOOGLE_SEARCH_KEY) && (c?.google?.id || env.GOOGLE_SEARCH_ID)
      ? 'google'
      : '',
  ].filter(Boolean)
}
export async function webSearch(
  env: Env,
  engine: string,
  q: string,
  page: number,
  signal: AbortSignal,
): Promise<SearchPage> {
  const providers = webProviders(env)
  if (!providers.length) throw new Error('search-disabled')
  const provider = engine === 'google' && providers.includes('google') ? 'google' : providers[0]!
  const c = env.SERVICE_CREDENTIALS
  const url = new URL(
    provider === 'google'
      ? 'https://www.googleapis.com/customsearch/v1'
      : 'https://api.search.brave.com/res/v1/web/search',
  )
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (provider === 'google') {
    if (page >= 10) return { items: [], next: null, provider }
    url.search = new URLSearchParams({
      q,
      key: c?.google?.key || env.GOOGLE_SEARCH_KEY!,
      cx: c?.google?.id || env.GOOGLE_SEARCH_ID!,
      num: '10',
      start: String(page * 10 + 1),
    }).toString()
  } else {
    if (page >= 10) return { items: [], next: null, provider }
    url.search = new URLSearchParams({ q, count: '20', offset: String(page) }).toString()
    headers['X-Subscription-Token'] = c?.brave?.key || env.BRAVE_SEARCH_KEY!
  }
  const res = await fetch(url, { headers, signal, redirect: 'manual' })
  if (!res.ok)
    throw new Error(
      res.status === 429 || res.status === 403 ? 'search-quota' : 'search-unavailable',
    )
  const body = await res.json<any>()
  const rows = provider === 'google' ? body.items : body.web?.results
  if (!Array.isArray(rows)) return { items: [], next: null, provider }
  const items = rows.flatMap((r: any) => {
    const url = httpUrl(r.link || r.url),
      title = plainText(String(r.title || ''), 300)
    return url && title
      ? [
          {
            title,
            url,
            description: plainText(String(r.snippet || r.description || ''), 1200),
            engines: [engine],
          },
        ]
      : []
  })
  return {
    items,
    provider,
    next:
      provider === 'google'
        ? body.queries?.nextPage && page < 9
          ? page + 1
          : null
        : body.query?.more_results_available && page < 9
          ? page + 1
          : null,
  }
}
