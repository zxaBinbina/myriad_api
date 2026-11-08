import type { Env } from './env'
import { fullState, getConfig } from './sync'

/**
 * 备份：把同步文档的完整 Yjs 状态存进 R2。
 * - daily：Cron 每天一份，内容没变就跳过，保留最近 `keep` 份（默认 2）
 * - 其他原因（manual / import / rollback）：另外保留最近 5 份
 * 回滚在客户端完成：下载快照、还原成 JSON，再作为一次普通修改同步出去。
 */

export type BackupReason = 'daily' | 'manual' | 'import' | 'rollback'
export const BACKUP_REASONS: BackupReason[] = ['daily', 'manual', 'import', 'rollback']
const OTHER_KEEP = 5

export interface BackupConfig {
  enabled: boolean
  keep: number
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = { enabled: true, keep: 2 }

export interface BackupInfo {
  id: string
  at: number
  reason: BackupReason
  seq: number
  size: number
}

const prefix = (doc: string) => `backups/${doc}/`

export function backupConfig(env: Env) {
  return getConfig<BackupConfig>(env, 'backup', DEFAULT_BACKUP_CONFIG)
}

export async function listBackups(env: Env, doc: string): Promise<BackupInfo[]> {
  const out: BackupInfo[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET!.list({
      prefix: prefix(doc),
      cursor,
      include: ['customMetadata'],
    })
    for (const o of page.objects) {
      const meta = o.customMetadata ?? {}
      out.push({
        id: o.key.slice(prefix(doc).length).replace(/\.bin$/, ''),
        at: Number(meta.at) || o.uploaded.getTime(),
        reason: (BACKUP_REASONS as string[]).includes(meta.reason ?? '')
          ? (meta.reason as BackupReason)
          : 'manual',
        seq: Number(meta.seq) || 0,
        size: o.size,
      })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out.sort((a, b) => b.at - a.at)
}

export function isBackupId(id: string) {
  return /^\d{13}-[a-z]+$/.test(id)
}

export function getBackup(env: Env, doc: string, id: string) {
  return env.BUCKET!.get(`${prefix(doc)}${id}.bin`)
}

export async function deleteBackup(env: Env, doc: string, id: string) {
  await env.BUCKET!.delete(`${prefix(doc)}${id}.bin`)
}

/** 创建一份备份；daily 且内容与上一份相同时跳过，返回 null */
export async function createBackup(
  env: Env,
  doc: string,
  reason: BackupReason,
): Promise<BackupInfo | null> {
  const { seq, state } = await fullState(env, doc)
  if (!state) return null
  const existing = await listBackups(env, doc)
  if (reason === 'daily' && existing.find((b) => b.reason === 'daily')?.seq === seq) return null
  const at = Date.now()
  const id = `${at}-${reason}`
  await env.BUCKET!.put(`${prefix(doc)}${id}.bin`, state, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { at: String(at), reason, seq: String(seq) },
  })
  const info: BackupInfo = { id, at, reason, seq, size: state.length }
  await prune(env, doc, [info, ...existing])
  return info
}

export async function prune(env: Env, doc: string, all?: BackupInfo[]) {
  const list = all ?? (await listBackups(env, doc))
  const { keep } = await backupConfig(env)
  const daily = list.filter((b) => b.reason === 'daily').sort((a, b) => b.at - a.at)
  const other = list.filter((b) => b.reason !== 'daily').sort((a, b) => b.at - a.at)
  const doomed = [...daily.slice(Math.max(1, keep)), ...other.slice(OTHER_KEEP)]
  if (doomed.length) await env.BUCKET!.delete(doomed.map((b) => `${prefix(doc)}${b.id}.bin`))
}
