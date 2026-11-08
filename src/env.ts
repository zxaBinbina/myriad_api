/** Worker 的绑定与变量。除字符串变量外全部可选，缺少时对应功能自动关闭。 */
export interface Env {
  DB?: D1Database
  CACHE?: KVNamespace
  BUCKET?: R2Bucket
  RATE_LIMIT?: RateLimit
  ANALYTICS?: AnalyticsEngineDataset

  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  ALLOWED_IDENTITIES?: string
  ALLOWED_ORIGINS?: string
  /** 仅本地开发：为 `true` 且请求来自 localhost 时跳过 Access 校验（写在 .dev.vars） */
  DEV_AUTH_BYPASS?: string

  UNSPLASH_ACCESS_KEY?: string
}

export interface Features {
  sync: boolean
  backups: boolean
  blobs: boolean
  kv: boolean
  icons: boolean
  auth: boolean
  unsplash: boolean
}

export function features(env: Env): Features {
  return {
    sync: !!env.DB,
    backups: !!env.DB && !!env.BUCKET,
    blobs: !!env.BUCKET,
    kv: !!env.CACHE,
    icons: true,
    auth: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
    unsplash: !!env.UNSPLASH_ACCESS_KEY,
  }
}

export const VERSION = '0.1.0'

/** 当前请求的身份（Access JWT 中的邮箱或 Service Token 的 Client ID） */
export interface AppVariables {
  identity: string
}

export type AppEnv = { Bindings: Env; Variables: AppVariables }

export function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
