/*
 * Advisors › Changes: what changed in the database since a snapshot, among
 * the objects that could let someone back in after a suspect deploy or
 * after they lose access (roles, SECURITY DEFINER functions, triggers,
 * event triggers, cron jobs, Auth users' passwords and roles).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { DatabasePage } from '@/components/database/catalog-page'
import { RefreshIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { t, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/advisors/changes')({
  component: ChangesPage,
})

type Snapshot = Schemas['DBSnapshot']
type Change = Schemas['DBChange']

const describe = (s: Snapshot) =>
  `${new Date(s.taken_at).toLocaleString(language())} · ${
    s.reason === 'function_deploy'
      ? t('observability:advisorsChanges.beforeDeploying', { name: s.detail })
      : s.taken_by
        ? t('observability:advisorsChanges.takenBy', { name: s.taken_by })
        : t('observability:advisorsChanges.takenBySomeone')
  }`

function ChangesPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const queryClient = useQueryClient()
  const allowed = !!project && can(project, 'project:secrets:read')
  const canTake = !!project && can(project, 'project:update')
  const snapshots = useQuery({
    queryKey: ['projects', ref, 'db-snapshots'],
    queryFn: () => unwrap(api.GET('/projects/{ref}/advisors/snapshots', { params: { path: { ref } } })),
    enabled: allowed,
  })
  const [picked, setPicked] = useState<string | null>(null)
  const since = picked ?? snapshots.data?.[0]?.id ?? null
  const changes = useQuery({
    queryKey: ['projects', ref, 'db-changes', since],
    queryFn: () =>
      unwrap(api.GET('/projects/{ref}/advisors/changes', { params: { path: { ref }, query: { since: since! } } })),
    enabled: allowed && !!since,
    staleTime: 60_000,
  })
  const take = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/advisors/snapshots', { params: { path: { ref } } })),
    onSuccess: (s) => {
      toast.success(t('observability:advisorsChanges.snapshotTaken'))
      setPicked(s.id)
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'db-snapshots'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const takeButton = (
    <PermissionButton
      allowed={canTake}
      action={t('observability:advisorsChanges.takeSnapshotsOfThisProjectS')}
      variant={snapshots.data?.length ? 'default' : 'primary'}
      loading={take.isPending}
      onClick={() => take.mutate()}
    >
      {t('observability:advisorsChanges.takeSnapshot')}
    </PermissionButton>
  )
  return (
    <DatabasePage
      title={t('observability:advisorsChanges.changes')}
      description={t('observability:advisorsChanges.afterASuspectFunctionDeployOr')}
      actions={
        <>
          {since && (
            <Button
              variant="default"
              icon={<RefreshIcon />}
              loading={changes.isFetching}
              onClick={() => void changes.refetch()}
            >
              {t('observability:advisorsChanges.compareAgain')}
            </Button>
          )}
          {takeButton}
        </>
      }
    >
      {!project ? null : !allowed ? (
        <Alert title={t('observability:advisorsChanges.youNeedAccessToThisProject')} />
      ) : snapshots.error ? (
        <Alert variant="destructive" title={snapshots.error.message} />
      ) : !snapshots.data ? (
        <Skeleton className="h-40" />
      ) : snapshots.data.length === 0 ? (
        <Card className="flex flex-col items-start gap-3 px-6 py-8 text-sm text-foreground-light">
          <p className="text-foreground">{t('observability:advisorsChanges.noSnapshotYet')}</p>
          <p>
            {t('observability:advisorsChanges.aSnapshotRecordsFingerprintsOfThe')}
          </p>
          {takeButton}
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-foreground-lighter">{t('observability:advisorsChanges.compareWithTheSnapshotOf')}</span>
            <Select value={since ?? undefined} onValueChange={setPicked}>
              <SelectTrigger className="w-auto min-w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {snapshots.data.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {describe(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {changes.error ? (
            <Alert variant="destructive" title={changes.error.message} />
          ) : !changes.data ? (
            <Skeleton className="h-64" />
          ) : (
            <Results data={changes.data} />
          )}
        </div>
      )}
    </DatabasePage>
  )
}

function Results({ data }: { data: Schemas['DBChanges'] }) {
  const total = data.categories.reduce((n, c) => n + c.added.length + c.removed.length + c.changed.length, 0)
  return (
    <>
      <p className="text-sm text-foreground-light">
        {total === 0
          ? t('observability:advisorsChanges.nothingChangedSinceThisSnapshot', { relativeTime: relativeTime(data.since.taken_at) })
          : t('observability:advisorsChanges.sinceThisSnapshotCheckThatEach', { count: total, relativeTime: relativeTime(data.since.taken_at) })}
      </p>
      {!data.superuser && (
        <Alert title={t('observability:advisorsChanges.readAsTheProjectSDatabase')}>
          {t('observability:advisorsChanges.changesToRolePasswordsAndCron')}
        </Alert>
      )}
      {data.categories.map((c) => (
        <Card key={c.name} className="flex flex-col text-sm">
          <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
            <span className="text-foreground">{c.label}</span>
            <span className="flex gap-1">
              {c.skipped ? (
                <span className="text-xs text-foreground-lighter">{t('observability:advisorsChanges.notCompared')}</span>
              ) : c.added.length + c.removed.length + c.changed.length === 0 ? (
                <span className="text-xs text-foreground-lighter">{t('observability:advisorsChanges.noChanges')}</span>
              ) : (
                <>
                  {c.added.length > 0 && <Badge variant="warning">{t('observability:advisorsChanges.added', { length: c.added.length })}</Badge>}
                  {c.changed.length > 0 && <Badge variant="warning">{t('observability:advisorsChanges.changed', { length: c.changed.length })}</Badge>}
                  {c.removed.length > 0 && <Badge>{t('observability:advisorsChanges.removed', { length: c.removed.length })}</Badge>}
                </>
              )}
            </span>
          </div>
          {c.skipped ? (
            <p className="px-5 py-3 text-xs text-foreground-lighter">{c.skipped}</p>
          ) : (
            <ul className="flex flex-col divide-y empty:hidden">
              {c.added.map((ch) => (
                <ChangeRow key={`a-${ch.key}`} kind="Added" change={ch} />
              ))}
              {c.changed.map((ch) => (
                <ChangeRow key={`c-${ch.key}`} kind="Changed" change={ch} />
              ))}
              {c.removed.map((ch) => (
                <ChangeRow key={`r-${ch.key}`} kind="Removed" change={ch} />
              ))}
            </ul>
          )}
        </Card>
      ))}
    </>
  )
}

function ChangeRow({ kind, change }: { kind: string; change: Change }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="flex flex-col gap-2 px-5 py-2.5">
      <button type="button" className="flex items-center gap-3 text-left" onClick={() => setOpen(!open)}>
        <span className="w-16 shrink-0 text-xs text-foreground-lighter">{kind}</span>
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{change.key}</span>
        {change.label && <span className="text-xs text-foreground-light">{change.label}</span>}
        <span className="text-xs text-foreground-lighter">{open ? t('observability:advisorsChanges.hide') : t('observability:advisorsChanges.details')}</span>
      </button>
      {open && (
        <div className="grid gap-2 md:grid-cols-2">
          {[
            [t('observability:advisorsChanges.inTheSnapshot'), change.before],
            [t('observability:advisorsChanges.now'), change.after],
          ].map(([label, value]) => (
            <div key={label as string} className="flex flex-col gap-1">
              <span className="text-xs text-foreground-lighter">{label as string}</span>
              <pre className="overflow-x-auto rounded-md border bg-surface-100 p-2 font-mono text-xs text-foreground">
                {value === undefined || value === null ? '—' : JSON.stringify(value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}
