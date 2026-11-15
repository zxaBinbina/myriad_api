/** API credentials live outside the synced document and ordinary exports. */
export const SERVICE_FIELDS = {
  qweather: ['host', 'key', 'privateKey', 'kid', 'sub'],
  github: ['key'],
  unsplash: ['key'],
  deepl: ['key'],
  baidu: ['id', 'key'],
  youdao: ['id', 'key'],
  tencent: ['id', 'key', 'region'],
  microsoft: ['key', 'region'],
  openai: ['key', 'endpoint', 'model'],
  brave: ['key'],
  google: ['key', 'id'],
} as const
export type CredentialService = keyof typeof SERVICE_FIELDS
export type ServiceCredential = Record<string, string>
export interface CredentialStatus {
  configured: boolean
  fields: string[]
  version: string
  source: 'saved' | 'environment' | 'none'
  locked: boolean
}
export interface CredentialsStatus {
  enabled: boolean
  services: Record<CredentialService, CredentialStatus>
}
export interface CredentialChange {
  fields: ServiceCredential
  version: string
  remove?: boolean
}
export interface CredentialEnvelope {
  v: 1
  iv: string
  data: string
}
const encoder = new TextEncoder()
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

export async function credentialTokenHash(token: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
}
async function credentialKey(hash: string, context: string) {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('credentials-disabled')
  const root = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(hash.match(/../g)!, (n) => parseInt(n, 16)),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('myriad.credentials.v1'),
      info: encoder.encode(context),
    },
    root,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
/** Fresh 96-bit nonce and context-bound authenticated encryption on every write. */
export async function sealCredential(
  hash: string,
  context: string,
  value: unknown,
): Promise<CredentialEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await credentialKey(hash, context),
    encoder.encode(JSON.stringify(value)),
  )
  return { v: 1, iv: b64(iv), data: b64(new Uint8Array(data)) }
}
export async function openCredential(
  hash: string,
  context: string,
  envelope: CredentialEnvelope,
): Promise<unknown> {
  if (
    envelope?.v !== 1 ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.data !== 'string' ||
    envelope.data.length > 40000
  )
    throw new Error('bad-credentials')
  const iv = bytes(envelope.iv)
  if (iv.length !== 12) throw new Error('bad-credentials')
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await credentialKey(hash, context),
    bytes(envelope.data),
  )
  return JSON.parse(new TextDecoder().decode(data))
}
export const credentialContext = (purpose: 'transport' | 'storage', service: string, origin = '') =>
  `myriad.credentials.${purpose}.v1:${origin}:${service}`
