import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useState, type ReactNode } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DownloadIcon, LinkIcon } from '@/components/icons'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetSection } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import {
  deleteObjects,
  downloadBlob,
  formatBytes,
  isImage,
  moveObject,
  publicUrl,
  saveBlob,
  signedUrl,
  type Bucket,
  type StorageItem,
} from '@/lib/storage-api'

const LINK_EXPIRY: { label: string; seconds: number }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86_400 },
  { label: '1 week', seconds: 604_800 },
  { label: '1 month', seconds: 2_592_000 },
  { label: '1 year', seconds: 31_536_000 },
]

/** Text files small enough to show inline (only when the size is known). */
const isText = (mime: string | undefined, size: number | undefined) =>
  !!mime && (mime.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(mime)) && size !== undefined && size <= 200_000

const PREVIEW_LIMIT = 25_000_000

export function FileSheet({
  projectRef,
  apiUrl,
  bucket,
  path,
  item,
  canChange,
  onChanged,
  onClose,
}: {
  projectRef: string
  apiUrl: string
  bucket: Bucket
  /** Full object path, e.g. 'docs/a.txt' */
  path: string
  item: StorageItem
  canChange: boolean
  onChanged: () => Promise<unknown>
  onClose: () => void
}) {
  const mime = item.metadata?.mimetype
  const size = item.metadata?.size
  const previewable = (isImage(mime) || isText(mime, size)) && size !== undefined && size <= PREVIEW_LIMIT
  const preview = useQuery({
    queryKey: ['projects', projectRef, 'storage', 'preview', bucket.id, path, item.updated_at],
    queryFn: async ({ signal }) => {
      const blob = await downloadBlob(projectRef, bucket.id, path, signal)
      return { blob, text: isText(mime, size) ? await blob.text() : null }
    },
    enabled: previewable,
    staleTime: Infinity,
  })
  const blob = preview.data && isImage(mime) ? preview.data.blob : null
  // The object URL lives exactly as long as the <img> is attached: a ref
  // callback with cleanup survives StrictMode's remounts, unlike a memo.
  const imageRef = useCallback(
    (el: HTMLImageElement | null) => {
      if (!el || !blob) return
      const url = URL.createObjectURL(blob)
      el.src = url
      return () => URL.revokeObjectURL(url)
    },
    [blob]
  )

  const [expiry, setExpiry] = useState(String(LINK_EXPIRY[1]!.seconds))
  const [target, setTarget] = useState(path)
  const [signed, setSigned] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const name = path.split('/').pop() ?? path

  const download = useMutation<void, Error>({
    mutationFn: async () => saveBlob(preview.data?.blob ?? (await downloadBlob(projectRef, bucket.id, path)), name),
    onError: (e) => toast.error(e.message),
  })
  // Shown in a field to copy from: copying after an await fails in Safari.
  const sign = useMutation<string, Error>({
    mutationFn: () => signedUrl(projectRef, apiUrl, bucket.id, path, Number(expiry)),
    onSuccess: setSigned,
    onError: (e) => toast.error(e.message),
  })
  // Check exactly what will be sent.
  const dest = target.trim().replace(/^\/+/, '')
  const move = useMutation<unknown, Error>({
    mutationFn: () => moveObject(projectRef, bucket.id, path, dest),
    onSuccess: async () => {
      toast.success(`Moved to ${dest}`)
      onClose()
      await onChanged()
    },
  })
  const remove = useMutation<void, Error>({
    mutationFn: () => deleteObjects(projectRef, bucket.id, [path]),
    onSuccess: async () => {
      toast.success(`Deleted ${name}`)
      onClose()
      await onChanged()
    },
    onError: (e) => toast.error(e.message),
  })
  const targetOk = !!dest && dest !== path && dest.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg" className="flex flex-col">
        <SheetHeader>
          <h2 className="truncate text-base text-foreground" title={path}>
            {name}
          </h2>
          <p className="truncate text-xs text-foreground-lighter">
            {bucket.name}/{path}
          </p>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <SheetSection>
            {!previewable ? (
              <p className="rounded-md border bg-surface-100 px-3 py-8 text-center text-xs text-foreground-lighter">
                {size === undefined ? 'No preview: the file size is unknown.' : size > PREVIEW_LIMIT ? 'Too large to preview.' : 'No preview for this type of file.'}
              </p>
            ) : preview.error ? (
              <Alert variant="destructive" title={preview.error.message} />
            ) : !preview.data ? (
              <Skeleton className="h-48" />
            ) : blob ? (
              <img ref={imageRef} alt={name} className="mx-auto max-h-96 rounded-md border bg-surface-100 object-contain" />
            ) : (
              <pre className="max-h-96 overflow-auto rounded-md border bg-surface-100 p-3 font-mono text-xs text-foreground">{preview.data.text}</pre>
            )}
          </SheetSection>
          <SheetSection className="border-t">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Type">{mime ?? '—'}</Field>
              <Field label="Size">{formatBytes(size)}</Field>
              <Field label="Last modified">{item.updated_at ? new Date(item.updated_at).toLocaleString() : '—'}</Field>
              <Field label="Cache control">{item.metadata?.cacheControl ?? '—'}</Field>
            </dl>
          </SheetSection>
          <SheetSection className="flex flex-col gap-3 border-t">
            <Button variant="default" className="self-start" icon={<DownloadIcon />} loading={download.isPending} onClick={() => download.mutate()}>
              Download
            </Button>
            {bucket.public ? (
              <FormField label="Public URL" description="Anyone with this link can open the file.">
                <CopyField value={publicUrl(apiUrl, bucket.id, path)} />
              </FormField>
            ) : canChange ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="default" icon={<LinkIcon />} loading={sign.isPending} onClick={() => sign.mutate()}>
                    Create signed URL
                  </Button>
                  <Select
                    value={expiry}
                    onValueChange={(v) => {
                      setExpiry(v)
                      setSigned(null)
                    }}
                  >
                    <SelectTrigger className="w-36" aria-label="Link expires in">
                      <span className="text-foreground-lighter">for</span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LINK_EXPIRY.map((e) => (
                        <SelectItem key={e.seconds} value={String(e.seconds)}>
                          {e.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {signed && <CopyField value={signed} />}
                <p className="text-xs text-foreground-lighter">Signed URLs work for anyone who has them until they expire, and can&apos;t be revoked early.</p>
              </div>
            ) : null}
          </SheetSection>
          {canChange && (
            <SheetSection className="flex flex-col gap-4 border-t">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (targetOk && !move.isPending) move.mutate()
                }}
              >
                <FormField label="Move or rename" htmlFor="file-target" description="The full path in this bucket, e.g. archive/2026/report.pdf">
                  <Input id="file-target" value={target} onChange={(e) => setTarget(e.target.value)} />
                </FormField>
                {move.error && <Alert variant="destructive" title={move.error.message} />}
                <Button type="submit" variant="default" className="self-start" disabled={!targetOk} loading={move.isPending}>
                  Move
                </Button>
              </form>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <p className="text-sm text-foreground">Delete file</p>
                  <p className="text-xs text-foreground-lighter">Links to it stop working.</p>
                </div>
                <Button variant="danger" size="tiny" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              </div>
            </SheetSection>
          )}
        </div>
      </SheetContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${name}?`}
        description="This can't be undone."
        confirmLabel="Delete file"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSettled: () => setConfirmDelete(false) })}
      />
    </Sheet>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-foreground-lighter">{label}</dt>
      <dd className="truncate text-foreground">{children}</dd>
    </div>
  )
}
