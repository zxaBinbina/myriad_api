import type { MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import { type AppEnv, type Env, list } from './env'

/**
 * Cloudflare Access 鉴权。
 *
 * Access 在边缘完成 GitHub 登录 / Service Token 校验后，会在转发给 Worker 的请求上附加
 * `Cf-Access-Jwt-Assertion`。Worker 再用团队的公钥验证签名、签发方和 AUD，
 * 防止有人绕过 Access 直接访问 *.workers.dev 地址。
 */

const jwksCache = new Map<string, JWTVerifyGetKey>()

function teamOrigin(env: Env): string {
  const raw = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  return raw.startsWith('http') ? raw : `https://${raw}`
}

function jwksFor(team: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(team)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`))
    jwksCache.set(team, jwks)
  }
  return jwks
}

/** 测试用：为某个团队域名指定公钥集 */
export function setJwksForTesting(team: string, jwks: JWTVerifyGetKey) {
  jwksCache.set(team.replace(/\/+$/, ''), jwks)
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.get('Cf-Access-Jwt-Assertion')
  if (header) return header
  const cookie = req.headers.get('Cookie') ?? ''
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)
  return m ? decodeURIComponent(m[1]!) : null
}

export type AuthResult = { ok: true; identity: string } | { ok: false; status: 401 | 403 | 503 }

export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const host = new URL(req.url).hostname
  if (env.DEV_AUTH_BYPASS === 'true' && (host === 'localhost' || host === '127.0.0.1')) {
    return { ok: true, identity: 'dev@localhost' }
  }
  const team = teamOrigin(env)
  const aud = (env.ACCESS_AUD ?? '').trim()
  if (!team || !aud) return { ok: false, status: 503 }
  const token = tokenFrom(req)
  if (!token) return { ok: false, status: 401 }
  try {
    const { payload } = await jwtVerify(token, jwksFor(team), { issuer: team, audience: aud })
    const identity = String(payload.email ?? payload.common_name ?? payload.sub ?? '')
    if (!identity) return { ok: false, status: 403 }
    const allowed = list(env.ALLOWED_IDENTITIES)
    if (allowed.length && !allowed.includes(identity)) return { ok: false, status: 403 }
    return { ok: true, identity }
  } catch {
    return { ok: false, status: 401 }
  }
}

const AUTH_ERRORS = {
  401: 'unauthorized',
  403: 'forbidden',
  503: 'auth-not-configured',
} as const

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const r = await authenticate(c.req.raw, c.env)
  if (!r.ok) return c.json({ error: AUTH_ERRORS[r.status] }, r.status)
  c.set('identity', r.identity)
  await next()
}
