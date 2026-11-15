import { type Context, Hono } from 'hono'
import { requireAuth } from './auth'
import { bodyLimit } from 'hono/body-limit'
import { translate, translationInput, translators } from './translation'
import {
  BACKUP_REASONS,
  type BackupConfig,
  type BackupReason,
  backupConfig,
  createBackup,
  deleteBackup,
  getBackup,
  isBackupId,
  listBackups,
  prune,
} from './backups'
import { geoOf, holidays, refreshHolidays, unsplashDaily } from './data'
import { type AppEnv, type Env, features, VERSION } from './env'
import { handleIcon, iconTarget } from './icons'
import { cors, httpsOnly, rateLimit } from './middleware'
import { deleteObject, getObject, ObjectTooLargeError, putObject, readObjectBody } from './objects'
import { exchange, MAX_UPDATE_BYTES, maybeCompact, setConfig } from './sync'
import { cities, coordinates, dailyQuote, weather } from './widgets'
import { currencyCode, currencyHistory, currencyRate } from './currency'
import { minecraft, minecraftAddress } from './minecraft'
import { personalWeather } from './qweather'
import { github, githubQuery, GithubError } from './github'
import {
  credentialEnabled,
  credentialEnv,
  credentialFeatures,
  readCredentials,
  saveCredential,
  CredentialConflict,
} from './credentials'
import { SERVICE_FIELDS, type CredentialService } from './credentialCrypto'
import { contentTarget, hotFeed, rssFeed, readArticle, summarizeArticle } from './feeds'
import { HOT_REQUESTS } from './hotSources'
import { siteSearch, webSearch } from './searchService'

const app = new Hono<AppEnv>().basePath('/v1')

const DOC_RE = /^[a-z0-9_-]{1,32}$/
const BLOB_RE = /^[A-Za-z0-9._:-]{1,200}$/

/* ---------------- base64 ---------------- */

function toB64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ---------------- 中间件 ---------------- */

app.use('*', async (c, next) => {
  const t0 = Date.now()
  await next()
  c.env.ANALYTICS?.writeDataPoint({
    blobs: [c.req.routePath, c.req.method, String(c.res.status)],
    doubles: [Date.now() - t0],
    indexes: [c.req.routePath.slice(0, 32)],
  })
})
app.use('*', httpsOnly)
app.use('*', cors)

/** 公开 GET 接口的边缘缓存（Cache API） */
async function edge(c: Context<AppEnv>, make: () => Promise<Response>) {
  const cache = typeof caches === 'undefined' ? undefined : caches.default
  const key = new Request(c.req.raw.url, { method: 'GET' })
  const hit = await cache?.match(key)
  if (hit) return new Response(hit.body, hit)
  const res = await make()
  if (cache && (res.status === 200 || res.status === 404) && res.headers.has('Cache-Control')) {
    c.executionCtx.waitUntil(cache.put(key, res.clone()))
  }
  return res
}

/* ---------------- 公开接口 ---------------- */

app.get('/health', (c) =>
  c.json({ ok: true, name: 'myriad-api', version: VERSION, features: features(c.env) }),
)

app.get('/geo', (c) => c.json(geoOf(c.req.raw), 200, { 'Cache-Control': 'private, no-store' }))

