import type { MiddlewareHandler } from 'hono'
import { type AppEnv, type Env, list } from './env'

/**
 * 跨域。浏览器扩展凭主机权限访问，不受 CORS 限制；这里只处理网页来源：
 * `ALLOWED_ORIGINS` 列出的来源可以带凭据访问全部接口；其他来源只能读公开接口。
 * 本地开发（DEV_AUTH_BYPASS）时额外放行 localhost 的任意端口。
 */
function allowedOrigin(origin: string, env: Env): boolean {
  if (list(env.ALLOWED_ORIGINS).includes(origin)) return true
  if (env.DEV_AUTH_BYPASS === 'true') {
    try {
      const h = new URL(origin).hostname
      return h === 'localhost' || h === '127.0.0.1'
    } catch {
      return false
    }
  }
  return false
}

export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin')
  const isPrivate = c.req.path.startsWith('/v1/me')
  const trusted = !!origin && allowedOrigin(origin, c.env)
  const headers: Record<string, string> = {}
  if (origin && trusted) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Credentials'] = 'true'
    headers['Vary'] = 'Origin'
  } else if (!isPrivate) {
    headers['Access-Control-Allow-Origin'] = '*'
  }

  if (c.req.method === 'OPTIONS') {
    if (!headers['Access-Control-Allow-Origin']) return c.body(null, 403)
    return c.body(null, 204, {
      ...headers,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        c.req.header('Access-Control-Request-Headers') ??
        'Content-Type, CF-Access-Client-Id, CF-Access-Client-Secret',
      'Access-Control-Max-Age': '86400',
    })
  }

  await next()
  for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v)
}

/** 拒绝明文 HTTP（本地开发除外），并开启 HSTS */
export const httpsOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol === 'http:' && !local) return c.json({ error: 'https-required' }, 403)
  await next()
  if (!local) c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
}

/** 公开接口按 IP 限流（未绑定 RATE_LIMIT 时不限） */
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.RATE_LIMIT
  if (limiter) {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const { success } = await limiter.limit({ key: ip })
    if (!success) return c.json({ error: 'rate-limited' }, 429)
  }
  await next()
}
