/*
 * Database › Backups for stacks Supermixer created (Stage 4.4): Supabase-style
 * dumps (roles, schema, data) on Supermixer's server, taken on a schedule or
 * on demand, restored into this project or a new one.
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
    refetchInterval: (q) =>
      q.state.data?.backups.some((b) => b.status === 'running') ? 2000 : 30000,
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
  const { backups, interval_hours, keep } = list.data
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
        description="Set by the Supermixer server's configuration (provisioning.backup_interval and backup_keep)."
      >
        <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
          <span className="text-foreground-light">
            {interval_hours > 0 ? (
              <>
                Backed up every {formatInterval(interval_hours)} while running; the newest {keep}{' '}
                scheduled backups are kept. Manual backups are kept until you delete them.
              </>
            ) : (
              <>Scheduled backups are off. Manual backups are kept until you delete them.</>
            )}
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

      <SettingsSection title="Backups" description="Newest first, stored on the Supermixer server.">
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Taken</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Postgres</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-8 text-center text-foreground-lighter">
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
                                <DropdownMenuItem
                                  disabled={!allowed || !!cantBackUp}
                                  onSelect={() => setRestoring(b)}
                                >
                                  Restore to this project…
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!allowed}
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
                                  <DropdownMenuItem key={f} disabled={!allowed} asChild={allowed}>
                                    {allowed ? (
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
        description="Its files are removed from the Supermixer server. This can't be undone."
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