function searchQuery(query: Record<string, string>) {
  const q = (query.q || '').trim(),
    page = Number(query.page || 0),
    engine = query.engine || ''
  if (!q || q.length > 300 || !Number.isInteger(page) || page < 0 || page > 49) return null
  return { q, page, engine, lang: query.lang === 'en' ? 'en' : 'zh-CN' }
}
app.get('/hot', rateLimit, async (c) => {
  const source = c.req.query('source') || '',
    period = Number(c.req.query('period') ?? Math.floor(Date.now() / 86400000) * 86400000)
  if (
    !Object.hasOwn(HOT_REQUESTS, source) ||
    !Number.isFinite(period) ||
    period > Date.now() + 60000 ||
    period < Date.now() - 2 * 86400000
  )
    return c.json({ error: 'bad-query' }, 400)
  try {
    return c.json(
      await hotFeed(
        c.env,
        source,
        period,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(12000)]),
      ),
      200,
      { 'Cache-Control': 'public, max-age=60' },
    )
  } catch {
    return c.json({ error: 'source-unavailable' }, 502)
  }
})
app.get('/rss', rateLimit, async (c) => {
  const url = c.req.query('url') || '',
    period = Number(c.req.query('period') ?? Math.floor(Date.now() / 86400000) * 86400000)
  if (
    !contentTarget(url) ||
    !Number.isFinite(period) ||
    period > Date.now() + 60000 ||
    period < Date.now() - 2 * 86400000
  )
    return c.json({ error: 'bad-query' }, 400)
  try {
    return c.json(
      await rssFeed(
        c.env,
        url,
        period,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(12000)]),
      ),
      200,
      { 'Cache-Control': 'public, max-age=60' },
    )
  } catch {
    return c.json({ error: 'feed-unavailable' }, 502)
  }
})
app.get('/reader', rateLimit, async (c) => {
  const url = c.req.query('url') || ''
  if (!contentTarget(url)) return c.json({ error: 'bad-url' }, 400)
  try {
    return c.json(
      await readArticle(
        c.env,
        url,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(12000)]),
      ),
      200,
      { 'Cache-Control': 'public, max-age=3600' },
    )
  } catch {
    return c.json({ error: 'reader-unavailable' }, 502)
  }
})
app.get('/search', rateLimit, async (c) => {
  const query = searchQuery(c.req.query())
  if (
    !query ||
    !['github', 'npm', 'mdn', 'wikipedia', 'mcwiki', 'stackoverflow', 'hackernews'].includes(
      query.engine,
    )
  )
    return c.json({ error: 'bad-query' }, 400)
  try {
    return c.json(
      await siteSearch(
        query.engine,
        query.q,
        query.page,
        query.lang,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]),
      ),
      200,
      { 'Cache-Control': 'public, max-age=60' },
    )
  } catch {
    return c.json({ error: 'search-unavailable' }, 502)
  }
})

app.get('/weather/cities', rateLimit, (c) => {
  const name = (c.req.query('name') ?? '').trim()
  if (name.length < 2 || name.length > 80) return c.json({ error: 'bad-city' }, 400)
  return edge(c, async () => {
    try {
      return c.json(
        await cities(c.env, name, c.req.query('language') === 'zh' ? 'zh' : 'en'),
        200,
        { 'Cache-Control': 'public, max-age=86400' },
      )
    } catch {
      return c.json({ error: 'upstream' }, 502)
    }
  })
})

app.get('/weather', rateLimit, (c) => {
  const coords = coordinates(c.req.query('latitude'), c.req.query('longitude'))
  if (!coords) return c.json({ error: 'bad-coordinates' }, 400)
  return edge(c, async () => {
    try {
      return c.json(
        await weather(c.env, coords.latitude, coords.longitude, c.req.query('air') !== '0'),
        200,
        { 'Cache-Control': 'public, max-age=1800' },
      )
    } catch {
      return c.json({ error: 'upstream' }, 502)
    }
  })
})

app.get('/quote', rateLimit, (c) => {
  const day = c.req.query('day') ?? new Date().toISOString().slice(0, 10)
  const requested = c.req.queries('c') ?? []
  const categories = [...new Set(requested)].sort().join('')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || requested.some((c) => !/^[a-l]$/.test(c)))
    return c.json({ error: 'bad-query' }, 400)
  return edge(c, async () => {
    try {
      return c.json(await dailyQuote(c.env, day, categories), 200, {
        'Cache-Control': 'public, max-age=3600',
      })
    } catch {
      return c.json({ error: 'upstream' }, 502)
    }
  })
})

