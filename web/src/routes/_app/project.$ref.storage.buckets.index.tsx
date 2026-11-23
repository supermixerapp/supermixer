import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, DatabasePage, SearchBox, useCanChange } from '@/components/database/catalog-page'
import { AddIcon, LockIcon, PublicIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { BucketDialog, bucketsKey } from '@/components/storage/bucket-dialog'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/toaster'
import { usePg } from '@/lib/pg/run'
import { deleteBucket, emptyBucket, FOLDER_PLACEHOLDER, formatBytes, listBuckets, type Bucket } from '@/lib/storage-api'

export const Route = createFileRoute('/_app/project/$ref/storage/buckets/')({
  component: BucketsPage,
})

/** Files and bytes per bucket, not counting folder placeholders. */
const BUCKET_STATS_SQL = `
select bucket_id, count(*)::int as files, coalesce(sum((metadata ->> 'size')::bigint), 0)::float8 as bytes
from storage.objects
where name <> '${FOLDER_PLACEHOLDER}' and name not like '%/${FOLDER_PLACEHOLDER}'
group by bucket_id`

function BucketsPage() {
  const { ref } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canChange = useCanChange()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ bucket?: Bucket } | null>(null)
  const buckets = useQuery({ queryKey: bucketsKey(ref), queryFn: ({ signal }) => listBuckets(ref, signal) })
  const stats = usePg<{ bucket_id: string; files: number; bytes: number }>(ref, ['storage-stats'], BUCKET_STATS_SQL)
  const statFor = (id: string) => stats.data?.find((s) => s.bucket_id === id)
  const rows = buckets.data?.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()))

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: bucketsKey(ref) }),
      queryClient.invalidateQueries({ queryKey: ['projects', ref, 'pg'] }),
      queryClient.invalidateQueries({ queryKey: ['projects', ref, 'storage'] }),
    ])
  const empty = useMutation<number, Error, Bucket>({
    mutationFn: (b) => emptyBucket(ref, b.id),
    onSuccess: async (n, b) => {
      toast.success(`Deleted ${n} file${n === 1 ? '' : 's'} from ${b.name}`)
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation<void, Error, Bucket>({
    mutationFn: (b) => deleteBucket(ref, b.id),
    onSuccess: async (_, b) => {
      toast.success(`Deleted bucket ${b.name}`)
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <DatabasePage
      title="Buckets"
      description="Containers for files. Open one to browse, upload and share its files."
      toolbar={<SearchBox value={search} onChange={setSearch} placeholder="Search for a bucket" />}
      actions={
        <PermissionButton allowed={canChange} action="create buckets" variant="primary" icon={<AddIcon />} onClick={() => setEditing({})}>
          New bucket
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={buckets.isPending}
        error={buckets.error}
        rowKey={(b) => b.id}
        empty={search ? 'No buckets match your search' : 'No buckets yet. Create one to start storing files.'}
        columns={[
          {
            header: 'Name',
            cell: (b) => (
              <Link
                to="/project/$ref/storage/buckets/$bucket"
                params={{ ref, bucket: b.id }}
                className="flex items-center gap-2 text-foreground hover:underline"
              >
                {b.public ? <PublicIcon size={14} className="text-warning" /> : <LockIcon size={14} className="text-foreground-lighter" />}
                {b.name}
              </Link>
            ),
          },
          { header: 'Access', cell: (b) => (b.public ? <Badge variant="warning">Public</Badge> : <Badge>Private</Badge>) },
          { header: 'File size limit', cell: (b) => (b.file_size_limit ? formatBytes(b.file_size_limit) : 'Stack default'), className: 'whitespace-nowrap' },
          { header: 'Allowed types', cell: (b) => b.allowed_mime_types?.join(', ') || 'Any' },
          {
            header: 'Files',
            cell: (b) => {
              const s = statFor(b.id)
              return s ? `${s.files.toLocaleString()} · ${formatBytes(s.bytes)}` : stats.isPending ? '…' : '0'
            },
            className: 'text-right whitespace-nowrap',
          },
        ]}
        actions={[
          { label: 'Open bucket', onSelect: (b) => void navigate({ to: '/project/$ref/storage/buckets/$bucket', params: { ref, bucket: b.id } }) },
          { label: 'Edit bucket', hidden: () => !canChange, onSelect: (b) => setEditing({ bucket: b }) },
          {
            label: 'Empty bucket',
            hidden: () => !canChange,
            confirm: (b) => ({
              title: `Empty bucket ${b.name}?`,
              description: `Every file in it is deleted now${statFor(b.id) ? ` (${statFor(b.id)!.files.toLocaleString()} files)` : ''}. This can't be undone.`,
              confirmText: b.name,
            }),
            onSelect: (b) => empty.mutate(b),
          },
          {
            label: 'Delete bucket',
            hidden: () => !canChange,
            confirm: (b) => ({
              title: `Delete bucket ${b.name}?`,
              description: "Its files are deleted first, then the bucket. This can't be undone.",
              confirmText: b.name,
            }),
            onSelect: (b) => remove.mutate(b),
          },
        ]}
      />
      {editing && (
        <BucketDialog
          projectRef={ref}
          {...(editing.bucket && { bucket: editing.bucket })}
          onClose={() => setEditing(null)}
          onCreated={(name) => void navigate({ to: '/project/$ref/storage/buckets/$bucket', params: { ref, bucket: name } })}
        />
      )}
    </DatabasePage>
  )
}
