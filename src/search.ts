import { DomUtils } from 'htmlparser2'
import { documentOf, tags, plainText, httpUrl, canonicalUrl } from './content'

export const SEARCH_PROVIDERS = [
  'google',
  'bing',
  'baidu',
  'duckduckgo',
  'github',
  'npm',
  'mdn',
  'wikipedia',
  'mcwiki',
  'stackoverflow',
  'hackernews',
] as const
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number]
export type SearchRoute = 'auto' | 'direct' | 'worker' | 'link'
export interface SearchResult {
  title: string
  url: string
  description: string
  engines: string[]
}
export interface SearchPage {
  items: SearchResult[]
  next: number | null
  provider?: string
  backoff?: number
}
export function searchApiUrl(engine: string, query: string, page = 0, language = 'zh-CN'): string {
  const q = encodeURIComponent(query)
  switch (engine) {
    case 'github':
      return `https://api.github.com/search/repositories?q=${q}&per_page=20&page=${page + 1}`
    case 'npm':
      return `https://registry.npmjs.org/-/v1/search?text=${q}&size=20&from=${page * 20}`
    case 'mdn':
      return `https://developer.mozilla.org/api/v1/search?q=${q}&locale=${language}&page=${page + 1}`
    case 'wikipedia':
    case 'mcwiki':
      return `https://${engine === 'mcwiki' ? (language === 'en' ? 'minecraft.wiki' : 'zh.minecraft.wiki') : language === 'en' ? 'en.wikipedia.org' : 'zh.wikipedia.org'}/w/api.php?action=query&list=search&srsearch=${q}&srlimit=20&sroffset=${page * 20}&format=json&origin=*`
    case 'stackoverflow':
      return `https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&q=${q}&pagesize=20&page=${page + 1}&filter=withbody`
    case 'hackernews':
      return `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=20&page=${page}`
    default:
      return ''
  }
}
export function webSearchUrl(engine: string, query: string, page = 0) {
  const q = encodeURIComponent(query)
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}&start=${page * 10}`
    case 'bing':
      return `https://www.bing.com/search?q=${q}&first=${page * 10 + 1}`
    case 'baidu':
      return `https://www.baidu.com/s?wd=${q}&pn=${page * 10}`
    case 'duckduckgo':
      return `https://html.duckduckgo.com/html/?q=${q}`
    default:
      return ''
  }
}
export function parseSearchJson(
  engine: string,
  body: any,
  page: number,
  language = 'zh-CN',
): SearchPage {
  let rows: any[] = [],
    more = false
  switch (engine) {
    case 'github':
      rows = body.items?.map((r: any) => ({
        title: r.full_name,
        url: r.html_url,
        description: r.description,
      }))
      more = (page + 1) * 20 < Math.min(body.total_count || 0, 1000)
      break
    case 'npm':
      rows = body.objects?.map((r: any) => ({
        title: r.package?.name,
        url: r.package?.links?.npm,
        description: r.package?.description,
      }))
      more = (page + 1) * 20 < body.total
      break
    case 'mdn':
      rows = body.documents?.map((r: any) => ({
        title: r.title,
        url: httpUrl(r.mdn_url, 'https://developer.mozilla.org'),
        description: r.summary,
      }))
      more = (page + 1) * (body.metadata?.size || rows?.length || 20) < (body.metadata?.found || 0)
      break
    case 'wikipedia':
    case 'mcwiki': {
      const host =
        engine === 'mcwiki'
          ? language === 'en'
            ? 'https://minecraft.wiki'
            : 'https://zh.minecraft.wiki'
          : language === 'en'
            ? 'https://en.wikipedia.org'
            : 'https://zh.wikipedia.org'
      rows = body.query?.search?.map((r: any) => ({
        title: r.title,
        url: `${host}/?curid=${r.pageid}`,
        description: r.snippet,
      }))
      more = !!body.continue
      break
    }
    case 'stackoverflow':
      rows = body.items?.map((r: any) => ({ title: r.title, url: r.link, description: r.body }))
      more = body.has_more === true
      break
    case 'hackernews':
      rows = body.hits?.map((r: any) => ({
        title: r.title,
        url: r.url || `https://news.ycombinator.com/item?id=${r.objectID}`,
        description: r.story_text,
      }))
      more = page + 1 < body.nbPages
      break
  }
  if (!Array.isArray(rows)) throw new Error('search-upstream')
  const items = rows.flatMap((r): SearchResult[] => {
    const url = httpUrl(r.url),
      title = plainText(String(r.title || ''), 300)
    return url && title
      ? [
          {
            title,
            url,
            description: plainText(String(r.description || ''), 1200),
            engines: [engine],
          },
        ]
      : []
  })
  return {
    items,
    next: more && items.length ? page + 1 : null,
    ...(Number(body.backoff) > 0 ? { backoff: Number(body.backoff) } : {}),
  }
}
/** Engine HTML is parsed as data, never inserted into the extension DOM. */
export function parseSearchHtml(engine: string, html: string, page: number): SearchPage {
  const doc = documentOf(html),
    base = webSearchUrl(engine, '')
  const blocks = DomUtils.findAll(
    (el) =>
      engine === 'bing'
        ? (el.attribs.class || '').split(' ').includes('b_algo')
        : engine === 'baidu'
          ? /(^|\s)(result|c-container)(\s|$)/.test(el.attribs.class || '')
          : engine === 'duckduckgo'
            ? /(^|\s)result(\s|$)/.test(el.attribs.class || '')
            : !!DomUtils.getElementsByTagName('h3', el.children, true).length && el.name === 'a',
    doc.children,
  )
  const items: SearchResult[] = []
  for (const block of blocks.slice(0, 100)) {
    const links =
      block.name === 'a' ? [block] : DomUtils.getElementsByTagName('a', block.children, true)
    const link =
      links.find((l) =>
        engine === 'duckduckgo'
          ? /result__a/.test(l.attribs.class || '')
          : DomUtils.getElementsByTagName(engine === 'bing' ? 'h2' : 'h3', l.children, true).length,
      ) || links.find((l) => l.attribs.href)
    let url = httpUrl(link?.attribs.href, base)
    if (!url || !link) continue
    const u = new URL(url)
    if (u.hostname.endsWith('google.com') && u.pathname === '/url')
      url = httpUrl(u.searchParams.get('q') || u.searchParams.get('url'))
    if (u.searchParams.has('uddg')) url = httpUrl(u.searchParams.get('uddg'))
    if (u.hostname.endsWith('bing.com') && u.pathname === '/ck/a') {
      try {
        const v = u.searchParams.get('u') || ''
        url = v.startsWith('a1')
          ? httpUrl(atob(v.slice(2).replace(/-/g, '+').replace(/_/g, '/')))
          : ''
      } catch {
        url = ''
      }
    }
    if (!url) continue
    const title = plainText(DomUtils.textContent(link), 300)
    if (!title) continue
    const p = DomUtils.getElementsByTagName('p', block.children, true)[0]
    const description = p
      ? DomUtils.textContent(p)
      : engine === 'google' && block.parent
        ? DomUtils.textContent(block.parent)
        : DomUtils.textContent(block)
    items.push({ title, url, description: plainText(description, 1200), engines: [engine] })
  }
  const merged = mergeSearchResults(items)
  if (!merged.length) throw new Error('search-blocked-or-empty')
  return {
    items: merged,
    next: engine === 'duckduckgo' ? null : merged.length >= 8 ? page + 1 : null,
  }
}
export function mergeSearchResults(items: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>()
  for (const item of items) {
    const key = canonicalUrl(item.url)
    if (!key) continue
    const old = byUrl.get(key)
    if (old) old.engines = [...new Set([...old.engines, ...item.engines])]
    else byUrl.set(key, { ...item, engines: [...item.engines] })
  }
  return [...byUrl.values()]
}