app.get('/icon', rateLimit, (c) => {
  const target = iconTarget(c.req.query('url') ?? c.req.query('domain') ?? null)
  if (!target) return c.json({ error: 'bad-url' }, 400)
  const size = Math.min(512, Math.max(16, Number(c.req.query('size')) || 128))
  return edge(c, () => handleIcon(c.env, target, size))
})

app.get('/holidays/:year{[0-9]{4}}', rateLimit, (c) => {
  const year = Number(c.req.param('year'))
  return edge(c, async () => {
    try {
      const body = await holidays(c.env, year)
      return c.json(body, 200, { 'Cache-Control': 'public, max-age=21600' })
    } catch {
      return c.json({ error: 'upstream' }, 502)
    }
  })
})

/* ---------------- 汇率与 Minecraft ---------------- */

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

app.get('/currency/history', rateLimit, (c) => {
  const base = currencyCode(c.req.query('base') ?? 'CNY'),
    quote = currencyCode(c.req.query('quote') ?? 'USD')
  const from = c.req.query('from') ?? '',
    to = c.req.query('to') ?? ''
  const span = (Date.parse(to) - Date.parse(from)) / 86400000
  if (!base || !quote || !validDate(from) || !validDate(to) || span < 0 || span > 31)
    return c.json({ error: 'bad-query' }, 400)
  return edge(c, async () => {
    try {
      return c.json(await currencyHistory(c.env, base, quote, from, to), 200, {
        'Cache-Control': 'public, max-age=43200',
      })
    } catch {
      return c.json({ error: 'history-unavailable' }, 502)
    }
  })
})
app.get('/currency', rateLimit, (c) => {
  const base = currencyCode(c.req.query('base') ?? 'CNY'),
    quote = currencyCode(c.req.query('quote') ?? 'USD')
  const date = c.req.query('date') ?? 'latest'
  if (!base || !quote || (date !== 'latest' && !validDate(date)))
    return c.json({ error: 'bad-query' }, 400)
  return edge(c, async () => {
    try {
      return c.json(await currencyRate(c.env, base, quote, date), 200, {
        'Cache-Control': 'public, max-age=43200',
      })
    } catch {
      return c.json({ error: 'currency-unavailable' }, 502)
    }
  })
})
app.get('/minecraft', rateLimit, (c) => {
  const kind = c.req.query('kind') ?? 'java'
  const target = minecraftAddress(c.req.query('address') ?? '', kind === 'bedrock' ? 19132 : 25565)
  if (!target || (kind !== 'java' && kind !== 'bedrock'))
    return c.json({ error: 'bad-server' }, 400)
  return edge(c, async () => {
    try {
      return c.json(await minecraft(c.env, target, kind), 200, {
        'Cache-Control': 'public, max-age=60',
      })
    } catch (e) {
      console.warn('Minecraft query failed:', e instanceof Error ? e.message : 'unknown')
      return c.json({ error: 'server-unavailable' }, 502)
    }
  })
})

/* ---------------- 私有接口 ---------------- */
app.get('/github', rateLimit, async (c) => {
  const query = githubQuery(c.req.query())
  if (!query) return c.json({ error: 'bad-query' }, 400)
  if (['tasks', 'notifications'].includes(query.section))
    return c.json({ error: 'auth-required' }, 401)
  return edge(c, async () => {
    try {
      return c.json(await github(c.env, query, false, c.req.raw.signal), 200, {
        'Cache-Control': 'public, max-age=300',
      })
    } catch (e) {
      return c.json(
        {
          error:
            e instanceof GithubError && (e.status === 429 || e.status === 403)
              ? 'github-quota'
              : 'github-unavailable',
        },
        502,
      )
    }
  })
})
const me = new Hono<AppEnv>()
me.use('*', requireAuth)
me.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  await next()
})

