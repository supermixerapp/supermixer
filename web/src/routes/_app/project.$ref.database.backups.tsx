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
import { localized, t, Trans, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/backups')({
  component: BackupsPage,
})

type Backup = Schemas['Backup']

const KIND_LABELS = localized((): Record<Backup['kind'], string> => ({
  scheduled: t('database:databaseBackups.scheduled'),
  manual: t('database:databaseBackups.manual'),
  pre_restore: t('database:databaseBackups.beforeARestore'),
  pre_upgrade: t('database:databaseBackups.beforeAnUpgrade'),
}))

const FILES = ['roles.sql', 'schema.sql', 'data.sql'] as const

function BackupsPage() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader
        title={t('database:databaseBackups.backups')}
        description={t('database:databaseBackups.databaseBackupsInTheFormatOf')}
      />
      <PageContainer className="flex flex-col gap-10 pb-16">
        {!project ? null : project.stack ? (
          <ManagedBackups project={project} />
        ) : (
          <Alert title={t('database:databaseBackups.supermixerConnectsToThisStackIt')}>
            {t('database:databaseBackups.backItsDatabaseUpWhereIt')}
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
    onSuccess: () => toast.success(t('database:databaseBackups.backingUpTheDatabase')),
    onError: (e) => toast.error(e.message),
    onSettled: refresh,
  })
  const [deleting, setDeleting] = useState<Backup | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/projects/{ref}/backups/{id}', { params: { path: { ref, id } } })),
    onSuccess: () => toast.success(t('database:databaseBackups.backupDeleted')),
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
    onSuccess: () => toast.success(t('database:databaseBackups.restoringTheProjectIsOfflineUntil')),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setRestoring(null)
      refresh()
    },
  })
  const retryUpload = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/projects/{ref}/backups/{id}/upload', { params: { path: { ref, id } } })),
    onSuccess: () => toast.success(t('database:databaseBackups.copyingTheBackupToTheBucket')),
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
      toast.success(t('database:databaseBackups.creatingFromTheBackup', { name: p.name }))
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
    ? t('database:databaseBackups.startTheStackToBackIt')
    : busy
      ? t('database:databaseBackups.theStackIsBusyWaitFor')
      : null

  return (
    <>
      <SettingsSection
        title={t('database:databaseBackups.schedule')}
        description={t('database:databaseBackups.setByTheSupermixerServerS')}
      >
        <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
          <span className="flex flex-col gap-1.5 text-foreground-light">
            <span>
              {interval_hours > 0 ? (
                <>
                  {t('database:databaseBackups.backedUpEveryWhileRunningThe', { interval: formatInterval(interval_hours), keep })}
                </>
              ) : (
                <>{t('database:databaseBackups.scheduledBackupsAreOffManualBackups')}</>
              )}
            </span>
            <span className="text-xs text-foreground-lighter">
              {s3 ? (
                <>
                  <Trans
                    i18nKey={s3.keep_local ? 'database:databaseBackups.copiedToAndKept' : 'database:databaseBackups.copiedToAndRemoved'}
                    values={{ location: s3.location, endpoint: s3.endpoint }}
                    components={{ code: <code className="font-mono text-foreground-light" /> }}
                  />
                </>
              ) : (
                <>
                  {t('database:databaseBackups.backupsAreOnlyOnTheSupermixer')}
                </>
              )}
            </span>
          </span>
          <WithReason reason={allowed ? cantBackUp : null}>
            <PermissionButton
              allowed={allowed}
              action={t('database:databaseBackups.backUpThisProject')}
              variant="primary"
              disabled={!!cantBackUp}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('database:databaseBackups.backUpNow')}
            </PermissionButton>
          </WithReason>
        </Card>
        {s.operation === 'restoring' && (
          <Alert variant="warning" title={t('database:databaseBackups.restoringABackup')}>
            {t('database:databaseBackups.theDatabaseIsOfflineUntilThe')}
          </Alert>
        )}
        {s.error && !busy && (
          <Alert variant={running ? 'warning' : 'destructive'} title={s.error.split('\n')[0]!} />
        )}
      </SettingsSection>

      <SettingsSection title={t('database:databaseBackups.backups')} description={t('database:databaseBackups.newestFirst')}>
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('database:databaseBackups.taken')}</TableHead>
                <TableHead>{t('database:databaseBackups.kind')}</TableHead>
                <TableHead>{t('database:databaseBackups.status')}</TableHead>
                <TableHead className="text-right">{t('database:databaseBackups.size')}</TableHead>
                <TableHead>Postgres</TableHead>
                {showStored && <TableHead>{t('database:databaseBackups.stored')}</TableHead>}
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
                    {t('database:databaseBackups.noBackupsYet')}
                  </TableCell>
                </TableRow>
              ) : (
                backups.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground">{new Date(b.started_at).toLocaleString(language())}</span>
                        <span className="text-xs text-foreground-lighter">
                          {relativeTime(b.started_at)}
                          {b.created_by && <> {t('database:databaseBackups.by', { createdBy: b.created_by })}</>}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">{KIND_LABELS()[b.kind]}</TableCell>
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
                              aria-label={t('database:databaseBackups.actionsForTheBackupOf', { value: new Date(b.started_at).toLocaleString(language()) })}
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
                                  {t('database:databaseBackups.restoreToThisProject')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!allowed || !!unreadable(b, s3)}
                                  onSelect={() => {
                                    setCopyName(t('database:databaseBackups.restored', { name: project.name }))
                                    setCopying(b)
                                  }}
                                >
                                  {t('database:databaseBackups.restoreToANewProject')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-xs text-foreground-lighter">
                                  {t('database:databaseBackups.download')}
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
                                      {t('database:databaseBackups.copyToTheBucketAgain')}
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
                              {t('database:databaseBackups.delete')}
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
          <Trans i18nKey="database:databaseBackups.toRestoreADownloadElsewhereAs" components={{ code: <code className="font-mono" /> }} />
        </p>
      </SettingsSection>

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        variant="warning"
        title={t('database:databaseBackups.restoreThisBackupToTheProject')}
        description={
          restoring && (
            <>
              {t('database:databaseBackups.theDatabaseIsReplacedWithThe', { value: new Date(restoring.started_at).toLocaleString(language()) })}
            </>
          )
        }
        confirmLabel={t('database:databaseBackups.restore')}
        confirmText={project.name}
        loading={restore.isPending}
        onConfirm={() => restoring && restore.mutate(restoring.id)}
      />

      <ConfirmDialog
        open={copying !== null}
        onOpenChange={(o) => !o && setCopying(null)}
        variant="primary"
        title={t('database:databaseBackups.restoreToANewProject2')}
        description={t('database:databaseBackups.supermixerCreatesANewStackIn')}
        confirmLabel={t('database:databaseBackups.createProject')}
        loading={restoreToNew.isPending}
        onConfirm={() => {
          if (copying && copyName.trim()) restoreToNew.mutate({ id: copying.id, name: copyName.trim() })
        }}
      >
        <FormField label={t('database:databaseBackups.name')} htmlFor="restore-name">
          <Input id="restore-name" value={copyName} onChange={(e) => setCopyName(e.target.value)} />
        </FormField>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('database:databaseBackups.deleteThisBackup')}
        description={deleting && deleteText(deleting, s3)}
        confirmLabel={t('database:databaseBackups.deleteBackup')}
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  )
}

