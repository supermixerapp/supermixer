import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useRef, useState, type DragEvent } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { useCanChange } from '@/components/database/catalog-page'
import { AddIcon, ChevronRightIcon, FileIcon, FolderIcon, ImageIcon, MoreIcon, RefreshIcon, SearchIcon, UploadIcon } from '@/components/icons'
import { PageContainer } from '@/components/layout/page'
import { PermissionButton } from '@/components/permission-button'
import { BucketDialog, bucketsKey } from '@/components/storage/bucket-dialog'
import { FileSheet } from '@/components/storage/file-sheet'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { useSelectedProject } from '@/lib/api/hooks'
import {
  createFolder,
  deleteFolder,
  deleteObjects,
  downloadBlob,
  FOLDER_PLACEHOLDER,
  formatBytes,
  isImage,
  joinPath,
  listBuckets,
  listItems,
  nameProblem,
  pathParts,
  saveBlob,
  uploadFile,
  type StorageItem,
} from '@/lib/storage-api'
import { cn } from '@/lib/utils'
import { t, language } from '@/lib/i18n'
import { formatList } from '@/lib/i18n/format'

export const Route = createFileRoute('/_app/project/$ref/storage/buckets/$bucket')({
  validateSearch: (search: Record<string, unknown>): { path?: string } =>
    typeof search.path === 'string' && search.path ? { path: pathParts(search.path).join('/') } : {},
  component: FileBrowser,
})

/** Storage answers a duplicate upload with this message (HTTP 400, code 409). */
const isDuplicate = (e: unknown) => e instanceof Error && /already exists/i.test(e.message)

