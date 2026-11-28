/*
 * Instance › Projects: every project on the instance, for reports on how
 * it's used. Read-only, and metadata only: listing a project gives no access
 * to it, which stays with its organization's members.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { FilterSelect, ReportToolbar, Stat, today } from '@/components/admin/report-parts'
import { AdminLayout } from '@/components/layout/admin-layout'
import { OPERATION_LABELS, STACK_STATUS, StackBadge } from '@/components/project/stack'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { formatBytes } from '@/lib/storage-api'
import { inEnglish, language, localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/admin/projects')({
  component: ProjectsPage,
})

type Project = Schemas['InstanceProject']

const DAY = 24 * 60 * 60 * 1000

// As the table shows it: what Supermixer is doing to the stack, if anything,
// else its state.
const statusLabel = (p: Project) =>
  (p.operation ? OPERATION_LABELS()[p.operation] : p.status ? STACK_STATUS()[p.status].label : t('admin:adminProjects.connected')).replace('…', '')
const busy = (p: Project) => !!p.operation || p.status === 'provisioning' || p.status === 'deleting'

// The state filter: the stack's state, or the backups'.
const STATES = localized((): { value: string; label: string; match: (p: Project) => boolean }[] => [
  { value: 'all', label: t('admin:adminProjects.all'), match: () => true },
  { value: 'running', label: t('admin:adminProjects.running'), match: (p) => p.status === 'running' && !p.operation },
  { value: 'paused', label: t('admin:adminProjects.paused'), match: (p) => p.status === 'paused' },
  { value: 'failed', label: t('admin:adminProjects.failed'), match: (p) => p.status === 'failed' },
  { value: 'busy', label: t('admin:adminProjects.beingCreatedChangedOrDeleted'), match: busy },
  { value: 'connected', label: t('admin:adminProjects.connected'), match: (p) => !p.managed },
  { value: 'backup-failed', label: t('admin:adminProjects.lastBackupFailed'), match: (p) => p.last_backup?.status === 'failed' },
  {
    value: 'no-backup',
    label: t('admin:adminProjects.noBackupIn7Days'),
    match: (p) =>
      p.managed &&
      !(p.last_completed_backup_at && Date.now() - new Date(p.last_completed_backup_at).getTime() < 7 * DAY),
  },
])

function ProjectsPage() {
  const { data: me } = useProfile()
  const list = useQuery({
    queryKey: ['admin', 'projects'],
    queryFn: () => unwrap(api.GET('/admin/projects')),
    enabled: !!me?.is_instance_admin,
  })
  const [search, setSearch] = useState('')
  const [org, setOrg] = useState('all')
  const [state, setState] = useState('all')
  const all = list.data ?? []
  const orgs = [...new Map(all.map((p) => [p.organization_slug, p.organization_name])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1])
  )
  const needle = search.trim().toLowerCase()
  const stateMatch = (STATES().find((s) => s.value === state) ?? STATES()[0]).match
  const shown = all.filter(
    (p) =>
      stateMatch(p) &&
      (org === 'all' || p.organization_slug === org) &&
      (!needle ||
        [p.name, p.ref, p.organization_name, p.organization_slug, p.created_by ?? ''].some((s) =>
          s.toLowerCase().includes(needle)
        ))
  )
  const filtering = needle !== '' || org !== 'all' || state !== 'all'
  const managed = all.filter((p) => p.managed)
  const count = (s: Project['status']) => all.filter((p) => p.status === s && !p.operation).length
  const backupBytes = all.reduce((n, p) => n + p.backup_bytes, 0)

  return (
    <AdminLayout
      title={t('admin:adminProjects.projects')}
      description={t('admin:adminProjects.everyProjectOnThisInstanceFor')}
    >
      {list.isError ? (
        <Alert variant="destructive" title={list.error.message} />
      ) : list.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label={t('admin:adminProjects.projects')} value={all.length} detail={t('admin:adminProjects.createdBySupermixer', { length: managed.length })} />
            <Stat label={t('admin:adminProjects.running')} value={count('running')} detail={t('admin:adminProjects.ofCreatedBySupermixer', { length: managed.length })} />
            <Stat label={t('admin:adminProjects.paused')} value={count('paused')} />
            <Stat label={t('admin:adminProjects.failed')} value={count('failed')} />
            <Stat
              label={t('admin:adminProjects.backupsKept')}
              value={formatBytes(backupBytes)}
              detail={t('admin:adminProjects.backupsCompressed', { reduce: all.reduce((n, p) => n + p.backups, 0) })}
            />
          </div>
          <ReportToolbar
            search={search}
            onSearch={setSearch}
            placeholder={t('admin:adminProjects.searchProjects')}
            filters={
              <>
                <FilterSelect
                  label={t('admin:adminProjects.organization')}
                  value={org}
                  onChange={setOrg}
                  choices={[{ value: 'all', label: t('admin:adminProjects.all') }, ...orgs.map(([value, label]) => ({ value, label }))]}
                />
                <FilterSelect label={t('admin:adminProjects.state')} value={state} onChange={setState} choices={STATES()} />
              </>
            }
            shown={shown.length}
            total={all.length}
            noun="projects"
            filtering={filtering}
            onClear={() => {
              setSearch('')
              setOrg('all')
              setState('all')
            }}
            csv={{
              name: `supermixer-projects-${today()}.csv`,
              header: inEnglish(() => [
                t('admin:adminProjects.project'),
                t('admin:adminProjects.ref'),
                t('admin:adminProjects.organization'),
                t('admin:adminProjects.organizationSlug'),
                t('admin:adminProjects.state'),
                t('admin:adminProjects.supabaseVersion'),
                t('admin:adminProjects.created'),
                t('admin:adminProjects.createdBy'),
                t('admin:adminProjects.lastBackup'),
                t('admin:adminProjects.lastBackupStatus'),
                t('admin:adminProjects.lastCompletedBackup'),
                t('admin:adminProjects.backupsKept'),
                t('admin:adminProjects.backupBytes'),
              ]),
              rows: () =>
                inEnglish(() =>
                  shown.map((p) => [
                    p.name,
                    p.ref,
                    p.organization_name,
                    p.organization_slug,
                    statusLabel(p),
                    p.template ?? '',
                    p.created_at,
                    p.created_by ?? '',
                    p.last_backup?.started_at ?? '',
                    p.last_backup?.status ?? '',
                    p.last_completed_backup_at ?? '',
                    p.backups,
                    p.backup_bytes,
                  ]),
                ),
            }}
          />
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('admin:adminProjects.project')}</TableHead>
                  <TableHead>{t('admin:adminProjects.organization')}</TableHead>
                  <TableHead>{t('admin:adminProjects.state')}</TableHead>
                  <TableHead>{t('admin:adminProjects.created')}</TableHead>
                  <TableHead>{t('admin:adminProjects.lastBackup')}</TableHead>
                  <TableHead className="text-right">{t('admin:adminProjects.backupsKept')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="py-10 text-center text-foreground-lighter">
                      {all.length === 0 ? t('admin:adminProjects.noProjectsYet') : t('admin:adminProjects.noProjectsMatchTheseFilters')}
                    </TableCell>
                  </TableRow>
                )}
                {shown.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground">{p.name}</span>
                        <span className="font-mono text-xs text-foreground-lighter">{p.ref}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground-light">{p.organization_name}</span>
                        <span className="text-xs text-foreground-lighter">{p.organization_slug}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        {p.status ? (
                          <StackBadge stack={{ status: p.status, operation: p.operation }} />
                        ) : (
                          <Badge title={t('admin:adminProjects.supermixerConnectsToItItRuns')}>{t('admin:adminProjects.connected')}</Badge>
                        )}
                        {p.template && (
                          <span className="font-mono text-xs text-foreground-lighter" title={p.template}>
                            {p.template.slice(0, 7)}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      <span className="flex flex-col">
                        <span title={new Date(p.created_at).toLocaleString(language())}>{relativeTime(p.created_at)}</span>
                        {p.created_by && <span className="text-xs text-foreground-lighter">{t('admin:adminProjects.by', { createdBy: p.created_by })}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {p.last_backup ? (
                        <span className="flex flex-col items-start gap-1">
                          <span title={new Date(p.last_backup.started_at).toLocaleString(language())}>
                            {relativeTime(p.last_backup.started_at)}
                          </span>
                          {p.last_backup.status === 'failed' && <Badge variant="destructive">{t('admin:adminProjects.failed')}</Badge>}
                          {p.last_backup.status === 'running' && <Badge variant="warning">{t('admin:adminProjects.running')}</Badge>}
                        </span>
                      ) : (
                        <span className="text-foreground-lighter">{p.managed ? t('admin:adminProjects.noneYet') : '—'}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-foreground-light tabular-nums">
                      {p.backups > 0 ? (
                        <span className="flex flex-col items-end">
                          <span>{formatBytes(p.backup_bytes)}</span>
                          <span className="text-xs text-foreground-lighter">
                            {t('admin:adminProjects.backups', { count: p.backups })}
                          </span>
                        </span>
                      ) : (
                        <span className="text-foreground-lighter">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </AdminLayout>
  )
}
