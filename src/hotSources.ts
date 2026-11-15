import { DomUtils } from 'htmlparser2'
import {
  documentOf,
  tags,
  parseFeed,
  plainText,
  httpUrl,
  type FeedEntry,
  type FeedSnapshot,
} from './content'

export const HOT_REQUESTS: Record<
  string,
  { url: string; body?: Record<string, unknown>; format?: 'html' | 'rss' }
> = {
  zhihu: { url: 'https://api.zhihu.com/topstory/hot-lists/total?limit=50' },
  weibo: { url: 'https://weibo.com/ajax/side/hotSearch' },
  bilibili: { url: 'https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1' },
  v2ex: { url: 'https://www.v2ex.com/api/topics/hot.json' },
  hackernews: { url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30' },
  github: { url: 'https://github.com/trending?since=daily', format: 'html' },
  sspai: {
    url: 'https://sspai.com/api/v1/article/tag/page/get?limit=30&offset=0&tag=%E7%83%AD%E9%97%A8%E6%96%87%E7%AB%A0',
  },
  ithome: { url: 'https://m.ithome.com/rankm/', format: 'html' },
  juejin: {
    url: 'https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed',
    body: { id_type: 2, sort_type: 200, cate_id: '1', cursor: '0', limit: 30 },
  },
  '36kr': {
    url: 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot',
    body: { partner_id: 'wap', param: { siteId: 1, platformId: 2 } },
  },
  baidu: { url: 'https://top.baidu.com/board?tab=realtime', format: 'html' },
  douyin: {
    url: 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1',
  },
}
export function parseHot(source: string, body: any): FeedSnapshot {
  const request = HOT_REQUESTS[source]
  if (!request) throw new Error('bad-source')
  if (request.format === 'rss') return parseFeed(String(body), request.url)
  let rows: any[] = []
  switch (source) {
    case 'zhihu':
      rows = body.data?.map((r: any) => ({
        title: r.target?.title,
        url: r.target?.url?.replace('api.zhihu.com/questions', 'www.zhihu.com/question'),
        description: r.target?.excerpt,
        heat: r.detail_text,
      }))
      break
    case 'weibo':
      rows = body.data?.realtime
        ?.filter((r: any) => !r.is_ad)
        .map((r: any) => ({
          title: r.word,
          url: `https://s.weibo.com/weibo?q=${encodeURIComponent(r.word)}`,
          heat: r.num,
        }))
      break
    case 'bilibili':
      rows = body.data?.list?.map((r: any) => ({
        title: r.title,
        url: `https://www.bilibili.com/video/${r.bvid}`,
        description: r.desc,
        heat: r.stat?.view,
      }))
      break
    case 'v2ex':
      rows = body?.map?.((r: any) => ({ ...r, description: r.content, heat: r.replies }))
      break
    case 'hackernews':
      rows = body.hits?.map((r: any) => ({
        title: r.title,
        url: r.url || `https://news.ycombinator.com/item?id=${r.objectID}`,
        heat: r.points,
      }))
      break
    case 'sspai':
      rows = body.data?.map?.((r: any) => ({
        title: r.title,
        url: `https://sspai.com/post/${r.id}`,
        description: r.summary,
        heat: r.like_count,
      }))
      break
    case 'juejin':
      rows = body.data?.map((r: any) => {
        const a = r.item_info?.article_info
        return {
          title: a?.title,
          url: a?.article_id ? `https://juejin.cn/post/${a.article_id}` : '',
          description: a?.brief_content,
          heat: a?.view_count,
        }
      })
      break
    case '36kr':
      rows = (body.data?.hotRankList || body.data?.itemList)?.map((r: any) => ({
        title: r.templateMaterial?.widgetTitle || r.title,
        url: `https://36kr.com/p/${r.itemId || r.id}`,
        description: r.templateMaterial?.summary,
      }))
      break
    case 'douyin':
      rows = body.data?.word_list?.map((r: any) => ({
        title: r.word,
        url: `https://www.douyin.com/search/${encodeURIComponent(r.word)}`,
        heat: r.hot_value,
      }))
      break
    default: {
      const doc = documentOf(String(body))
      if (source === 'github')
        rows = tags(doc, 'article').map((el) => {
          const h = DomUtils.getElementsByTagName('h2', el.children, true)[0]
          const a = h && DomUtils.getElementsByTagName('a', h.children, true)[0]
          const p = DomUtils.getElementsByTagName('p', el.children, true)[0]
          return {
            title: a && DomUtils.textContent(a).replace(/\s+/g, ''),
            url: httpUrl(a?.attribs.href, request.url),
            description: p && DomUtils.textContent(p),
          }
        })
      else
        rows = tags(doc, 'a').flatMap((el) => {
          const href = httpUrl(el.attribs.href, request.url)
          const text = DomUtils.textContent(el).replace(/\s+/g, ' ').trim()
          const heading = DomUtils.findAll(
            (e) => (e.attribs.class || '').includes('c-single-text-ellipsis'),
            el.children,
          )[0]
          if (source === 'baidu' ? !heading : !/\/\d+\.htm/.test(href)) return []
          return [{ title: heading ? DomUtils.textContent(heading) : text, url: href }]
        })
    }
  }
  if (!Array.isArray(rows)) throw new Error('source-unavailable')
  const seen = new Set<string>()
  const items = rows.slice(0, 60).flatMap((r): FeedEntry[] => {
    const url = httpUrl(r.url),
      title = plainText(String(r.title || ''), 300)
    if (!url || !title || seen.has(url)) return []
    seen.add(url)
    return [
      {
        id: url,
        title,
        url,
        source,
        description: plainText(String(r.description || ''), 1200),
        ...(r.heat !== undefined ? { heat: String(r.heat).slice(0, 40) } : {}),
      },
    ]
  })
  if (!items.length) throw new Error('source-unavailable')
  return { title: source, items, fetchedAt: Date.now() }
}
