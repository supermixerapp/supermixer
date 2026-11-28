/*
 * Storage: buckets and files through the stack's Storage API (via the
 * gateway). Bulk deletes list names from storage.objects with SQL, because
 * Storage's own "empty bucket" is queued and can take an hour.
 */
import { gateway, gatewayFetch } from './api/gateway'
import { runSql, rowsOf } from './pg/run'
import { t } from '@/lib/i18n'

export interface Bucket {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  created_at: string
  updated_at: string
}

export interface StorageItem {
  name: string
  /** null for a folder */
  id: string | null
  updated_at: string | null
  created_at: string | null
  metadata: { size?: number; mimetype?: string; cacheControl?: string } | null
}

/** Folders are kept alive by this empty file, as in Studio. */
export const FOLDER_PLACEHOLDER = '.emptyFolderPlaceholder'

/** URL-escape each segment of an object path; slashes stay slashes. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

const objectUrl = (bucket: string, path: string) => `storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(path)}`

/** Join a folder prefix ('' or 'a/b/') and a name. */
export function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix.replace(/\/+$/, '')}/${name}` : name
}

/** 'a/b/c.txt' → ['a', 'b', 'c.txt'] */
export function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** Problems with a bucket, folder or file name, or null. */
export function nameProblem(name: string, kind: 'bucket' | 'folder'): string | null {
  if (!name.trim()) return t('storage:storageApi.enterAName')
  if (name.includes('/')) return t('storage:storageApi.namesCannotContain')
  if (name === '.' || name === '..') return t('storage:storageApi.thatNameIsReserved')
  if (kind === 'bucket' && name.length > 100) return t('storage:storageApi.bucketNamesCanBeAtMost')
  if (kind === 'folder' && name === FOLDER_PLACEHOLDER) return t('storage:storageApi.thatNameIsReserved')
  return null
}

export const listBuckets = (ref: string, signal?: AbortSignal) => gateway<Bucket[]>(ref, 'storage/v1/bucket', { ...(signal && { signal }) })

export interface BucketSettings {
  public: boolean
  /** bytes, or null for the stack's default limit */
  fileSizeLimit: number | null
  /** e.g. ['image/*'], or null for any type */
  allowedMimeTypes: string[] | null
}

const bucketBody = (s: BucketSettings) => ({
  public: s.public,
  file_size_limit: s.fileSizeLimit,
  allowed_mime_types: s.allowedMimeTypes && s.allowedMimeTypes.length ? s.allowedMimeTypes : null,
})

export const createBucket = (ref: string, name: string, s: BucketSettings) =>
  gateway(ref, 'storage/v1/bucket', { method: 'POST', body: { id: name, name, ...bucketBody(s) } })

export const updateBucket = (ref: string, id: string, s: BucketSettings) =>
  gateway(ref, `storage/v1/bucket/${encodeURIComponent(id)}`, { method: 'PUT', body: bucketBody(s) })

/** Delete objects by name, 1000 at a time (Storage's limit per request). */
export async function deleteObjects(ref: string, bucket: string, names: string[]): Promise<void> {
  for (let i = 0; i < names.length; i += 1000) {
    await gateway(ref, `storage/v1/object/${encodeURIComponent(bucket)}`, { method: 'DELETE', body: { prefixes: names.slice(i, i + 1000) } })
  }
}

const BATCH = 1000

/**
 * Delete every object in a bucket, or under a folder prefix, in batches:
 * list up to 1000 names after the last one seen, delete them, repeat until
 * none are left. Returns how many went.
 */
async function deleteAll(ref: string, bucket: string, prefix: string): Promise<number> {
  let after = ''
  let total = 0
  for (;;) {
    const res = await runSql(
      ref,
      `select name from storage.objects
       where bucket_id = $1 and ($2 = '' or starts_with(name, $2)) and name > $3
       order by name limit ${BATCH}`,
      { params: [bucket, prefix, after], readOnly: true, maxRows: BATCH }
    )
    const names = rowsOf<{ name: string }>(res).map((r) => r.name)
    if (names.length === 0) return total
    await deleteObjects(ref, bucket, names)
    total += names.length
    after = names[names.length - 1]!
  }
}

/** Delete a folder and everything in it. Returns how many files went. */
export const deleteFolder = (ref: string, bucket: string, folder: string) => deleteAll(ref, bucket, `${folder.replace(/\/+$/, '')}/`)

/** Delete every file in a bucket now. Returns how many files went. */
export const emptyBucket = (ref: string, bucket: string) => deleteAll(ref, bucket, '')

export async function deleteBucket(ref: string, bucket: string): Promise<void> {
  await emptyBucket(ref, bucket)
  await gateway(ref, `storage/v1/bucket/${encodeURIComponent(bucket)}`, { method: 'DELETE' })
}

/** Files and folders directly inside `prefix` ('' or 'a/b/'). */
export const listItems = (ref: string, bucket: string, prefix: string, signal?: AbortSignal) =>
  gateway<StorageItem[]>(ref, `storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    body: { prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } },
    ...(signal && { signal }),
  })

