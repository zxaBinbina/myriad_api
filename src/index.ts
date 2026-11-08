import { type Context, Hono } from 'hono'
import { requireAuth } from './auth'
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
import { exchange, MAX_UPDATE_BYTES, maybeCompact, setConfig } from './sync'

const app = new Hono<AppEnv>().basePath('/v1')

const DOC_RE = /^[a-z0-9_-]{1,32}$/
const BLOB_RE = /^[A-Za-z0-9._:-]{1,200}$/
const MAX_BLOB = 50 * 1024 * 1024

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

/* ---------------- 私有接口 ---------------- */

const me = new Hono<AppEnv>()
me.use('*', requireAuth)

me.get('/', (c) =>
  c.json({ identity: c.get('identity'), version: VERSION, features: features(c.env) }),
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
  return !!(env.DB && env.BUCKET)
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
  if (!c.env.BUCKET) return c.json({ error: 'blobs-disabled' }, 501)
  const key = c.req.param('key')
  if (!BLOB_RE.test(key)) return c.json({ error: 'bad-key' }, 400)
  const len = Number(c.req.header('Content-Length') || 0)
  if (!len) return c.json({ error: 'length-required' }, 411)
  if (len > MAX_BLOB) return c.json({ error: 'too-large' }, 413)
  await c.env.BUCKET.put(`blobs/${key}`, c.req.raw.body!, {
    httpMetadata: { contentType: c.req.header('Content-Type') ?? 'application/octet-stream' },
  })
  return c.json({ ok: true })
})

me.get('/blobs/:key', async (c) => {
  if (!c.env.BUCKET) return c.json({ error: 'blobs-disabled' }, 501)
  const key = c.req.param('key')
  if (!BLOB_RE.test(key)) return c.json({ error: 'bad-key' }, 400)
  const obj = await c.env.BUCKET.get(`blobs/${key}`)
  if (!obj) return c.json({ error: 'not-found' }, 404)
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
})

me.delete('/blobs/:key', async (c) => {
  if (!c.env.BUCKET) return c.json({ error: 'blobs-disabled' }, 501)
  const key = c.req.param('key')
  if (!BLOB_RE.test(key)) return c.json({ error: 'bad-key' }, 400)
  await c.env.BUCKET.delete(`blobs/${key}`)
  return c.json({ ok: true })
})

/* 每日壁纸（需要 Key，只给登录用户） */
me.get('/wallpaper/unsplash', async (c) => {
  if (!c.env.UNSPLASH_ACCESS_KEY) return c.json({ error: 'unsplash-disabled' }, 501)
  try {
    const w = await unsplashDaily(c.env, c.req.query('query') ?? '', (p) =>
      c.executionCtx.waitUntil(p),
    )
    return c.json(w, 200, { 'Cache-Control': 'private, max-age=3600' })
  } catch {
    return c.json({ error: 'upstream' }, 502)
  }
})

app.route('/me', me)

app.notFound((c) => c.json({ error: 'not-found' }, 404))
app.onError((err, c) => {
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
        if (env.BUCKET && (await backupConfig(env)).enabled)
          await createBackup(env, 'main', 'daily')
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