function StatusBadge({ backup }: { backup: Backup }) {
  if (backup.status === 'running') return <Badge variant="warning">{t('database:databaseBackups.running')}</Badge>
  if (backup.status === 'completed') return <Badge variant="success">{t('database:databaseBackups.completed')}</Badge>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Badge variant="destructive">{t('database:databaseBackups.failed')}</Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{backup.error || t('database:databaseBackups.failed')}</TooltipContent>
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
  if (!b.remote) return t('database:databaseBackups.theBackupSFilesAreMissing')
  const bucket = bucketOf(b.remote)
  if (!s3)
    return t('database:databaseBackups.theBackupIsOnlyInBucket', { bucket })
  const current = bucketOf(s3.location)
  return bucket === current
    ? null
    : t('database:databaseBackups.theBackupIsOnlyInBucket2', { bucket, current })
}

/** What deleting a backup removes, from where it is. */
function deleteText(b: Backup, s3: S3): string {
  const parts: string[] = []
  if (b.local) parts.push(t('database:databaseBackups.itsFilesAreRemovedFromThe'))
  if (b.remote) {
    const bucket = bucketOf(b.remote)
    parts.push(
      s3 && bucketOf(s3.location) === bucket
        ? t('database:databaseBackups.itsCopyInBucketIsRemoved', { bucket })
        : t('database:databaseBackups.itsCopyInBucketIsRemoved2', { bucket })
    )
  }
  return [...parts, t('database:databaseBackups.thisCanTBeUndone')].join(' ')
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
      {b.local && <Badge>{t('database:databaseBackups.server')}</Badge>}
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
              <Badge variant="warning">{t('database:databaseBackups.s3CopyFailed')}</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            {b.upload_error.replace(/\.+$/, '')}.{' '}
            {s3
              ? t('database:databaseBackups.supermixerTriesAgainOnItsOwn')
              : t('database:databaseBackups.backupsArenTCopiedToA')}
          </TooltipContent>
        </Tooltip>
      ) : (
        uploading(b, s3) && <Badge variant="warning">{t('database:databaseBackups.copyingToS3')}</Badge>
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
  if (hours % 24 === 0) return hours === 24 ? 'day' : t('database:databaseBackups.days', { hours: hours / 24 })
  return hours === 1 ? 'hour' : t('database:databaseBackups.hours', { hours })
}
