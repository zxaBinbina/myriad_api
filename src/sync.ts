import { mergeUpdates } from 'yjs'
import type { Env } from './env'

/**
 * Yjs 同步存储。
 *
 * - 客户端推送的增量更新按顺序追加到 `sync_updates`，自增 id 就是同步序号（seq）。
 * - 客户端记住自己收到的最大序号，下次带上 `after`，服务端只返回之后的更新。
 * - 更新条数超过阈值时，用 `Y.mergeUpdates` 压缩进 `sync_docs.state` 快照，并删除已合并的行。
 *   压缩用 `upto` 做乐观锁，并发压缩不会丢更新。
 *
 * 全程不实例化 Y.Doc，只做二进制合并，CPU 开销很小（免费套餐每次请求只有 10ms CPU）。
 */

/** D1 单个 BLOB 上限约 2MB，留出余量 */
export const MAX_UPDATE_BYTES = 1_900_000
const COMPACT_THRESHOLD = 48

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sync_docs (id TEXT PRIMARY KEY, state BLOB, state_r2 TEXT, upto INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sync_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sync_updates_doc ON sync_updates (doc, id)`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
]

const ready = new WeakSet<D1Database>()

export async function ensureSchema(db: D1Database) {
  if (ready.has(db)) return
  await db.batch(SCHEMA.map((s) => db.prepare(s)))
  ready.add(db)
}

interface SnapshotRow {
  state: ArrayBuffer | null
  state_r2: string | null
  upto: number
}

interface UpdateRow {
  id: number
  data: ArrayBuffer
}

const bytes = (b: ArrayBuffer | Uint8Array | number[]) =>
  b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer)

async function snapshotBytes(env: Env, row: SnapshotRow | null): Promise<Uint8Array | null> {
  if (!row) return null
  if (row.state) return bytes(row.state)
  if (row.state_r2 && env.BUCKET) {
    const obj = await env.BUCKET.get(row.state_r2)
    if (obj) return new Uint8Array(await obj.arrayBuffer())
  }
  return null
}

function merge(parts: Uint8Array[]): Uint8Array | null {
  if (!parts.length) return null
  if (parts.length === 1) return parts[0]!
  return mergeUpdates(parts)
}

export interface ExchangeResult {
  /** 服务端当前最大序号，客户端下次以此作为 after */
  seq: number
  /** 客户端尚未收到的更新（已合并成一条），没有时为 null */
  update: Uint8Array | null
  /** 客户端的 after 早于快照，本次返回的是完整状态 */
  full: boolean
}

/**
 * 一次同步往返：先保存客户端的更新（如有），再返回 after 之后其他来源的更新。
 * 刚保存的那条不会返回给客户端自己。
 */
export async function exchange(
  env: Env,
  doc: string,
  after: number,
  update: Uint8Array | null,
): Promise<ExchangeResult> {
  const db = env.DB!
  await ensureSchema(db)
  let mine = 0
  // Yjs 的空更新只有 2 字节（0 个结构 + 空删除集），不入库
  if (update && update.length > 2) {
    const r = await db
      .prepare('INSERT INTO sync_updates (doc, data, size, created_at) VALUES (?, ?, ?, ?)')
      .bind(doc, update, update.length, Date.now())
      .run()
    mine = Number(r.meta.last_row_id)
  }
  return read(env, doc, after, mine)
}

async function read(env: Env, doc: string, after: number, mine: number): Promise<ExchangeResult> {
  const db = env.DB!
  // 快照与增量在同一事务（batch）中读取，避免读到一半时被压缩
  const [snapRes, maxRes, rowsRes] = await db.batch([
    db.prepare('SELECT state, state_r2, upto FROM sync_docs WHERE id = ?').bind(doc),
    db.prepare('SELECT MAX(id) AS m FROM sync_updates WHERE doc = ?').bind(doc),
    db
      .prepare('SELECT id, data FROM sync_updates WHERE doc = ? AND id > ? ORDER BY id')
      .bind(doc, after),
  ])
  const snap = (snapRes!.results[0] as SnapshotRow | undefined) ?? null
  const rows = rowsRes!.results as unknown as UpdateRow[]
  const upto = snap?.upto ?? 0
  const seq = Math.max(upto, (maxRes!.results[0] as { m: number | null } | undefined)?.m ?? 0)
  // 客户端记住的序号比服务端还新：服务端数据被清空或换了服务器，返回完整状态
  if (after > seq) return read(env, doc, -1, mine)
  const full = after < upto || after < 0
  const parts: Uint8Array[] = []
  if (full) {
    const s = await snapshotBytes(env, snap)
    if (s) parts.push(s)
  }
  for (const row of rows) if (row.id !== mine) parts.push(bytes(row.data))
  return { seq, update: merge(parts), full }
}

/** 读取完整状态（快照 + 全部增量），用于备份 */
export async function fullState(
  env: Env,
  doc: string,
): Promise<{ seq: number; state: Uint8Array | null }> {
  const r = await exchange(env, doc, -1, null)
  return { seq: r.seq, state: r.update }
}

/** 增量条数超过阈值时压缩进快照 */
export async function maybeCompact(env: Env, doc: string, force = false): Promise<boolean> {
  const db = env.DB!
  await ensureSchema(db)
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM sync_updates WHERE doc = ?')
    .bind(doc)
    .first<{ n: number }>()
  if (!count || (!force && count.n < COMPACT_THRESHOLD) || count.n === 0) return false

  const [snapRes, rowsRes] = await db.batch([
    db.prepare('SELECT state, state_r2, upto FROM sync_docs WHERE id = ?').bind(doc),
    db.prepare('SELECT id, data FROM sync_updates WHERE doc = ? ORDER BY id').bind(doc),
  ])
  const snap = (snapRes!.results[0] as SnapshotRow | undefined) ?? null
  const rows = rowsRes!.results as unknown as UpdateRow[]
  if (!rows.length) return false
  const oldUpto = snap?.upto ?? 0
  const base = await snapshotBytes(env, snap)
  const merged = merge([...(base ? [base] : []), ...rows.map((r) => bytes(r.data))])!
  const newUpto = rows[rows.length - 1]!.id

  let state: Uint8Array | null = merged
  let stateR2: string | null = null
  if (merged.length > MAX_UPDATE_BYTES) {
    // 快照超出 D1 上限时放进 R2；没有 R2 就先不压缩
    if (!env.BUCKET) return false
    stateR2 = `sync/${doc}/snapshot-${newUpto}.bin`
    await env.BUCKET.put(stateR2, merged)
    state = null
  }
  const [upsert] = await db.batch([
    db
      .prepare(
        `INSERT INTO sync_docs (id, state, state_r2, upto, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, state_r2 = excluded.state_r2,
           upto = excluded.upto, updated_at = excluded.updated_at
         WHERE sync_docs.upto = ?6`,
      )
      .bind(doc, state, stateR2, newUpto, Date.now(), oldUpto),
    db
      .prepare(
        'DELETE FROM sync_updates WHERE doc = ?1 AND id <= (SELECT upto FROM sync_docs WHERE id = ?1)',
      )
      .bind(doc),
  ])
  const ok = (upsert!.meta.changes ?? 0) > 0
  if (env.BUCKET) {
    // 清理被替换的旧快照（或本次没写成功的新快照）
    if (ok && snap?.state_r2) await env.BUCKET.delete(snap.state_r2)
    if (!ok && stateR2) await env.BUCKET.delete(stateR2)
  }
  return ok
}

/* ------------------------------------------------------------------ */
/* 杂项设置                                                            */
/* ------------------------------------------------------------------ */

export async function getConfig<T>(env: Env, key: string, fallback: T): Promise<T> {
  if (!env.DB) return fallback
  await ensureSchema(env.DB)
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  if (!row) return fallback
  try {
    return { ...fallback, ...(JSON.parse(row.value) as T) }
  } catch {
    return fallback
  }
}

export async function setConfig(env: Env, key: string, value: unknown) {
  await ensureSchema(env.DB!)
  await env
    .DB!.prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, JSON.stringify(value))
    .run()
}
