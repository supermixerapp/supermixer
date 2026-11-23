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
      const toastId = toast.loading(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`)
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
        toast.loading(`Uploading… ${i + 1} of ${files.length}`, { id: toastId })
      }
      toast.dismiss(toastId)
      await refresh()
      if (done) toast.success(`Uploaded ${done} file${done === 1 ? '' : 's'}`)
      if (failures.length) {
        toast.error(`${failures.length} file${failures.length === 1 ? '' : 's'} failed to upload`, {
          description: failures.slice(0, 5).join('\n') + (failures.length > 5 ? `\n…and ${failures.length - 5} more` : ''),
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
      toast.success(`Deleted ${n} file${n === 1 ? '' : 's'}`)
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
        <Alert variant="warning" title={`There is no bucket called ${bucketId}.`}>
          <Link to="/project/$ref/storage/buckets" params={{ ref }} className="underline">
            Back to buckets
          </Link>
        </Alert>
      </PageContainer>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer size="large" className="flex flex-col gap-4 pt-8 pb-16">
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 text-sm">
          <Link to="/project/$ref/storage/buckets" params={{ ref }} className="text-foreground-light hover:text-foreground">
            Buckets
          </Link>
          <ChevronRightIcon size={14} className="text-foreground-lighter" />
          <button className={cn('hover:text-foreground', path ? 'text-foreground-light' : 'text-foreground')} onClick={() => goTo('')}>
            {bucket?.name ?? bucketId}
          </button>
          {bucket && (bucket.public ? <Badge variant="warning">Public</Badge> : <Badge>Private</Badge>)}
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
            <Input size="tiny" className="pl-7" placeholder="Filter this folder" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={items.isFetching && !items.isPending} onClick={() => void refresh()}>
            Refresh
          </Button>
          {chosen.length > 0 && (
            <span className="flex items-center gap-2 text-xs text-foreground-light">
              {chosen.length} selected
              {chosen.some((n) => files.some((f) => f.name === n)) && (
                <Button variant="default" size="tiny" onClick={() => void downloadSelected()}>
                  Download
                </Button>
              )}
              {canChange && (
                <Button variant="danger" size="tiny" onClick={() => askDelete(chosen)}>
                  Delete
                </Button>
              )}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canChange && bucket && (
              <Button variant="text" size="tiny" onClick={() => setEditingBucket(true)}>
                Bucket settings
              </Button>
            )}
            <PermissionButton allowed={canChange} action="create folders" variant="default" size="tiny" icon={<AddIcon />} onClick={() => setNewFolder(true)}>
              New folder
            </PermissionButton>
            <PermissionButton
              allowed={canChange}
              action="upload files"
              variant="primary"
              size="tiny"
              icon={<UploadIcon />}
              loading={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              Upload files
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
              {filter ? 'Nothing here matches your filter' : canChange ? 'This folder is empty. Drop files here, or use Upload files.' : 'This folder is empty.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all"
                      checked={allSelected}
                      onCheckedChange={(c) => setSelected(c === true ? new Set(visible.map((i) => i.name)) : new Set())}
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="whitespace-nowrap">Last modified</TableHead>
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
                        <Checkbox aria-label={`Select ${item.name}`} checked={selected.has(item.name)} onCheckedChange={(c) => toggle(item.name, c === true)} />
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
                      <TableCell className="text-foreground-light">{folder ? 'Folder' : (mime ?? '')}</TableCell>
                      <TableCell className="whitespace-nowrap text-foreground-light">
                        {item.updated_at ? new Date(item.updated_at).toLocaleString() : ''}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="text" size="tiny" icon={<MoreIcon />} aria-label={`Actions for ${item.name}`} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onSelect={openItem}>{folder ? 'Open folder' : 'Details'}</DropdownMenuItem>
                            {!folder && (
                              <DropdownMenuItem
                                onSelect={() =>
                                  void downloadBlob(ref, bucketId, joinPath(prefix, item.name)).then(
                                    (b) => saveBlob(b, item.name),
                                    (e: Error) => toast.error(e.message)
                                  )
                                }
                              >
                                Download
                              </DropdownMenuItem>
                            )}
                            {canChange && <DropdownMenuItem onSelect={() => askDelete([item.name])}>{folder ? 'Delete folder' : 'Delete'}</DropdownMenuItem>}
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
              Drop to upload to {path ? `${bucket?.name ?? bucketId}/${path}` : (bucket?.name ?? bucketId)}
            </div>
          )}
        </Card>
        {(items.data?.length ?? 0) >= 1000 && (
          <p className="text-xs text-foreground-lighter">Showing the first 1,000 items in this folder.</p>
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
            toast.success(`Created ${name}`)
            await refresh()
            goTo(joinPath(path, name))
          }}
        />
      )}
      {editingBucket && bucket && <BucketDialog projectRef={ref} bucket={bucket} onClose={() => setEditingBucket(false)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${describe(deleting)}?`}
        description={
          deleting?.folders.length
            ? 'Folders are deleted with everything inside them. This can’t be undone.'
            : 'This can’t be undone; links to these files stop working.'
        }
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting, { onSettled: () => setDeleting(null) })}
      />
      <ConfirmDialog
        open={!!replacing}
        onOpenChange={(o) => !o && setReplacing(null)}
        variant="warning"
        title={`Replace ${replacing?.length === 1 ? replacing[0]!.name : `${replacing?.length} files`}?`}
        description="Files with these names already exist in this folder. Replacing them overwrites the old versions."
        confirmLabel="Replace"
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
  if (d.files.length) parts.push(`${d.files.length} file${d.files.length === 1 ? '' : 's'}`)
  if (d.folders.length) parts.push(`${d.folders.length} folder${d.folders.length === 1 ? '' : 's'}`)
  return parts.join(' and ')
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
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Folders are kept with an empty placeholder file, as in Supabase Studio.</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-3 border-t">
            {create.error && <Alert variant="destructive" title={create.error.message} />}
            <FormField label="Name" htmlFor="folder-name" description={problem && name ? <span className="text-destructive">{problem}</span> : undefined}>
              <Input id="folder-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!!problem} loading={create.isPending}>
              Create folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