me.get('/', async (c) =>
  c.json({
    identity: c.get('identity'),
    version: VERSION,
    features: await credentialFeatures(c.env),
  }),
)
me.get('/credentials', async (c) => c.json((await readCredentials(c.env)).status))
me.put(
  '/credentials/:service',
  rateLimit,
  bodyLimit({ maxSize: 40000, onError: (c) => c.json({ error: 'too-large' }, 413) }),
  async (c) => {
    if (!credentialEnabled(c.env)) return c.json({ error: 'credentials-disabled' }, 501)
    const service = c.req.param('service') as CredentialService
    if (!Object.hasOwn(SERVICE_FIELDS, service)) return c.json({ error: 'bad-service' }, 400)
    // Application encryption is tied to the personal token, including for Access deployments.
    if (!c.req.header('Authorization')?.startsWith('Bearer '))
      return c.json({ error: 'token-required' }, 403)
    try {
      return c.json(
        await saveCredential(c.env, service, await c.req.json(), new URL(c.req.url).origin),
      )
    } catch (e) {
      return e instanceof CredentialConflict
        ? c.json({ error: 'credentials-conflict' }, 409)
        : c.json({ error: 'bad-credentials' }, 400)
    }
  },
)

me.get('/weather', rateLimit, async (c) => {
  c.header('Cache-Control', 'private, no-store')
  const coords = coordinates(c.req.query('latitude'), c.req.query('longitude'))
  const provider = c.req.query('provider') ?? 'auto'
  if (!coords || !['auto', 'qweather', 'open-meteo'].includes(provider))
    return c.json({ error: 'bad-query' }, 400)
  try {
    return c.json(
      await personalWeather(
        await credentialEnv(c.env),
        coords.latitude,
        coords.longitude,
        c.req.query('air') !== '0',
        c.req.query('warnings') !== '0',
        c.req.query('lang') === 'en' ? 'en' : 'zh',
        provider,
        c.req.raw.signal,
      ),
    )
  } catch {
    return c.json({ error: 'weather-unavailable' }, 502)
  }
})

me.get('/search', rateLimit, async (c) => {
  c.header('Cache-Control', 'private, no-store')
  const query = searchQuery(c.req.query())
  if (!query || !['google', 'bing', 'baidu', 'duckduckgo'].includes(query.engine))
    return c.json({ error: 'bad-query' }, 400)
  try {
    return c.json(
      await webSearch(
        await credentialEnv(c.env),
        query.engine,
        query.q,
        query.page,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]),
      ),
    )
  } catch (e) {
    const message =
      e instanceof Error && ['search-disabled', 'search-quota'].includes(e.message)
        ? e.message
        : 'search-unavailable'
    return c.json({ error: message }, message === 'search-disabled' ? 501 : 502)
  }
})
me.post(
  '/summary',
  rateLimit,
  bodyLimit({ maxSize: 6000, onError: (c) => c.json({ error: 'too-large' }, 413) }),
  async (c) => {
    c.header('Cache-Control', 'private, no-store')
    let body: { url?: string; lang?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'bad-json' }, 400)
    }
    if (typeof body?.url !== 'string' || !contentTarget(body.url))
      return c.json({ error: 'bad-url' }, 400)
    if (!c.env.AI) return c.json({ error: 'summary-disabled' }, 501)
    try {
      return c.json(
        await summarizeArticle(
          c.env,
          body.url,
          body.lang === 'en' ? 'en' : 'zh-CN',
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(25000)]),
        ),
      )
    } catch {
      return c.json({ error: 'summary-unavailable' }, 502)
    }
  },
)

me.get('/github', rateLimit, async (c) => {
  c.header('Cache-Control', 'private, no-store')
  const query = githubQuery(c.req.query())
  if (!query) return c.json({ error: 'bad-query' }, 400)
  try {
    return c.json(await github(await credentialEnv(c.env), query, true, c.req.raw.signal))
  } catch (e) {
    if (e instanceof GithubError && e.status === 501)
      return c.json({ error: 'github-disabled' }, 501)
    return c.json(
      {
        error:
          e instanceof GithubError && (e.status === 403 || e.status === 429)
            ? 'github-quota-or-scope'
            : 'github-unavailable',
      },
      502,
    )
  }
})

