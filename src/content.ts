import { parseDocument, DomUtils } from 'htmlparser2'

/** Parse untrusted markup without creating browser DOM or fetching embedded resources. */
export const documentOf = (html: string, xmlMode = false): ReturnType<typeof parseDocument> =>
  parseDocument(html.slice(0, 1024 * 1024), { xmlMode, decodeEntities: true })
export const tags = (
  node: ReturnType<typeof documentOf>,
  name: string,
): ReturnType<typeof DomUtils.getElementsByTagName> =>
  DomUtils.getElementsByTagName(name, node.children, true)
export function httpUrl(raw: unknown, base?: string): string {
  if (typeof raw !== 'string' || raw.length > 4096) return ''
  try {
    const u = new URL(raw, base)
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''
  } catch {
    return ''
  }
}
export function plainText(html: string, limit = 600): string {
  const doc = documentOf(html)
  for (const name of ['script', 'style', 'iframe', 'noscript', 'svg', 'template'])
    for (const el of tags(doc, name)) DomUtils.removeElement(el)
  return DomUtils.textContent(doc).replace(/\s+/g, ' ').trim().slice(0, limit)
}
export function canonicalUrl(raw: string): string {
  const safe = httpUrl(raw)
  if (!safe) return ''
  const u = new URL(safe)
  u.hash = ''
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|spm$|from$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key)
  u.searchParams.sort()
  return u.href.replace(/\/$/, '')
}

export interface FeedEntry {
  id: string
  title: string
  url: string
  source: string
  description: string
  published?: string
  heat?: string
}
export interface FeedSnapshot {
  title: string
  items: FeedEntry[]
  fetchedAt: number
  stale?: boolean
}
export function parseFeed(xml: string, base: string): FeedSnapshot {
  if (xml.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('bad-feed')
  const doc = documentOf(xml, true)
  const entries = [...tags(doc, 'item'), ...tags(doc, 'entry')].slice(0, 100)
  if (!tags(doc, 'rss').length && !tags(doc, 'feed').length && !tags(doc, 'rdf:RDF').length)
    throw new Error('bad-feed')
  const root = tags(doc, 'channel')[0] ?? tags(doc, 'feed')[0]
  const child = (node: { children: typeof doc.children }, names: string[]) => {
    for (const name of names) {
      const el = DomUtils.getElementsByTagName(name, node.children, false)[0]
      if (el) return DomUtils.textContent(el)
    }
    return ''
  }
  const title = plainText(root ? child(root, ['title']) : '', 120) || new URL(base).hostname
  const seen = new Set<string>()
  const items = entries.flatMap((node): FeedEntry[] => {
    const links = DomUtils.getElementsByTagName('link', node.children, false)
    const link = links.find((el) => !el.attribs.rel || el.attribs.rel === 'alternate')
    const url = httpUrl(
      link?.attribs.href || (link && DomUtils.textContent(link)) || child(node, ['guid']),
      base,
    )
    const name = plainText(child(node, ['title']), 300)
    const key = canonicalUrl(url)
    if (!key || !name || seen.has(key)) return []
    seen.add(key)
    const date = child(node, ['pubDate', 'published', 'updated', 'dc:date'])
    return [
      {
        id: key,
        title: name,
        url,
        source: title,
        description: plainText(
          child(node, ['description', 'summary', 'content:encoded', 'content']),
          1200,
        ),
        ...(date && Number.isFinite(Date.parse(date))
          ? { published: new Date(date).toISOString() }
          : {}),
      },
    ]
  })
  return { title, items, fetchedAt: Date.now() }
}

export type ReaderBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; alt: string }
  | { type: 'video' | 'audio'; url: string; poster?: string; label: string }
  | { type: 'unavailable'; label: string; url?: string }
export interface ReaderArticle {
  title: string
  url: string
  description: string
  paragraphs: string[]
  /** Optional for older cached responses. Never contains executable markup. */
  blocks?: ReaderBlock[]
}
export function parseArticle(html: string, url: string): ReaderArticle {
  const doc = documentOf(html)
  for (const name of [
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'footer',
    'header',
    'form',
    'template',
  ])
    for (const el of tags(doc, name)) DomUtils.removeElement(el)
  const meta = tags(doc, 'meta')
  const property = (name: string) =>
    meta.find((el) => el.attribs.property === name || el.attribs.name === name)?.attribs.content ??
    ''
  const title = plainText(
    property('og:title') || DomUtils.textContent(tags(doc, 'title')[0] ?? doc),
    300,
  )
  const root = tags(doc, 'article')[0] ?? tags(doc, 'main')[0] ?? tags(doc, 'body')[0] ?? doc
  const mediaBase = httpUrl(tags(doc, 'base')[0]?.attribs.href, url) || url
  const paragraphs: string[] = []
  const blocks: ReaderBlock[] = []
  let length = 0
  let pending = ''
  function flush() {
    const text = pending.replace(/\s+/g, ' ').trim().slice(0, 4000)
    pending = ''
    if (!text || length >= 24000 || paragraphs.length >= 100 || blocks.length >= 160) return
    length += text.length
    paragraphs.push(text)
    blocks.push({ type: 'text', text })
  }
  function walk(nodes: typeof doc.children) {
    for (const node of nodes) {
      if (blocks.length >= 160) break
      if (node.type === 'text') {
        pending += node.data.slice(0, 4000)
        continue
      }
      if (!('name' in node) || !('attribs' in node)) continue
      const name = node.name,
        a = node.attribs
      if (['img', 'video', 'audio', 'iframe', 'object', 'embed', 'svg'].includes(name)) {
        flush()
        const candidates = [a['data-src'], a['data-original'], a['data-lazy-src'], a.src]
        if (name === 'img') {
          // picture / srcset-only images are common in article sites.
          const picture =
            node.parent && 'name' in node.parent && node.parent.name === 'picture'
              ? DomUtils.getElementsByTagName('source', node.parent.children, false)
              : []
          candidates.push((a['data-srcset'] || a.srcset)?.split(',')[0]?.trim().split(/\s+/)[0])
          for (const s of picture)
            candidates.push(s.attribs.srcset?.split(',')[0]?.trim().split(/\s+/)[0])
        } else if (name === 'video' || name === 'audio') {
          for (const s of DomUtils.getElementsByTagName('source', node.children, false))
            candidates.push(s.attribs.src)
        }
        const src =
          candidates
            .filter(Boolean)
            .map((s) => httpUrl(s, mediaBase))
            .find(Boolean) || ''
        const label = plainText(a.alt || a.title || a['aria-label'] || name, 300)
        if (name === 'img' && src)
          blocks.push({ type: 'image', url: src, alt: a.alt?.slice(0, 300) || '' })
        else if ((name === 'video' || name === 'audio') && src)
          blocks.push({
            type: name,
            url: src,
            label,
            ...(a.poster && httpUrl(a.poster, mediaBase)
              ? { poster: httpUrl(a.poster, mediaBase) }
              : {}),
          })
        else blocks.push({ type: 'unavailable', label, ...(src ? { url: src } : {}) })
        continue
      }
      if (name === 'br') pending += '\n'
      const boundary = [
        'p',
        'h1',
        'h2',
        'h3',
        'h4',
        'li',
        'pre',
        'blockquote',
        'div',
        'section',
        'figure',
        'figcaption',
      ].includes(name)
      if (boundary) flush()
      walk(node.children)
      if (boundary) flush()
    }
  }
  walk(root.children)
  flush()
  return {
    title,
    url,
    description: plainText(property('description') || property('og:description'), 1200),
    paragraphs,
    blocks,
  }
}
