/** Worker 的绑定与变量。除字符串变量外全部可选，缺少时对应功能自动关闭。 */
export interface Env {
  /** Request-local decrypted credentials; never a deployment variable. */
  SERVICE_CREDENTIALS?: Partial<
    Record<
      import('./credentialCrypto').CredentialService,
      import('./credentialCrypto').ServiceCredential
    >
  >
  CREDENTIAL_REVISION?: string
  DB?: D1Database
  CACHE?: KVNamespace
  BUCKET?: R2Bucket
  RATE_LIMIT?: RateLimit
  ANALYTICS?: AnalyticsEngineDataset
  AI?: Ai
  DEEPL_API_KEY?: string
  MICROSOFT_TRANSLATOR_KEY?: string
  MICROSOFT_TRANSLATOR_REGION?: string
  QWEATHER_HOST?: string
  QWEATHER_API_KEY?: string
  QWEATHER_PRIVATE_KEY?: string
  QWEATHER_KID?: string
  QWEATHER_SUB?: string
  GITHUB_TOKEN?: string
  BRAVE_SEARCH_KEY?: string
  GOOGLE_SEARCH_KEY?: string
  GOOGLE_SEARCH_ID?: string

  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  /** 独立连接令牌的 SHA-256 十六进制校验值（Worker Secret） */
  SYNC_TOKEN_SHA256?: string
  SYNC_IDENTITY?: string
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
  blobMaxBytes: number
  weather: boolean
  quote: boolean
  currency: boolean
  minecraft: boolean
  translation: boolean
  translators: Translator[]
  qweather: boolean
  github: boolean
  githubPrivate: boolean
  credentials: boolean
  credentialRevision: string
  feeds: boolean
  reader: boolean
  summary: boolean
  search: boolean
  searchWeb: string[]
}

export function hasPersonalToken(env: Env) {
  return /^[a-f0-9]{64}$/i.test(env.SYNC_TOKEN_SHA256 ?? '')
}

export function features(env: Env): Features {
  return {
    feeds: true,
    reader: true,
    summary: !!env.AI,
    search: true,
    searchWeb: webProviders(env),
    credentials: !!env.DB && hasPersonalToken(env),
    credentialRevision: env.CREDENTIAL_REVISION ?? '',
    sync: !!env.DB,
    backups: !!env.DB,
    blobs: !!(env.BUCKET || env.DB),
    kv: !!env.CACHE,
    icons: true,
    auth: hasPersonalToken(env) || !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
    unsplash: !!env.UNSPLASH_ACCESS_KEY,
    weather: true,
    quote: true,
    currency: true,
    minecraft: true,
    translation: translators(env).length > 0,
    translators: translators(env),
    qweather: qweatherEnabled(env),
    github: true,
    githubPrivate: !!env.GITHUB_TOKEN,
    blobMaxBytes: env.BUCKET ? 50 * 1024 * 1024 : 10 * 1024 * 1024,
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
import { translators, type Translator } from './translation'
import { qweatherEnabled } from './qweather'
import { webProviders } from './searchService'
