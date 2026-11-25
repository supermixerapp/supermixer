/*
 * Database › Backups for stacks Supermixer created: Supabase-style
 * dumps (roles, schema, data) on Supermixer's server, and copied to an S3
 * bucket when one is set up, taken on a schedule or on demand, restored into
 * this project or a new one.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { MoreIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { stackQuery, useStackSync } from '@/components/project/stack'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { formatBytes } from '@/lib/storage-api'

export const Route = createFileRoute('/_app/project/$ref/database/backups')({
  component: BackupsPage,
})

type Backup = Schemas['Backup']

const KIND_LABELS: Record<Backup['kind'], string> = {
  scheduled: 'Scheduled',
  manual: 'Manual',
  pre_restore: 'Before a restore',
  pre_upgrade: 'Before an upgrade',
}

const FILES = ['roles.sql', 'schema.sql', 'data.sql'] as const

function BackupsPage() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader
        title="Backups"
        description="Database backups in the format of supabase db dump: roles, schema and data. Storage files aren't included, as in Supabase's own backups."
      />
      <PageContainer className="flex flex-col gap-10 pb-16">
        {!project ? null : project.stack ? (
          <ManagedBackups project={project} />
        ) : (
          <Alert title="Supermixer connects to this stack; it didn't create it">
            Back its database up where it runs, for example with supabase db dump. Projects created
            with “Create a new stack” are backed up from here.
          </Alert>
        )}
      </PageContainer>
    </>
  )
}

function ManagedBackups({ project }: { project: Schemas['Project'] }) {
  const ref = project.ref
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const allowed = can(project, 'project:update')
  const stack = useQuery(stackQuery(ref))
  useStackSync(ref, stack.data)
  const list = useQuery({
    queryKey: ['projects', ref, 'backups'],
    queryFn: () => unwrap(api.GET('/projects/{ref}/backups', { params: { path: { ref } } })),
    refetchInterval: (q) => {
      const d = q.state.data
      if (d?.backups.some((b) => b.status === 'running')) return 2000
      return d?.backups.some((b) => uploading(b, !!d.s3)) ? 5000 : 30000
    },
  })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'backups'] })
    void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] })
  }

  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/backups', { params: { path: { ref } } })),
    onSuccess: () => toast.success('Backing up the database'),
    onError: (e) => toast.error(e.message),
    onSettled: refresh,
  })
  const [deleting, setDeleting] = useState<Backup | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/projects/{ref}/backups/{id}', { params: { path: { ref, id } } })),
    onSuccess: () => toast.success('Backup deleted'),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setDeleting(null)
      refresh()
    },
  })
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const restore = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/projects/{ref}/backups/{id}/restore', { params: { path: { ref, id } } })),
    onSuccess: () => toast.success('Restoring; the project is offline until it finishes'),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setRestoring(null)
      refresh()
    },
  })
  const retryUpload = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/projects/{ref}/backups/{id}/upload', { params: { path: { ref, id } } })),
    onSuccess: () => toast.success('Copying the backup to the bucket'),
    onError: (e) => toast.error(e.message),
    onSettled: refresh,
  })
  const [copying, setCopying] = useState<Backup | null>(null)
  const [copyName, setCopyName] = useState('')
  const restoreToNew = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      unwrap(
        api.POST('/projects/{ref}/backups/{id}/restore-to-new', {
          params: { path: { ref, id } },
          body: { name },
        })
      ),
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'], exact: true })
      toast.success(`Creating ${p.name} from the backup`)
      void navigate({ to: '/project/$ref', params: { ref: p.ref } })
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setCopying(null),
  })

  const s = stack.data
  if (list.error) return <Alert variant="destructive" title={list.error.message} />
  if (!list.data || !s) return <Skeleton className="h-64" />
  const { backups, interval_hours, keep, s3 } = list.data
  const showStored = !!s3 || backups.some((b) => b.remote)
  const busy = !!s.operation
  const running = s.status === 'running'
  const cantBackUp = !running
    ? 'Start the stack to back it up'
    : busy
      ? 'The stack is busy; wait for it to finish'
      : null

  return (
    <>
      <SettingsSection
        title="Schedule"
        description="Set by the Supermixer server's configuration (provisioning.backup_interval, backup_keep and backup_s3)."
      >
        <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
          <span className="flex flex-col gap-1.5 text-foreground-light">
            <span>
              {interval_hours > 0 ? (
                <>
                  Backed up every {formatInterval(interval_hours)} while running; the newest {keep}{' '}
                  scheduled backups are kept. Manual backups are kept until you delete them.
                </>
              ) : (
                <>Scheduled backups are off. Manual backups are kept until you delete them.</>
              )}
            </span>
            <span className="text-xs text-foreground-lighter">
              {s3 ? (
                <>
                  Each backup is copied to{' '}
                  <code className="font-mono text-foreground-light">{s3.location}</code> at{' '}
                  {s3.endpoint}
                  {s3.keep_local
                    ? ', and kept on the Supermixer server too.'
                    : '; once copied, it’s removed from the Supermixer server.'}
                </>
              ) : (
                <>
                  Backups are only on the Supermixer server. Set provisioning.backup_s3 to copy them
                  to an S3-compatible bucket as well.
                </>
              )}
            </span>
          </span>
          <WithReason reason={allowed ? cantBackUp : null}>
            <PermissionButton
              allowed={allowed}
              action="back up this project"
              variant="primary"
              disabled={!!cantBackUp}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Back up now
            </PermissionButton>
          </WithReason>
        </Card>
        {s.operation === 'restoring' && (
          <Alert variant="warning" title="Restoring a backup">
            The database is offline until the restore finishes. Progress is on Settings ›
            Infrastructure.
          </Alert>
        )}
        {s.error && !busy && (
          <Alert variant={running ? 'warning' : 'destructive'} title={s.error.split('\n')[0]!} />
        )}
      </SettingsSection>

      <SettingsSection title="Backups" description="Newest first.">
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Taken</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Postgres</TableHead>
                {showStored && <TableHead>Stored</TableHead>}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={showStored ? 7 : 6}
                    className="py-8 text-center text-foreground-lighter"
                  >
                    No backups yet
                  </TableCell>
                </TableRow>
              ) : (
                backups.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground">{new Date(b.started_at).toLocaleString()}</span>
                        <span className="text-xs text-foreground-lighter">
                          {relativeTime(b.started_at)}
                          {b.created_by && <> · by {b.created_by}</>}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">{KIND_LABELS[b.kind]}</TableCell>
                    <TableCell>
                      <StatusBadge backup={b} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-foreground-light">
                      {b.status === 'completed' ? formatBytes(b.size_bytes) : '–'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-foreground-light">
                      {b.postgres_version || '–'}
                    </TableCell>
                    {showStored && (
                      <TableCell>
                        <StoredBadges backup={b} s3={!!s3} />
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      {b.status !== 'running' && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="text"
                              size="tiny"
                              icon={<MoreIcon />}
                              aria-label={`Actions for the backup of ${new Date(b.started_at).toLocaleString()}`}
                            />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            {b.status === 'completed' && (
                              <>
                                {unreadable(b, s3) && (
                                  <>
                                    <DropdownMenuLabel className="text-xs font-normal text-warning-600">
                                      {unreadable(b, s3)}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                  </>
                                )}
                                <DropdownMenuItem
                                  disabled={!allowed || !!cantBackUp || !!unreadable(b, s3)}
                                  onSelect={() => setRestoring(b)}
                                >
                                  Restore to this project…
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!allowed || !!unreadable(b, s3)}
                                  onSelect={() => {
                                    setCopyName(`${project.name} (restored)`)
                                    setCopying(b)
                                  }}
                                >
                                  Restore to a new project…
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-xs text-foreground-lighter">
                                  Download
                                </DropdownMenuLabel>
                                {FILES.map((f) => (
                                  <DropdownMenuItem
                                    key={f}
                                    disabled={!allowed || !!unreadable(b, s3)}
                                    asChild={allowed && !unreadable(b, s3)}
                                  >
                                    {allowed && !unreadable(b, s3) ? (
                                      <a
                                        href={`/api/v1/projects/${ref}/backups/${b.id}/files/${f}`}
                                        download
                                        className="font-mono text-xs"
                                      >
                                        {f}
                                      </a>
                                    ) : (
                                      <span className="font-mono text-xs">{f}</span>
                                    )}
                                  </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                {s3 && !b.remote && b.upload_error && (
                                  <>
                                    <DropdownMenuItem
                                      disabled={!allowed}
                                      onSelect={() => retryUpload.mutate(b.id)}
                                    >
                                      Copy to the bucket again
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                  </>
                                )}
                              </>
                            )}
                            <DropdownMenuItem
                              disabled={!allowed || s.operation === 'restoring'}
                              className="text-destructive"
                              onSelect={() => setDeleting(b)}
                            >
                              Delete…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
        <p className="text-xs text-foreground-lighter">
          To restore a download elsewhere, as Supabase documents:{' '}
          <code className="font-mono">
            psql --single-transaction -v ON_ERROR_STOP=1 -f roles.sql -f schema.sql -f data.sql
          </code>
          . The Vault's secrets aren't included, and roles that log in need their passwords set again.
        </p>
      </SettingsSection>

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        variant="warning"
        title="Restore this backup to the project?"
        description={
          restoring && (
            <>
              The database is replaced with the backup of{' '}
              {new Date(restoring.started_at).toLocaleString()}; changes since then are lost.
              Supermixer backs the current database up first, and the project is offline while it
              restores. If the restore fails, the project goes back to its current database.
            </>
          )
        }
        confirmLabel="Restore"
        confirmText={project.name}
        loading={restore.isPending}
        onConfirm={() => restoring && restore.mutate(restoring.id)}
      />

      <ConfirmDialog
        open={copying !== null}
        onOpenChange={(o) => !o && setCopying(null)}
        variant="primary"
        title="Restore to a new project"
        description="Supermixer creates a new stack in this organization, with its own keys, and restores the backup into it. This project isn't changed."
        confirmLabel="Create project"
        loading={restoreToNew.isPending}
        onConfirm={() => {
          if (copying && copyName.trim()) restoreToNew.mutate({ id: copying.id, name: copyName.trim() })
        }}
      >
        <FormField label="Name" htmlFor="restore-name">
          <Input id="restore-name" value={copyName} onChange={(e) => setCopyName(e.target.value)} />
        </FormField>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this backup?"
        description={deleting && deleteText(deleting, s3)}
        confirmLabel="Delete backup"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  )
}

function StatusBadge({ backup }: { backup: Backup }) {
  if (backup.status === 'running') return <Badge variant="warning">Running…</Badge>
  if (backup.status === 'completed') return <Badge variant="success">Completed</Badge>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Badge variant="destructive">Failed</Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{backup.error || 'Failed'}</TooltipContent>
    </Tooltip>
  )
}

type S3 = Schemas['BackupList']['s3']

/** The bucket in an s3://bucket/... location. */
function bucketOf(location: string): string {
  return location.replace(/^s3:\/\//, '').split('/')[0] ?? ''
}

/** Why Supermixer can't read a backup's files, if it can't: they're only in a bucket it isn't set up for. */
function unreadable(b: Backup, s3: S3): string | null {
  if (b.local) return null
  if (!b.remote) return 'The backup’s files are missing.'
  const bucket = bucketOf(b.remote)
  if (!s3)
    return `The backup is only in bucket ${bucket}, and Supermixer isn’t set up for a bucket.`
  const current = bucketOf(s3.location)
  return bucket === current
    ? null
    : `The backup is only in bucket ${bucket}, and Supermixer is set up for bucket ${current}.`
}

/** What deleting a backup removes, from where it is. */
function deleteText(b: Backup, s3: S3): string {
  const parts: string[] = []
  if (b.local) parts.push('Its files are removed from the Supermixer server.')
  if (b.remote) {
    const bucket = bucketOf(b.remote)
    parts.push(
      s3 && bucketOf(s3.location) === bucket
        ? `Its copy in bucket ${bucket} is removed too (later, if Supermixer can’t reach the bucket right now).`
        : `Its copy in bucket ${bucket} is removed once Supermixer is set up for that bucket again.`
    )
  }
  return [...parts, 'This can’t be undone.'].join(' ')
}

/** Whether a backup is waiting to be copied to the bucket. */
function uploading(b: Backup, s3: boolean): boolean {
  return s3 && b.status === 'completed' && b.local && !b.remote && !b.upload_error
}

/** Where a completed backup's files are: the Supermixer server, the bucket. */
function StoredBadges({ backup: b, s3 }: { backup: Backup; s3: boolean }) {
  if (b.status !== 'completed') return <span className="text-foreground-lighter">–</span>
  return (
    <span className="flex flex-wrap gap-1">
      {b.local && <Badge>Server</Badge>}
      {b.remote ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Badge variant="success">S3</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-md font-mono text-xs">{b.remote}</TooltipContent>
        </Tooltip>
      ) : b.upload_error ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Badge variant="warning">S3 copy failed</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            {b.upload_error.replace(/\.+$/, '')}.{' '}
            {s3
              ? 'Supermixer tries again on its own, waiting longer each time.'
              : 'Backups aren’t copied to a bucket any more, so it won’t be tried again.'}
          </TooltipContent>
        </Tooltip>
      ) : (
        uploading(b, s3) && <Badge variant="warning">Copying to S3…</Badge>
      )}
    </span>
  )
}

/** A tooltip saying why a button is disabled. */
function WithReason({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  if (!reason) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

function formatInterval(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? 'day' : `${hours / 24} days`
  return hours === 1 ? 'hour' : `${hours} hours`
}
