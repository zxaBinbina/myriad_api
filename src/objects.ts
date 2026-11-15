import type { Env } from './env'
import { ensureSchema } from './sync'

/** D1 每个 BLOB 小于 2MB；一次 10MiB 写入不超过免费套餐的查询数限制。 */
export const OBJECT_CHUNK_BYTES = 1_000_000
export const MAX_D1_OBJECT_BYTES = 10 * 1024 * 1024

export class ObjectTooLargeError extends Error {}

interface ObjectRow {
  key: string
  size: number
  uploaded_at: number
  content_type: string
  metadata: string
}

export interface ObjectInfo {
  key: string
  size: number
  uploaded: Date
  httpMetadata: { contentType: string }
  customMetadata: Record<string, string>
}

export interface StoredObject extends ObjectInfo {
  body: ReadableStream<Uint8Array>
  arrayBuffer(): Promise<ArrayBuffer>
}

function info(row: ObjectRow): ObjectInfo {
  return {
    key: row.key,
    size: row.size,
    uploaded: new Date(row.uploaded_at),
    httpMetadata: { contentType: row.content_type },
    customMetadata: JSON.parse(row.metadata) as Record<string, string>,
  }
}

/** R2 优先；读、列出和删除也覆盖 D1，以便以后启用 R2 时保留旧数据。 */
export async function getObject(env: Env, key: string): Promise<StoredObject | null> {
  const remote = await env.BUCKET?.get(key)
  if (remote) return remote as StoredObject
  if (!env.DB) return null
  await ensureSchema(env.DB)
  const [meta, chunks] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM stored_objects WHERE key = ?').bind(key),
    env.DB.prepare('SELECT data FROM object_chunks WHERE key = ? ORDER BY part').bind(key),
  ])
  const row = meta!.results[0] as ObjectRow | undefined
  if (!row) return null
  const parts = (chunks!.results as { data: ArrayBuffer }[]).map((r) => new Uint8Array(r.data))
  if (parts.reduce((size, p) => size + p.length, 0) !== row.size)
    throw new Error('Stored object is incomplete')
  return {
    ...info(row),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
    async arrayBuffer() {
      const bytes = new Uint8Array(row.size)
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.length
      }
      return bytes.buffer
    },
  }
}

export async function putObject(
  env: Env,
  key: string,
  bytes: Uint8Array,
  options: { contentType?: string; metadata?: Record<string, string> } = {},
) {
  if (env.BUCKET) {
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: options.contentType ?? 'application/octet-stream' },
      customMetadata: options.metadata,
    })
    if (env.DB) {
      await ensureSchema(env.DB)
      await env.DB.prepare('DELETE FROM stored_objects WHERE key = ?').bind(key).run()
    }
    return
  }
  if (!env.DB) throw new Error('Object storage is disabled')
  if (bytes.length > MAX_D1_OBJECT_BYTES) throw new ObjectTooLargeError()
  await ensureSchema(env.DB)
  const statements = [
    env.DB.prepare(
      `INSERT INTO stored_objects (key, size, uploaded_at, content_type, metadata) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET size = excluded.size, uploaded_at = excluded.uploaded_at,
       content_type = excluded.content_type, metadata = excluded.metadata`,
    ).bind(
      key,
      bytes.length,
      Date.now(),
      options.contentType ?? 'application/octet-stream',
      JSON.stringify(options.metadata ?? {}),
    ),
    env.DB.prepare('DELETE FROM object_chunks WHERE key = ?').bind(key),
  ]
  for (let offset = 0, part = 0; offset < bytes.length; offset += OBJECT_CHUNK_BYTES, part++)
    statements.push(
      env.DB.prepare('INSERT INTO object_chunks (key, part, data) VALUES (?, ?, ?)').bind(
        key,
        part,
        bytes.slice(offset, offset + OBJECT_CHUNK_BYTES),
      ),
    )
  // 同一事务发布元数据和所有分块，失败或并发覆盖不会留下半个文件。
  await env.DB.batch(statements)
}

export async function listObjects(env: Env, prefix: string): Promise<ObjectInfo[]> {
  const objects = new Map<string, ObjectInfo>()
  if (env.DB) {
    await ensureSchema(env.DB)
    const rows = await env.DB.prepare('SELECT * FROM stored_objects WHERE substr(key, 1, ?) = ?')
      .bind(prefix.length, prefix)
      .all<ObjectRow>()
    for (const row of rows.results) objects.set(row.key, info(row))
  }
  if (env.BUCKET) {
    let cursor: string | undefined
    do {
      const page = await env.BUCKET.list({
        prefix,
        cursor,
        include: ['customMetadata', 'httpMetadata'],
      })
      for (const object of page.objects) objects.set(object.key, object as ObjectInfo)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  return [...objects.values()]
}

export async function deleteObject(env: Env, key: string) {
  if (env.DB) {
    await ensureSchema(env.DB)
    await env.DB.prepare('DELETE FROM stored_objects WHERE key = ?').bind(key).run()
  }
  await env.BUCKET?.delete(key)
}

/** 限制实际读取的字节数，不依赖客户端声明的 Content-Length。 */
export async function readObjectBody(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) {
        await reader.cancel()
        throw new ObjectTooLargeError()
      }
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