export const uploadFile = (ref: string, bucket: string, path: string, file: Blob, upsert: boolean) =>
  gatewayFetch(ref, objectUrl(bucket, path), {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': String(upsert), 'Cache-Control': 'max-age=3600' },
  })

export const createFolder = (ref: string, bucket: string, folderPath: string) =>
  uploadFile(ref, bucket, joinPath(folderPath, FOLDER_PLACEHOLDER), new Blob([''], { type: 'text/plain' }), true)

export async function downloadBlob(ref: string, bucket: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await gatewayFetch(ref, objectUrl(bucket, path), { ...(signal && { signal }) })
  return res.blob()
}

/** Save a blob to the user's downloads under `name`. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const moveObject = (ref: string, bucket: string, from: string, to: string) =>
  gateway(ref, 'storage/v1/object/move', { method: 'POST', body: { bucketId: bucket, sourceKey: from, destinationKey: to } })

/** A time-limited link anyone can open, on the stack's public API URL. */
export async function signedUrl(ref: string, apiUrl: string, bucket: string, path: string, expiresIn: number): Promise<string> {
  const { signedURL } = await gateway<{ signedURL: string }>(ref, `storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
    method: 'POST',
    body: { expiresIn },
  })
  // Storage returns the path unescaped; rebuild it from the token alone.
  const token = new URLSearchParams(signedURL.split('?')[1] ?? '').get('token') ?? ''
  return `${apiUrl.replace(/\/+$/, '')}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodePath(path)}?token=${encodeURIComponent(token)}`
}

export function publicUrl(apiUrl: string, bucket: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodePath(path)}`
}

// ------------------------------------------------------------------ sizes

const UNITS = ['bytes', 'KB', 'MB', 'GB'] as const
export type SizeUnit = (typeof UNITS)[number]
export const SIZE_UNITS = UNITS

/** Storage counts in powers of 1000 ("5MB" = 5,000,000 bytes). */
const FACTOR: Record<SizeUnit, number> = { bytes: 1, KB: 1e3, MB: 1e6, GB: 1e9 }

export function toBytes(value: number, unit: SizeUnit): number {
  return Math.round(value * FACTOR[unit])
}

/** The largest unit that shows `bytes` as a whole number. */
export function fromBytes(bytes: number): { value: number; unit: SizeUnit } {
  for (const unit of ['GB', 'MB', 'KB'] as const) {
    if (bytes >= FACTOR[unit] && bytes % FACTOR[unit] === 0) return { value: bytes / FACTOR[unit], unit }
  }
  return { value: bytes, unit: 'bytes' }
}

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null) return '—'
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = -1
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** "image/*, text/plain" → ['image/*', 'text/plain'] */
export function parseMimeTypes(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export const isImage = (mime: string | undefined) => !!mime && /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(mime)
