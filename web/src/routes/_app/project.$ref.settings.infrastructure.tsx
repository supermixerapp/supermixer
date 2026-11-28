import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import {
  ACTION_LABELS,
  StackBadge,
  StackLog,
  stackActions,
  stackQuery,
  useStackAction,
  useStackSync,
} from '@/components/project/stack'
import { StackUpgrade } from '@/components/project/upgrade'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CopyField } from '@/components/ui/copy'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { uiConfigQuery } from '@/lib/api/queries'
import { relativeTime } from '@/lib/auth-users'
import { localized, t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/settings/infrastructure')({
  component: InfrastructurePage,
})

function InfrastructurePage() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader title={t('project:settingsInfrastructure.infrastructure')} size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        {!project ? null : project.stack ? (
          <ManagedStack project={project} projectRef={project.ref} allowed={can(project, 'project:update')} />
        ) : (
          <Alert title={t('project:settingsInfrastructure.supermixerConnectsToThisStackIt')}>
            {t('project:settingsInfrastructure.itsContainersPortsAndUpgradesAre')}
          </Alert>
        )}
      </PageContainer>
    </>
  )
}

function ManagedStack({ project, projectRef, allowed }: { project: Schemas['Project']; projectRef: string; allowed: boolean }) {
  const stack = useQuery(stackQuery(projectRef))
  useStackSync(projectRef, stack.data)
  const act = useStackAction(projectRef)
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)
  const s = stack.data

  if (stack.error) return <Alert variant="destructive" title={stack.error.message} />
  if (!s) return <Skeleton className="h-64" />
  const actions = stackActions(s)

  return (
    <>
      <SettingsSection
        title={t('project:settingsInfrastructure.stack')}
        description={t('project:settingsInfrastructure.supermixerCreatedThisStackAndRuns')}
      >
        <Card className="flex flex-col divide-y text-sm">
          <Row label={t('project:settingsInfrastructure.status')}>
            <span className="flex items-center gap-2">
              <StackBadge stack={s} />
              {s.status_at && (
                <span className="text-xs text-foreground-lighter">
                  {t('project:settingsInfrastructure.since', { relativeTime: relativeTime(s.status_at) })}
                </span>
              )}
            </span>
          </Row>
          <Row label={t('project:settingsInfrastructure.supabase')}>
            <a
              href={`https://github.com/supabase/supabase/tree/${s.template}/docker`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs text-foreground-light hover:text-foreground"
              title={s.template}
            >
              {t('project:settingsInfrastructure.supabaseDocker', { slice: s.template.slice(0, 7) })}
            </a>
          </Row>
          <Row label={t('project:settingsInfrastructure.ports')}>
            <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-foreground-light">
              <span>{t('project:settingsInfrastructure.api', { api: s.ports.api })}</span>
              <span>{t('project:settingsInfrastructure.postgres', { db: s.ports.db })}</span>
              <span>{t('project:settingsInfrastructure.poolerTransaction', { pooler: s.ports.pooler })}</span>
            </span>
          </Row>
          <div className="flex items-center justify-end gap-2 px-5 py-3">
            {actions.includes('start') && (
              <PermissionButton
                allowed={allowed}
                action={t('project:settingsInfrastructure.startThisStack')}
                variant="primary"
                loading={act.isPending}
                onClick={() => act.mutate('start')}
              >
                {s.status === 'failed' ? t('project:settingsInfrastructure.tryAgain') : ACTION_LABELS().start}
              </PermissionButton>
            )}
            {actions.includes('restart') && (
              <PermissionButton
                allowed={allowed}
                action={t('project:settingsInfrastructure.restartThisStack')}
                variant="default"
                onClick={() => setConfirm('restart')}
              >
                {ACTION_LABELS().restart}
              </PermissionButton>
            )}
            {actions.includes('stop') && (
              <PermissionButton
                allowed={allowed}
                action={t('project:settingsInfrastructure.pauseThisStack')}
                variant="warning"
                onClick={() => setConfirm('stop')}
              >
                {ACTION_LABELS().stop}
              </PermissionButton>
            )}
            {actions.length === 0 && (
              <span className="text-xs text-foreground-lighter">
                {t('project:settingsInfrastructure.busyActionsReturnWhenItFinishes')}
              </span>
            )}
          </div>
        </Card>
        {s.error && (
          <Alert variant="destructive" title={s.error.split('\n')[0]!}>
            {s.error.includes('\n') && (
              <pre className="mt-1 text-xs whitespace-pre-wrap">
                {s.error.split('\n').slice(1).join('\n')}
              </pre>
            )}
          </Alert>
        )}
      </SettingsSection>

      <StackUpgrade projectRef={projectRef} stack={s} allowed={allowed} />

      <StudioLogin project={project} studio={s.studio_state ?? null} stackRunning={s.status === 'running'} />

      <StackLogs projectRef={projectRef} stack={s} allowed={allowed} />

      <StackTLS project={project} stack={s} allowed={allowed} />

      <SettingsSection
        title={t('project:settingsInfrastructure.containers')}
        description={t('project:settingsInfrastructure.asDockerComposeReportsThemRefreshed')}
      >
        {s.services_error ? (
          <Alert variant="warning" title={s.services_error} />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('project:settingsInfrastructure.service')}</TableHead>
                  <TableHead>{t('project:settingsInfrastructure.state')}</TableHead>
                  <TableHead>{t('project:settingsInfrastructure.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(s.services ?? []).length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="py-6 text-center text-foreground-lighter">
                      {t('project:settingsInfrastructure.noContainers')}
                    </TableCell>
                  </TableRow>
                ) : (
                  s.services!.map((c) => (
                    <TableRow key={c.service}>
                      <TableCell className="font-mono text-xs text-foreground">
                        {c.service}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            c.state !== 'running'
                              ? 'default'
                              : c.health === 'unhealthy'
                                ? 'destructive'
                                : c.health === 'starting'
                                  ? 'warning'
                                  : 'success'
                          }
                        >
                          {c.health && c.state === 'running' ? c.health : c.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-foreground-lighter">{c.status}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('project:settingsInfrastructure.output')}
        description={t('project:settingsInfrastructure.theEndOfSupermixerSLog')}
      >
        <StackLog log={s.log} />
      </SettingsSection>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        variant="warning"
        title={confirm === 'stop' ? t('project:settingsInfrastructure.pauseThisStack2') : t('project:settingsInfrastructure.restartThisStack2')}
        description={
          confirm === 'stop'
            ? t('project:settingsInfrastructure.itsContainersStopTheApiAnd')
            : t('project:settingsInfrastructure.everyServiceRestartsTheApiAnd')
        }
        confirmLabel={confirm === 'stop' ? t('project:settingsInfrastructure.pauseStack') : t('project:settingsInfrastructure.restartStack')}
        loading={act.isPending}
        onConfirm={() => {
          if (confirm) act.mutate(confirm, { onSettled: () => setConfirm(null) })
        }}
      />
    </>
  )
}

/** Logflare and Vector: on or off per project. */
function StackLogs({ projectRef, stack: s, allowed }: { projectRef: string; stack: Schemas['StackDetail']; allowed: boolean }) {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(api.PUT('/projects/{ref}/stack/logs', { params: { path: { ref: projectRef } }, body: { enabled } })),
    onSuccess: (data) => {
      queryClient.setQueryData(['projects', projectRef, 'stack'], data)
      // The log pages go by the project's stack.logs.
      void queryClient.invalidateQueries({ queryKey: ['projects', projectRef], exact: true })
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setConfirm(false),
  })
  const on = s.logs
  const busy = !!s.operation || s.status === 'provisioning' || s.status === 'deleting'
  const running = s.status === 'running'
  return (
    <SettingsSection
      title={t('project:settingsInfrastructure.logs')}
      description={t('project:settingsInfrastructure.supabaseCollectsThisProjectSLogs')}
    >
      <Card className="flex flex-col divide-y text-sm">
        <Row label={t('project:settingsInfrastructure.status')}>
          <Badge variant={on ? 'success' : 'default'}>{on ? t('project:settingsInfrastructure.collecting') : t('project:settingsInfrastructure.off')}</Badge>
        </Row>
        <div className="flex items-center justify-end gap-2 px-5 py-3">
          <PermissionButton
            allowed={allowed}
            action={t('project:settingsInfrastructure.turnThisProjectSLogsOn')}
            variant={on ? 'warning' : 'default'}
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            {on ? t('project:settingsInfrastructure.turnLogsOff') : t('project:settingsInfrastructure.turnLogsOn')}
          </PermissionButton>
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        variant={on ? 'warning' : 'primary'}
        title={on ? t('project:settingsInfrastructure.turnLogsOff2') : t('project:settingsInfrastructure.turnLogsOn2')}
        description={
          (on
            ? t('project:settingsInfrastructure.thisStopsLogflareAndVectorAnd')
            : t('project:settingsInfrastructure.thisStartsLogflareAndVectorAgain')) +
          (running ? t('project:settingsInfrastructure.yourProjectStaysOnline') : t('project:settingsInfrastructure.thisAppliesTheNextTimeYou'))
        }
        confirmLabel={on ? t('project:settingsInfrastructure.turnLogsOff') : t('project:settingsInfrastructure.turnLogsOn')}
        loading={change.isPending}
        onConfirm={() => change.mutate(!on)}
      />
    </SettingsSection>
  )
}

/** HTTPS and encrypted database connections, on or off per project. */
function StackTLS({ project, stack: s, allowed }: { project: Schemas['Project']; stack: Schemas['StackDetail']; allowed: boolean }) {
  const queryClient = useQueryClient()
  const ui = useQuery(uiConfigQuery)
  const [confirm, setConfirm] = useState(false)
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(api.PUT('/projects/{ref}/stack/tls', { params: { path: { ref: project.ref } }, body: { enabled } })),
    onSuccess: (data) => {
      queryClient.setQueryData(['projects', project.ref, 'stack'], data)
      // The project's addresses change with it.
      void queryClient.invalidateQueries({ queryKey: ['projects', project.ref], exact: true })
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setConfirm(false),
  })
  const on = s.tls
  const available = on || !!ui.data?.provisioning.tls
  const busy = !!s.operation || s.status === 'provisioning' || s.status === 'deleting'
  const running = s.status === 'running'
  const newURL = project.api_url.replace(/^https?:/, on ? 'http:' : 'https:')
  return (
    <SettingsSection
      title={t('project:settingsInfrastructure.encryption')}
      description={t('project:settingsInfrastructure.whetherPeopleAndAppsReachThis')}
    >
      <Card className="flex flex-col divide-y text-sm">
        <Row label={t('project:settingsInfrastructure.status')}>
          <Badge variant={on ? 'success' : 'default'}>{on ? t('project:settingsInfrastructure.on') : t('project:settingsInfrastructure.off')}</Badge>
        </Row>
        <Row label={t('project:settingsInfrastructure.projectUrl')}>
          <span className="font-mono text-xs break-all">{project.api_url}</span>
        </Row>
        {!available && (
          <div className="px-5 py-3 text-foreground-lighter">
            {t('project:settingsInfrastructure.supermixerDoesnTHaveACertificate')}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-5 py-3">
          <PermissionButton
            allowed={allowed}
            action={t('project:settingsInfrastructure.turnEncryptionOnOrOffFor')}
            variant={on ? 'warning' : 'default'}
            disabled={busy || !available}
            onClick={() => setConfirm(true)}
          >
            {on ? t('project:settingsInfrastructure.turnEncryptionOff') : t('project:settingsInfrastructure.turnEncryptionOn')}
          </PermissionButton>
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        variant="warning"
        title={on ? t('project:settingsInfrastructure.turnEncryptionOff2') : t('project:settingsInfrastructure.turnEncryptionOn2')}
        description={
          (on
            ? t('project:settingsInfrastructure.connectionsToThisProjectWonT', { newURL })
            : t('project:settingsInfrastructure.itsUrlBecomesAndTheDatabase', { newURL })) +
          t('project:settingsInfrastructure.updateTheUrlInYourApps') +
          t('project:settingsInfrastructure.databaseToolsNeedTheNewConnection') +
          (running ? t('project:settingsInfrastructure.theApiAndDatabaseRestartBriefly') : t('project:settingsInfrastructure.thisAppliesTheNextTimeYou'))
        }
        confirmLabel={on ? t('project:settingsInfrastructure.turnEncryptionOff') : t('project:settingsInfrastructure.turnEncryptionOn')}
        loading={change.isPending}
        onConfirm={() => change.mutate(!on)}
      />
    </SettingsSection>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
      <span className="text-foreground-lighter">{label}</span>
      <span className="col-span-2">{children}</span>
    </div>
  )
}

const STUDIO_BADGE = localized(() => ({
  running: { label: t('project:settingsInfrastructure.running'), variant: 'success' },
  stopped: { label: t('project:settingsInfrastructure.stopped'), variant: 'default' },
  disabled: { label: t('project:settingsInfrastructure.disabled'), variant: 'default' },
}) as const)

/** Studio sits behind basic auth with a login Supermixer generated. */
function StudioLogin({
  project,
  studio,
  stackRunning,
}: {
  project: Schemas['Project']
  studio: Schemas['StackDetail']['studio_state']
  stackRunning: boolean
}) {
  const canReveal = can(project, 'project:secrets:read')
  const reveal = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/studio-login', { params: { path: { ref: project.ref } } })),
  })
  return (
    <SettingsSection
      title={t('project:settingsInfrastructure.studio')}
      description={
        studio === 'disabled' ? (
          <>
            <Trans i18nKey="project:settingsInfrastructure.supabaseStudioIsOffOnThis" components={{ code: <code className="text-xs" />, code2: <code className="text-xs" /> }} />
          </>
        ) : (
          t('project:settingsInfrastructure.supabaseStudioForThisStackAt')
        )
      }
    >
      <Card className="flex flex-col divide-y text-sm">
        {/* Without Studio there's nothing to open or sign in to. */}
        {project.stack?.studio !== false && (
          <>
        <Row label={t('project:settingsInfrastructure.url')}>
          <CopyField value={project.studio_url} />
        </Row>
        <Row label={t('project:settingsInfrastructure.userName')}>
          {reveal.data ? <CopyField value={reveal.data.username} /> : <span className="font-mono text-xs text-foreground-lighter">••••••••</span>}
        </Row>
        <Row label={t('project:settingsInfrastructure.password')}>
          {reveal.data ? (
            <CopyField value={reveal.data.password} />
          ) : (
            <span className="flex items-center gap-3">
              <span className="font-mono text-xs text-foreground-lighter">••••••••••••</span>
              <PermissionButton
                allowed={canReveal}
                action={t('project:settingsInfrastructure.seeThisStackSStudioLogin')}
                variant="default"
                size="tiny"
                loading={reveal.isPending}
                onClick={() => reveal.mutate()}
              >
                {t('project:settingsInfrastructure.reveal')}
              </PermissionButton>
            </span>
          )}
        </Row>
          </>
        )}
        {studio && (
          <div className="flex items-center justify-end gap-2 px-5 py-3">
            <Badge
              // Stopped while the stack runs is worth noticing; with the stack paused, it's expected.
              variant={studio === 'stopped' && stackRunning ? 'warning' : STUDIO_BADGE()[studio].variant}
              aria-label={t('project:settingsInfrastructure.studio2', { label: STUDIO_BADGE()[studio].label })}
            >
              {STUDIO_BADGE()[studio].label}
            </Badge>
          </div>
        )}
      </Card>
      {reveal.error && <Alert variant="destructive" title={reveal.error.message} />}
    </SettingsSection>
  )
}
