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
import { t, language } from '@/lib/i18n'

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
      toast.success(t('storage:storageBuckets.deletedFilesFrom', { count: n, name: b.name }))
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation<void, Error, Bucket>({
    mutationFn: (b) => deleteBucket(ref, b.id),
    onSuccess: async (_, b) => {
      toast.success(t('storage:storageBuckets.deletedBucket', { name: b.name }))
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <DatabasePage
      title={t('storage:storageBuckets.buckets')}
      description={t('storage:storageBuckets.containersForFilesOpenOneTo')}
      toolbar={<SearchBox value={search} onChange={setSearch} placeholder={t('storage:storageBuckets.searchForABucket')} />}
      actions={
        <PermissionButton allowed={canChange} action={t('storage:storageBuckets.createBuckets')} variant="primary" icon={<AddIcon />} onClick={() => setEditing({})}>
          {t('storage:storageBuckets.newBucket')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={buckets.isPending}
        error={buckets.error}
        rowKey={(b) => b.id}
        empty={search ? t('storage:storageBuckets.noBucketsMatchYourSearch') : t('storage:storageBuckets.noBucketsYetCreateOneTo')}
        columns={[
          {
            header: t('storage:storageBuckets.name'),
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
          { header: t('storage:storageBuckets.access'), cell: (b) => (b.public ? <Badge variant="warning">{t('storage:storageBuckets.public')}</Badge> : <Badge>{t('storage:storageBuckets.private')}</Badge>) },
          { header: t('storage:storageBuckets.fileSizeLimit'), cell: (b) => (b.file_size_limit ? formatBytes(b.file_size_limit) : t('storage:storageBuckets.stackDefault')), className: 'whitespace-nowrap' },
          { header: t('storage:storageBuckets.allowedTypes'), cell: (b) => b.allowed_mime_types?.join(', ') || t('storage:storageBuckets.any') },
          {
            header: t('storage:storageBuckets.files'),
            cell: (b) => {
              const s = statFor(b.id)
              return s ? `${s.files.toLocaleString(language())} · ${formatBytes(s.bytes)}` : stats.isPending ? '…' : '0'
            },
            className: 'text-right whitespace-nowrap',
          },
        ]}
        actions={[
          { label: t('storage:storageBuckets.openBucket'), onSelect: (b) => void navigate({ to: '/project/$ref/storage/buckets/$bucket', params: { ref, bucket: b.id } }) },
          { label: t('storage:storageBuckets.editBucket'), hidden: () => !canChange, onSelect: (b) => setEditing({ bucket: b }) },
          {
            label: t('storage:storageBuckets.emptyBucket'),
            hidden: () => !canChange,
            confirm: (b) => ({
              title: t('storage:storageBuckets.emptyBucket2', { name: b.name }),
              description: statFor(b.id) ? t('storage:storageBuckets.everyFileCounted', { count: statFor(b.id)!.files }) : t('storage:storageBuckets.everyFileInItIsDeleted'),
              confirmText: b.name,
            }),
            onSelect: (b) => empty.mutate(b),
          },
          {
            label: t('storage:storageBuckets.deleteBucket'),
            hidden: () => !canChange,
            confirm: (b) => ({
              title: t('storage:storageBuckets.deleteBucket2', { name: b.name }),
              description: t('storage:storageBuckets.itsFilesAreDeletedFirstThen'),
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
