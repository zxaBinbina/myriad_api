import type { Env } from './env'

/**
 * 图标代理：抓取网站声明的高清图标（apple-touch-icon / 带尺寸的 icon），退回 /favicon.ico。
 * 结果存 R2（按主机名），索引存 KV；两者都没有时只依赖 Cache API。
 * 找不到图标时返回 404，客户端继续走自己的回退链（图标库 → 文字图标）。
 */

const MAX_HTML = 512 * 1024
const MAX_ICON = 512 * 1024
const INDEX_TTL = 30 * 86400
const MISS_TTL = 86400
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 MyriadIconBot/1.0'

/** SVG 图标与 HTML 同源时可能执行脚本，统一加上沙箱 */
export const ICON_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=604800',
}

interface Candidate {
  href: string
  size: number
  rel: string
}

interface IndexEntry {
  /** R2 键；为 null 表示找不到图标 */
  key: string | null
  type?: string
  at: number
}

/** 拒绝非 http(s)、IP 字面量与内网主机名 */
export function iconTarget(raw: string | null): URL | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const h = u.hostname
  if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.internal')) return null
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return null
  return u
}

function sizeOf(sizes: string | null, rel: string, href: string): number {
  if (sizes) {
    if (sizes.trim() === 'any') return 512
    const n = Math.max(...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0))
    if (n > 0) return n
  }
  if (/\.svg(\?|$)/i.test(href)) return 512
  if (rel.includes('apple-touch-icon')) return 180
  if (rel.includes('mask-icon')) return 0
  return 32
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('Content-Length') || 0)
  if (len > limit) return null
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 从页面 HTML 中找出图标候选（HTMLRewriter 流式解析） */
export async function findCandidates(page: Response, base: string): Promise<Candidate[]> {
  const found: Candidate[] = []
  let baseHref = base
  const rewriter = new HTMLRewriter()
    .on('base[href]', {
      element(el) {
        try {
          baseHref = new URL(el.getAttribute('href')!, base).href
        } catch {
          /* 忽略 */
        }
      },
    })
    .on('link[rel][href]', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase()
        if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) return
        const href = el.getAttribute('href')!
        found.push({ href, rel, size: sizeOf(el.getAttribute('sizes'), rel, href) })
      },
    })
  const html = await readLimited(page, MAX_HTML)
  if (!html) return []
  await rewriter.transform(new Response(html, { headers: page.headers })).arrayBuffer()
  return found
    .map((c) => {
      try {
        return { ...c, href: new URL(c.href, baseHref).href }
      } catch {
        return null
      }
    })
    .filter((c): c is Candidate => !!c && c.size > 0 && !c.href.startsWith('data:'))
}

/** 选择顺序：不小于目标尺寸中最小的 → 其余按尺寸从大到小 */
export function rankCandidates(list: Candidate[], want: number): Candidate[] {
  const big = list.filter((c) => c.size >= want).sort((a, b) => a.size - b.size)
  const small = list.filter((c) => c.size < want).sort((a, b) => b.size - a.size)
  const seen = new Set<string>()
  return [...big, ...small].filter((c) => !seen.has(c.href) && seen.add(c.href))
}

async function fetchImage(url: string): Promise<{ body: Uint8Array; type: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    let type = (res.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!type.startsWith('image/')) {
      // 部分站点把 .ico 标成 application/octet-stream
      if (/\.ico(\?|$)/i.test(url)) type = 'image/x-icon'
      else return null
    }
    const body = await readLimited(res, MAX_ICON)
    if (!body || body.length < 64) return null
    return { body, type }
  } catch {
    return null
  }
}

export async function resolveIcon(
  target: URL,
  want: number,
): Promise<{ body: Uint8Array; type: string } | null> {
  const origin = target.origin
  let candidates: Candidate[] = []
  try {
    const page = await fetch(`${origin}/`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    })
    if (page.ok && (page.headers.get('Content-Type') ?? '').includes('html')) {
      candidates = await findCandidates(page, page.url || `${origin}/`)
    }
  } catch {
    /* 页面打不开时仍尝试 /favicon.ico */
  }
  for (const c of rankCandidates(candidates, want).slice(0, 3)) {
    const img = await fetchImage(c.href)
    if (img) return img
  }
  for (const path of ['/apple-touch-icon.png', '/favicon.ico']) {
    const img = await fetchImage(`${origin}${path}`)
    if (img) return img
  }
  return null
}

function hostKey(target: URL) {
  return target.hostname.replace(/^www\./, '').toLowerCase()
}

function iconResponse(body: BodyInit, type: string) {
  return new Response(body, { headers: { ...ICON_HEADERS, 'Content-Type': type } })
}

function notFound() {
  return new Response('icon not found', {
    status: 404,
    headers: { 'Cache-Control': 'public, max-age=3600' },
  })
}

/** 处理 GET /v1/icon?url=&size= */
export async function handleIcon(env: Env, target: URL, want: number): Promise<Response> {
  const host = hostKey(target)
  const r2Key = `icons/${host}`
  const indexKey = `icon:${host}`

  const index = env.CACHE ? await env.CACHE.get<IndexEntry>(indexKey, 'json') : null
  if (index && !index.key) return notFound()
  if (env.BUCKET && (index?.key || !env.CACHE)) {
    const obj = await env.BUCKET.get(r2Key)
    if (obj) return iconResponse(obj.body, obj.httpMetadata?.contentType ?? 'image/png')
  }

  const img = await resolveIcon(target, want)
  if (!img) {
    await env.CACHE?.put(indexKey, JSON.stringify({ key: null, at: Date.now() }), {
      expirationTtl: MISS_TTL,
    })
    return notFound()
  }
  // 没有 R2 时不写索引，只靠路由层的 Cache API 缓存响应
  if (env.BUCKET) {
    await env.BUCKET.put(r2Key, img.body, { httpMetadata: { contentType: img.type } })
    await env.CACHE?.put(
      indexKey,
      JSON.stringify({ key: r2Key, type: img.type, at: Date.now() } satisfies IndexEntry),
      { expirationTtl: INDEX_TTL },
    )
  }
  return iconResponse(img.body, img.type)
}