me.post(
  '/translate',
  rateLimit,
  bodyLimit({ maxSize: 24000, onError: (c) => c.json({ error: 'too-large' }, 413) }),
  async (c) => {
    c.header('Cache-Control', 'private, no-store')
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'bad-json' }, 400)
    }
    const input = translationInput(raw)
    if (!input) return c.json({ error: 'bad-translation' }, 400)
    const effective = await credentialEnv(c.env)
    if (!translators(effective).includes(input.provider))
      return c.json({ error: 'translation-disabled' }, 501)
    try {
      return c.json(await translate(effective, input, c.req.raw.signal))
    } catch {
      // Do not log source text, upstream responses or credentials.
      return c.json({ error: 'translation-unavailable' }, 502)
    }
  },
)

/* 同步 */
me.post('/sync', async (c) => {
  if (!c.env.DB) return c.json({ error: 'sync-disabled' }, 501)
  let body: { doc?: unknown; after?: unknown; update?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad-json' }, 400)
  }
  const doc = typeof body.doc === 'string' ? body.doc : 'main'
  if (!DOC_RE.test(doc)) return c.json({ error: 'bad-doc' }, 400)
  const after = typeof body.after === 'number' && Number.isFinite(body.after) ? body.after : -1
  let update: Uint8Array | null = null
  if (typeof body.update === 'string' && body.update) {
    try {
      update = fromB64(body.update)
    } catch {
      return c.json({ error: 'bad-update' }, 400)
    }
    if (update.length > MAX_UPDATE_BYTES) return c.json({ error: 'too-large' }, 413)
  }
  const r = await exchange(c.env, doc, after, update)
  if (update) c.executionCtx.waitUntil(maybeCompact(c.env, doc).catch(() => false))
  return c.json({ seq: r.seq, update: r.update ? toB64(r.update) : null, full: r.full }, 200, {
    'Cache-Control': 'no-store',
  })
})

/* 备份 */
function backupsEnabled(env: Env) {
  return !!env.DB
}

me.get('/backups', async (c) => {
  if (!backupsEnabled(c.env)) return c.json({ error: 'backups-disabled' }, 501)
  const [list, config] = await Promise.all([listBackups(c.env, 'main'), backupConfig(c.env)])
  return c.json({ backups: list, config }, 200, { 'Cache-Control': 'no-store' })
})

me.post('/backups', async (c) => {
  if (!backupsEnabled(c.env)) return c.json({ error: 'backups-disabled' }, 501)
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
  const reason = (BACKUP_REASONS as string[]).includes(body.reason ?? '')
    ? (body.reason as BackupReason)
    : 'manual'
  const info = await createBackup(c.env, 'main', reason === 'daily' ? 'manual' : reason)
  return c.json({ backup: info })
})

me.get('/backups/:id', async (c) => {
  if (!backupsEnabled(c.env)) return c.json({ error: 'backups-disabled' }, 501)
  const id = c.req.param('id')
  if (!isBackupId(id)) return c.json({ error: 'bad-id' }, 400)
  const obj = await getBackup(c.env, 'main', id)
  if (!obj) return c.json({ error: 'not-found' }, 404)
  return c.body(obj.body, 200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400, immutable',
  })
})

me.delete('/backups/:id', async (c) => {
  if (!backupsEnabled(c.env)) return c.json({ error: 'backups-disabled' }, 501)
  const id = c.req.param('id')
  if (!isBackupId(id)) return c.json({ error: 'bad-id' }, 400)
  await deleteBackup(c.env, 'main', id)
  return c.json({ ok: true })
})

