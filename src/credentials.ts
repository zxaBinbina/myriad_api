import {
  credentialContext,
  openCredential,
  sealCredential,
  SERVICE_FIELDS,
  type CredentialEnvelope,
  type CredentialService,
  type CredentialsStatus,
  type ServiceCredential,
} from './credentialCrypto'
import { features, hasPersonalToken, type Env } from './env'
import { ensureSchema } from './sync'
import { iconTarget } from './icons'

export const credentialEnabled = (env: Env) => !!env.DB && hasPersonalToken(env)
const services = Object.keys(SERVICE_FIELDS) as CredentialService[]
const ENV_FIELDS: Partial<Record<CredentialService, Record<string, keyof Env>>> = {
  qweather: {
    host: 'QWEATHER_HOST',
    key: 'QWEATHER_API_KEY',
    privateKey: 'QWEATHER_PRIVATE_KEY',
    kid: 'QWEATHER_KID',
    sub: 'QWEATHER_SUB',
  },
  github: { key: 'GITHUB_TOKEN' },
  brave: { key: 'BRAVE_SEARCH_KEY' },
  google: { key: 'GOOGLE_SEARCH_KEY', id: 'GOOGLE_SEARCH_ID' },
  unsplash: { key: 'UNSPLASH_ACCESS_KEY' },
  deepl: { key: 'DEEPL_API_KEY' },
  microsoft: { key: 'MICROSOFT_TRANSLATOR_KEY', region: 'MICROSOFT_TRANSLATOR_REGION' },
}
interface Row {
  service: CredentialService
  envelope: string
  version: string
}
const complete = (service: CredentialService, fields: ServiceCredential) => {
  if (service === 'qweather')
    return !!fields.host && !!(fields.key || (fields.privateKey && fields.kid && fields.sub))
  return (
    !!fields.key &&
    (!['baidu', 'youdao', 'tencent', 'google'].includes(service) || !!fields.id) &&
    (service !== 'openai' || !!(fields.endpoint && fields.model))
  )
}
export function validateCredential(service: CredentialService, fields: ServiceCredential) {
  if (!complete(service, fields)) throw new Error('incomplete-credentials')
  if (service === 'qweather' && !/^[a-z0-9-]+\.qweatherapi\.com$/i.test(fields.host!))
    throw new Error('bad-host')
  if (service === 'openai') {
    const url = iconTarget(fields.endpoint!)
    if (
      !url ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/chat/completions')
    )
      throw new Error('bad-endpoint')
  }
}
/** Only authenticated routes call this; no decrypted value is returned to the client. */
export async function readCredentials(env: Env) {
  const values: Partial<Record<CredentialService, ServiceCredential>> = {}
  const status: CredentialsStatus = {
    enabled: credentialEnabled(env),
    services: {} as CredentialsStatus['services'],
  }
  let rows: Row[] = []
  if (status.enabled) {
    await ensureSchema(env.DB!)
    rows = (
      await env.DB!.prepare('SELECT service, envelope, version FROM service_credentials').all<Row>()
    ).results
  }
  for (const service of services) {
    const fields: ServiceCredential = {}
    for (const [field, name] of Object.entries(ENV_FIELDS[service] ?? {})) {
      const value = env[name]
      if (typeof value === 'string' && value) fields[field] = value
    }
    const row = rows.find((r) => r.service === service)
    let locked = false
    if (row) {
      try {
        const saved = (await openCredential(
          env.SYNC_TOKEN_SHA256!,
          credentialContext('storage', service),
          JSON.parse(row.envelope),
        )) as ServiceCredential
        Object.assign(fields, saved)
      } catch {
        locked = true
      }
    }
    values[service] = fields
    status.services[service] = {
      configured: !locked && complete(service, fields),
      fields: locked ? [] : Object.keys(fields),
      version: row?.version ?? '',
      source: row ? 'saved' : Object.keys(fields).length ? 'environment' : 'none',
      locked,
    }
  }
  return { values, status }
}
export class CredentialConflict extends Error {}
export async function saveCredential(
  env: Env,
  service: CredentialService,
  envelope: CredentialEnvelope,
  origin: string,
) {
  const change = (await openCredential(
    env.SYNC_TOKEN_SHA256!,
    credentialContext('transport', service, origin),
    envelope,
  )) as any
  if (
    !change ||
    typeof change.version !== 'string' ||
    change.version.length > 80 ||
    !change.fields ||
    typeof change.fields !== 'object' ||
    Array.isArray(change.fields) ||
    (change.remove !== undefined && typeof change.remove !== 'boolean')
  )
    throw new Error('bad-credentials')
  const patch: ServiceCredential = {}
  for (const [field, value] of Object.entries(change.fields)) {
    if (
      !(SERVICE_FIELDS[service] as readonly string[]).includes(field) ||
      typeof value !== 'string' ||
      value.length > (field === 'privateKey' ? 16000 : 2000)
    )
      throw new Error('bad-credentials')
    if (value.trim()) patch[field] = value.trim()
  }
  await ensureSchema(env.DB!)
  const { values, status } = await readCredentials(env)
  if (status.services[service].version !== change.version) throw new CredentialConflict()
  let sql: D1PreparedStatement
  if (change.remove) {
    sql = env
      .DB!.prepare('DELETE FROM service_credentials WHERE service = ? AND version = ?')
      .bind(service, change.version)
    if (!change.version) return status
  } else {
    if (status.services[service].locked && !complete(service, patch))
      throw new Error('credentials-locked')
    const fields = { ...values[service], ...patch }
    if (
      service === 'openai' &&
      patch.endpoint &&
      values[service]?.endpoint &&
      patch.endpoint !== values[service]!.endpoint &&
      !patch.key
    )
      throw new Error('endpoint-needs-key')
    validateCredential(service, fields)
    const stored = await sealCredential(
      env.SYNC_TOKEN_SHA256!,
      credentialContext('storage', service),
      fields,
    )
    sql = env
      .DB!.prepare(
        "INSERT INTO service_credentials (service, envelope, version) SELECT ?, ?, ? WHERE ? = '' OR EXISTS (SELECT 1 FROM service_credentials WHERE service = ? AND version = ?) ON CONFLICT(service) DO UPDATE SET envelope = excluded.envelope, version = excluded.version WHERE service_credentials.version = ?",
      )
      .bind(
        service,
        JSON.stringify(stored),
        crypto.randomUUID(),
        change.version,
        service,
        change.version,
        change.version,
      )
  }
  if (!(await sql.run()).meta.changes) throw new CredentialConflict()
  return (await readCredentials(env)).status
}
export async function credentialEnv(env: Env) {
  const { values, status } = await readCredentials(env)
  const effective: Env = {
    ...env,
    SERVICE_CREDENTIALS: values,
    CREDENTIAL_REVISION: services.map((s) => status.services[s].version).join(':'),
  }
  for (const service of services) {
    if (status.services[service].locked) continue
    for (const [field, name] of Object.entries(ENV_FIELDS[service] ?? {})) {
      if (values[service]?.[field]) (effective as any)[name] = values[service]![field]
    }
  }
  return effective
}
export async function credentialFeatures(env: Env) {
  return features(await credentialEnv(env))
}