function FileBrowser() {
  const { ref, bucket: bucketId } = Route.useParams()
  const { path = '' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const project = useSelectedProject()
  const canChange = useCanChange()
  const fileInput = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<StorageItem | null>(null)
  const [newFolder, setNewFolder] = useState(false)
  const [editingBucket, setEditingBucket] = useState(false)
  const [deleting, setDeleting] = useState<{ files: string[]; folders: string[] } | null>(null)
  const [replacing, setReplacing] = useState<File[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const [selectionKey, setSelectionKey] = useState(`${bucketId}/${path}`)

  // A new folder starts with nothing selected.
  if (selectionKey !== `${bucketId}/${path}`) {
    setSelectionKey(`${bucketId}/${path}`)
    setSelected(new Set())
    setFilter('')
  }

  const buckets = useQuery({ queryKey: bucketsKey(ref), queryFn: ({ signal }) => listBuckets(ref, signal) })
  const bucket = buckets.data?.find((b) => b.id === bucketId)
  const prefix = path ? `${path}/` : ''
  const itemsKey = ['projects', ref, 'storage', 'items', bucketId, prefix]
  const items = useQuery({ queryKey: itemsKey, queryFn: ({ signal }) => listItems(ref, bucketId, prefix, signal) })
  const visible = (items.data ?? [])
    .filter((i) => i.name !== FOLDER_PLACEHOLDER)
    .filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()))
    // Folders first, as in a file manager.
    .sort((a, b) => Number(a.id !== null) - Number(b.id !== null) || a.name.localeCompare(b.name))

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['projects', ref, 'storage', 'items', bucketId] }),
      queryClient.invalidateQueries({ queryKey: ['projects', ref, 'pg', 'storage-stats'] }),
    ])
  const goTo = (p: string) => void navigate({ search: p ? { path: p } : {} })

  // Every file is tried; then successes, failures and duplicates are reported together.
  const upload = useMutation<void, Error, { files: File[]; upsert: boolean }>({
    mutationFn: async ({ files, upsert }) => {
      const toastId = toast.loading(t('storage:storageBuckets.uploadingFiles', { count: files.length }))
      const duplicates: File[] = []
      const failures: string[] = []
      let done = 0
      for (const [i, f] of files.entries()) {
        try {
          await uploadFile(ref, bucketId, joinPath(prefix, f.name), f, upsert)
          done++
        } catch (e) {
          if (!upsert && isDuplicate(e)) duplicates.push(f)
          else failures.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
        toast.loading(t('storage:storageBuckets.uploadingOf', { i: i + 1, length: files.length }), { id: toastId })
      }
      toast.dismiss(toastId)
      await refresh()
      if (done) toast.success(t('storage:storageBuckets.uploadedFiles', { count: done }))
      if (failures.length) {
        toast.error(t('storage:storageBuckets.filesFailedToUpload', { count: failures.length }), {
          description: failures.slice(0, 5).join('\n') + (failures.length > 5 ? t('storage:storageBuckets.andMore', { length: failures.length - 5 }) : ''),
          duration: 15_000,
        })
      }
      if (duplicates.length) setReplacing(duplicates)
    },
    onError: (e) => toast.error(e.message),
  })
  const startUpload = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? [])
    if (files.length && canChange) upload.mutate({ files, upsert: false })
  }

  const remove = useMutation<number, Error, { files: string[]; folders: string[] }>({
    mutationFn: async ({ files, folders }) => {
      let n = files.length
      await deleteObjects(ref, bucketId, files)
      for (const f of folders) n += await deleteFolder(ref, bucketId, f)
      return n
    },
    onSuccess: async (n) => {
      toast.success(t('storage:storageBuckets.deletedFiles', { count: n }))
      setSelected(new Set())
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const downloadSelected = async () => {
    for (const name of chosen) {
      const item = visible.find((i) => i.name === name)
      if (!item || item.id === null) continue
      try {
        saveBlob(await downloadBlob(ref, bucketId, joinPath(prefix, name)), name)
      } catch (e) {
        toast.error(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const askDelete = (names: string[]) => {
    const chosen = visible.filter((i) => names.includes(i.name))
    setDeleting({
      files: chosen.filter((i) => i.id !== null).map((i) => joinPath(prefix, i.name)),
      folders: chosen.filter((i) => i.id === null).map((i) => joinPath(prefix, i.name)),
    })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    startUpload(e.dataTransfer.files)
  }

  const files = visible.filter((i) => i.id !== null)
  // Only items still listed and shown count; deleted, moved or filtered-out ones drop out.
  const chosen = visible.filter((i) => selected.has(i.name)).map((i) => i.name)
  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.name))
  const toggle = (name: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })

  if (buckets.isSuccess && !bucket) {
    return (
      <PageContainer size="large" className="py-12">
        <Alert variant="warning" title={t('storage:storageBuckets.thereIsNoBucketCalled', { bucketId })}>
          <Link to="/project/$ref/storage/buckets" params={{ ref }} className="underline">
            {t('storage:storageBuckets.backToBuckets')}
          </Link>
        </Alert>
      </PageContainer>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer size="large" className="flex flex-col gap-4 pt-8 pb-16">
        <nav aria-label={t('storage:storageBuckets.folder')} className="flex flex-wrap items-center gap-1 text-sm">
          <Link to="/project/$ref/storage/buckets" params={{ ref }} className="text-foreground-light hover:text-foreground">
            {t('storage:storageBuckets.buckets')}
          </Link>
          <ChevronRightIcon size={14} className="text-foreground-lighter" />
          <button className={cn('hover:text-foreground', path ? 'text-foreground-light' : 'text-foreground')} onClick={() => goTo('')}>
            {bucket?.name ?? bucketId}
          </button>
          {bucket && (bucket.public ? <Badge variant="warning">{t('storage:storageBuckets.public')}</Badge> : <Badge>{t('storage:storageBuckets.private')}</Badge>)}
          {pathParts(path).map((part, i, all) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRightIcon size={14} className="text-foreground-lighter" />
              <button
                className={cn('hover:text-foreground', i === all.length - 1 ? 'text-foreground' : 'text-foreground-light')}
                onClick={() => goTo(all.slice(0, i + 1).join('/'))}
              >
                {part}
              </button>
            </span>
          ))}
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-56">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter" />
            <Input size="tiny" className="pl-7" placeholder={t('storage:storageBuckets.filterThisFolder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={items.isFetching && !items.isPending} onClick={() => void refresh()}>
            {t('storage:storageBuckets.refresh')}
          </Button>
          {chosen.length > 0 && (
            <span className="flex items-center gap-2 text-xs text-foreground-light">
              {t('storage:storageBuckets.selectedCount', { count: chosen.length })}
              {chosen.some((n) => files.some((f) => f.name === n)) && (
                <Button variant="default" size="tiny" onClick={() => void downloadSelected()}>
                  {t('storage:storageBuckets.download')}
                </Button>
              )}
              {canChange && (
                <Button variant="danger" size="tiny" onClick={() => askDelete(chosen)}>
                  {t('storage:storageBuckets.delete')}
                </Button>
              )}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canChange && bucket && (
              <Button variant="text" size="tiny" onClick={() => setEditingBucket(true)}>
                {t('storage:storageBuckets.bucketSettings')}
              </Button>
            )}
            <PermissionButton allowed={canChange} action={t('storage:storageBuckets.createFolders')} variant="default" size="tiny" icon={<AddIcon />} onClick={() => setNewFolder(true)}>
              {t('storage:storageBuckets.newFolder')}
            </PermissionButton>
            <PermissionButton
              allowed={canChange}
              action={t('storage:storageBuckets.uploadFiles2')}
              variant="primary"
              size="tiny"
              icon={<UploadIcon />}
              loading={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {t('storage:storageBuckets.uploadFiles')}
            </PermissionButton>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                startUpload(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        </div>

        <Card
          className={cn('relative', dragging && 'ring-2 ring-brand-default')}
          onDragOver={(e) => {
            if (!canChange) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={onDrop}
        >
          {items.error ? (
            <div className="p-4">
              <Alert variant="destructive" title={items.error.message} />
            </div>
          ) : items.isPending ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-4 py-14 text-center text-sm text-foreground-lighter">
              {filter ? t('storage:storageBuckets.nothingHereMatchesYourFilter') : canChange ? t('storage:storageBuckets.thisFolderIsEmptyDropFiles') : t('storage:storageBuckets.thisFolderIsEmpty')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label={t('storage:storageBuckets.selectAll')}
                      checked={allSelected}
                      onCheckedChange={(c) => setSelected(c === true ? new Set(visible.map((i) => i.name)) : new Set())}
                    />
                  </TableHead>
                  <TableHead>{t('storage:storageBuckets.name')}</TableHead>
                  <TableHead className="text-right">{t('storage:storageBuckets.size')}</TableHead>
                  <TableHead>{t('storage:storageBuckets.type')}</TableHead>
                  <TableHead className="whitespace-nowrap">{t('storage:storageBuckets.lastModified')}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((item) => {
                  const folder = item.id === null
                  const mime = item.metadata?.mimetype
                  const openItem = () => (folder ? goTo(joinPath(path, item.name)) : setOpen(item))
                  return (
                    <TableRow key={item.name} data-state={selected.has(item.name) ? 'selected' : undefined}>
                      <TableCell>
                        <Checkbox aria-label={t('storage:storageBuckets.select', { name: item.name })} checked={selected.has(item.name)} onCheckedChange={(c) => toggle(item.name, c === true)} />
                      </TableCell>
                      <TableCell>
                        <button className="flex items-center gap-2 text-left text-foreground hover:underline" onClick={openItem}>
                          {folder ? (
                            <FolderIcon size={16} className="shrink-0 text-foreground-lighter" />
                          ) : isImage(mime) ? (
                            <ImageIcon size={16} className="shrink-0 text-foreground-lighter" />
                          ) : (
                            <FileIcon size={16} className="shrink-0 text-foreground-lighter" />
                          )}
                          <span className="break-all">{item.name}</span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap text-foreground-light">{folder ? '' : formatBytes(item.metadata?.size)}</TableCell>
                      <TableCell className="text-foreground-light">{folder ? t('storage:storageBuckets.folder') : (mime ?? '')}</TableCell>
                      <TableCell className="whitespace-nowrap text-foreground-light">
                        {item.updated_at ? new Date(item.updated_at).toLocaleString(language()) : ''}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="text" size="tiny" icon={<MoreIcon />} aria-label={t('storage:storageBuckets.actionsFor', { name: item.name })} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onSelect={openItem}>{folder ? t('storage:storageBuckets.openFolder') : t('storage:storageBuckets.details')}</DropdownMenuItem>
                            {!folder && (
                              <DropdownMenuItem
                                onSelect={() =>
                                  void downloadBlob(ref, bucketId, joinPath(prefix, item.name)).then(
                                    (b) => saveBlob(b, item.name),
                                    (e: Error) => toast.error(e.message)
                                  )
                                }
                              >
                                {t('storage:storageBuckets.download')}
                              </DropdownMenuItem>
                            )}
                            {canChange && <DropdownMenuItem onSelect={() => askDelete([item.name])}>{folder ? t('storage:storageBuckets.deleteFolder') : t('storage:storageBuckets.delete')}</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          {dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/80 text-sm text-foreground">
              {t('storage:storageBuckets.dropToUploadTo', { place: path ? `${bucket?.name ?? bucketId}/${path}` : (bucket?.name ?? bucketId) })}
            </div>
          )}
        </Card>
        {(items.data?.length ?? 0) >= 1000 && (
          <p className="text-xs text-foreground-lighter">{t('storage:storageBuckets.showingTheFirst1000Items')}</p>
        )}
      </PageContainer>

      {open && bucket && project && (
        <FileSheet
          projectRef={ref}
          apiUrl={project.api_url}
          bucket={bucket}
          path={joinPath(prefix, open.name)}
          item={open}
          canChange={canChange}
          onChanged={refresh}
          onClose={() => setOpen(null)}
        />
      )}
      {newFolder && (
        <NewFolderDialog
          onClose={() => setNewFolder(false)}
          onCreate={async (name) => {
            await createFolder(ref, bucketId, joinPath(path, name))
            toast.success(t('storage:storageBuckets.created', { name }))
            await refresh()
            goTo(joinPath(path, name))
          }}
        />
      )}
      {editingBucket && bucket && <BucketDialog projectRef={ref} bucket={bucket} onClose={() => setEditingBucket(false)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('storage:storageBuckets.delete2', { describe: describe(deleting) })}
        description={
          deleting?.folders.length
            ? t('storage:storageBuckets.foldersAreDeletedWithEverythingInside')
            : t('storage:storageBuckets.thisCanTBeUndoneLinks')
        }
        confirmLabel={t('storage:storageBuckets.delete')}
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting, { onSettled: () => setDeleting(null) })}
      />
      <ConfirmDialog
        open={!!replacing}
        onOpenChange={(o) => !o && setReplacing(null)}
        variant="warning"
        title={t('storage:storageBuckets.replace', { value: replacing?.length === 1 ? replacing[0]!.name : `${replacing?.length} files` })}
        description={t('storage:storageBuckets.filesWithTheseNamesAlreadyExist')}
        confirmLabel={t('storage:storageBuckets.replace2')}
        onConfirm={() => {
          if (replacing) upload.mutate({ files: replacing, upsert: true })
          setReplacing(null)
        }}
      />
    </div>
  )
}

function describe(d: { files: string[]; folders: string[] } | null): string {
  if (!d) return ''
  const total = d.files.length + d.folders.length
  if (total === 1) return (d.files[0] ?? d.folders[0] ?? '').split('/').pop() ?? ''
  const parts = []
  if (d.files.length) parts.push(t('storage:storageBuckets.fileCount', { count: d.files.length }))
  if (d.folders.length) parts.push(t('storage:storageBuckets.folders', { count: d.folders.length }))
  return formatList(parts)
}

function NewFolderDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const create = useMutation<void, Error>({ mutationFn: () => onCreate(name.trim()), onSuccess: onClose })
  const problem = nameProblem(name.trim(), 'folder')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="small">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!problem && !create.isPending) create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('storage:storageBuckets.newFolder')}</DialogTitle>
            <DialogDescription>{t('storage:storageBuckets.foldersAreKeptWithAnEmpty')}</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-3 border-t">
            {create.error && <Alert variant="destructive" title={create.error.message} />}
            <FormField label={t('storage:storageBuckets.name')} htmlFor="folder-name" description={problem && name ? <span className="text-destructive">{problem}</span> : undefined}>
              <Input id="folder-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              {t('storage:storageBuckets.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!!problem} loading={create.isPending}>
              {t('storage:storageBuckets.createFolder')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