me.put('/backups/config', async (c) => {
  if (!backupsEnabled(c.env)) return c.json({ error: 'backups-disabled' }, 501)
  const body = (await c.req.json().catch(() => ({}))) as Partial<BackupConfig>
  const current = await backupConfig(c.env)
  const next: BackupConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    keep: Math.min(30, Math.max(1, Math.round(Number(body.keep ?? current.keep)) || 2)),
  }
  await setConfig(c.env, 'backup', next)
  await prune(c.env, 'main')
  return c.json({ config: next })
})

/* 用户文件（上传的壁纸等） */
me.put('/blobs/:key', async (c) => {
  if (!features(c.env).blobs) return c.json({ error: 'blobs-disabled' }, 501)
  const key = c.req.param('key')
  if (!BLOB_RE.test(key)) return c.json({ error: 'bad-key' }, 400)
  const len = Number(c.req.header('Content-Length') || 0)
  if (!Number.isSafeInteger(len) || len < 0) return c.json({ error: 'bad-length' }, 400)
  if (!len || !c.req.raw.body) return c.json({ error: 'length-required' }, 411)
  const limit = features(c.env).blobMaxBytes
  if (len > limit) return c.json({ error: 'too-large', maxBytes: limit }, 413)
  const bytes = await readObjectBody(c.req.raw.body, limit)
  if (bytes.length !== len) return c.json({ error: 'bad-length' }, 400)
  await putObject(c.env, `blobs/${key}`, bytes, {
    contentType: c.req.header('Content-Type') ?? 'application/octet-stream',
  })
  return c.json({ ok: true })
})

me.get('/blobs/:key', async (c) => {
  if (!features(c.env).blobs) return c.json({ error: 'blobs-disabled' }, 501)
  const key = c.req.param('key')
  if (!BLOB_RE.test(key)) return c.json({ error: 'bad-key' }, 400)
  const obj = await getObject(c.env, `blobs/${key}`)
  if (!obj) return c.json({ error: 'not-found' }, 404)
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
})

me.delete('/blobs/:key', async (c) => {
  if (!features(c.env).blobs) return c.json({ error: 'blobs-disabled' }, 501)
  const key = c.req.param('key')
  if (!BLOB_RE.test(key)) return c.json({ error: 'bad-key' }, 400)
  await deleteObject(c.env, `blobs/${key}`)
  return c.json({ ok: true })
})

/* 每日壁纸（需要 Key，只给登录用户） */
me.get('/wallpaper/unsplash', async (c) => {
  const effective = await credentialEnv(c.env)
  if (!effective.UNSPLASH_ACCESS_KEY) return c.json({ error: 'unsplash-disabled' }, 501)
  try {
    const w = await unsplashDaily(effective, c.req.query('query') ?? '', (p) =>
      c.executionCtx.waitUntil(p),
    )
    return c.json(w, 200, { 'Cache-Control': 'private, no-store' })
  } catch {
    return c.json({ error: 'upstream' }, 502)
  }
})

app.route('/me', me)

app.notFound((c) => c.json({ error: 'not-found' }, 404))
app.onError((err, c) => {
  if (err instanceof ObjectTooLargeError)
    return c.json({ error: 'too-large', maxBytes: features(c.env).blobMaxBytes }, 413)
  console.error(err)
  return c.json({ error: 'internal' }, 500)
})

/* ---------------- 定时任务 ---------------- */

export async function scheduled(env: Env) {
  const tasks: Promise<unknown>[] = [refreshHolidays(env)]
  if (env.DB) {
    tasks.push(
      (async () => {
        await maybeCompact(env, 'main', true)
        if ((await backupConfig(env)).enabled) await createBackup(env, 'main', 'daily')
      })(),
    )
  }
  await Promise.allSettled(tasks)
}

export { app }

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    // 根路径给出简单说明，其余交给 /v1
    if (new URL(req.url).pathname === '/') {
      return Response.json({ name: 'myriad-api', version: VERSION, docs: '/v1/health' })
    }
    return app.fetch(req, env, ctx)
  },
  scheduled: (_c: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(scheduled(env))
  },
} satisfies ExportedHandler<Env>
