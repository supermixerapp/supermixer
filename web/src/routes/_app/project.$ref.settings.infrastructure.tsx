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
import { relativeTime } from '@/lib/auth-users'

export const Route = createFileRoute('/_app/project/$ref/settings/infrastructure')({
  component: InfrastructurePage,
})

function InfrastructurePage() {
  const project = useSelectedProject()
  return (
    <>
      <PageHeader title="Infrastructure" size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        {!project ? null : project.stack ? (
          <ManagedStack project={project} projectRef={project.ref} allowed={can(project, 'project:update')} />
        ) : (
          <Alert title="Supermixer connects to this stack; it didn't create it">
            Its containers, ports and upgrades are managed where it runs. Projects created with
            “Create a new stack” are started, paused and restarted from here.
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
        title="Stack"
        description="Supermixer created this stack and runs it with Docker Compose on its server."
      >
        <Card className="flex flex-col divide-y text-sm">
          <Row label="Status">
            <span className="flex items-center gap-2">
              <StackBadge stack={s} />
              {s.status_at && (
                <span className="text-xs text-foreground-lighter">
                  since {relativeTime(s.status_at)}
                </span>
              )}
            </span>
          </Row>
          <Row label="Supabase">
            <a
              href={`https://github.com/supabase/supabase/tree/${s.template}/docker`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs text-foreground-light hover:text-foreground"
              title={s.template}
            >
              supabase/docker @ {s.template.slice(0, 7)}
            </a>
          </Row>
          <Row label="Ports">
            <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-foreground-light">
              <span>API {s.ports.api}</span>
              <span>Postgres {s.ports.db}</span>
              <span>Pooler (transaction) {s.ports.pooler}</span>
            </span>
          </Row>
          <div className="flex items-center justify-end gap-2 px-5 py-3">
            {actions.includes('start') && (
              <PermissionButton
                allowed={allowed}
                action="start this stack"
                variant="primary"
                loading={act.isPending}
                onClick={() => act.mutate('start')}
              >
                {s.status === 'failed' ? 'Try again' : ACTION_LABELS.start}
              </PermissionButton>
            )}
            {actions.includes('restart') && (
              <PermissionButton
                allowed={allowed}
                action="restart this stack"
                variant="default"
                onClick={() => setConfirm('restart')}
              >
                {ACTION_LABELS.restart}
              </PermissionButton>
            )}
            {actions.includes('stop') && (
              <PermissionButton
                allowed={allowed}
                action="pause this stack"
                variant="warning"
                onClick={() => setConfirm('stop')}
              >
                {ACTION_LABELS.stop}
              </PermissionButton>
            )}
            {actions.length === 0 && (
              <span className="text-xs text-foreground-lighter">
                Busy; actions return when it finishes.
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

      <SettingsSection
        title="Containers"
        description="As Docker Compose reports them, refreshed every 15 seconds."
      >
        {s.services_error ? (
          <Alert variant="warning" title={s.services_error} />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Service</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(s.services ?? []).length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="py-6 text-center text-foreground-lighter">
                      No containers
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
        title="Output"
        description="The end of Supermixer’s log of docker compose commands for this stack."
      >
        <StackLog log={s.log} />
      </SettingsSection>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        variant="warning"
        title={confirm === 'stop' ? 'Pause this stack?' : 'Restart this stack?'}
        description={
          confirm === 'stop'
            ? 'Its containers stop: the API and database go offline until you start it again. Data is kept.'
            : 'Every service restarts; the API and database are briefly unavailable.'
        }
        confirmLabel={confirm === 'stop' ? 'Pause stack' : 'Restart stack'}
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
      title="Logs"
      description="Supabase collects this project's logs with Vector and keeps them with Logflare, for Logs Explorer, the API report and log drains. Together they use about 800 MB of memory."
    >
      <Card className="flex flex-col divide-y text-sm">
        <Row label="Status">
          <Badge variant={on ? 'success' : 'default'}>{on ? 'Collecting' : 'Off'}</Badge>
        </Row>
        <div className="flex items-center justify-end gap-2 px-5 py-3">
          <PermissionButton
            allowed={allowed}
            action="turn this project's logs on or off"
            variant={on ? 'warning' : 'default'}
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            {on ? 'Turn logs off' : 'Turn logs on'}
          </PermissionButton>
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        variant={on ? 'warning' : 'primary'}
        title={on ? 'Turn logs off?' : 'Turn logs on?'}
        description={
          (on
            ? 'This stops Logflare and Vector and frees about 800 MB of memory. New logs won’t be saved, so Logs Explorer, the API report and log drains won’t work until you turn logs back on. Logs you already have are kept.'
            : 'This starts Logflare and Vector again. They use about 800 MB of memory.') +
          (running ? ' Your project stays online.' : ' This applies the next time you start the stack.')
        }
        confirmLabel={on ? 'Turn logs off' : 'Turn logs on'}
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

const STUDIO_BADGE = {
  running: { label: 'Running', variant: 'success' },
  stopped: { label: 'Stopped', variant: 'default' },
  disabled: { label: 'Disabled', variant: 'default' },
} as const

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
      title="Studio"
      description={
        studio === 'disabled' ? (
          <>
            Supabase Studio is off on this server. To run it in stacks Supermixer creates, set{' '}
            <code className="text-xs">studio = true</code> under <code className="text-xs">[provisioning]</code> and
            restart Supermixer.
          </>
        ) : (
          'Supabase Studio for this stack, at its API URL. It asks for this login.'
        )
      }
    >
      <Card className="flex flex-col divide-y text-sm">
        {/* Without Studio there's nothing to open or sign in to. */}
        {project.stack?.studio !== false && (
          <>
        <Row label="URL">
          <CopyField value={project.studio_url} />
        </Row>
        <Row label="User name">
          {reveal.data ? <CopyField value={reveal.data.username} /> : <span className="font-mono text-xs text-foreground-lighter">••••••••</span>}
        </Row>
        <Row label="Password">
          {reveal.data ? (
            <CopyField value={reveal.data.password} />
          ) : (
            <span className="flex items-center gap-3">
              <span className="font-mono text-xs text-foreground-lighter">••••••••••••</span>
              <PermissionButton
                allowed={canReveal}
                action="see this stack's Studio login"
                variant="default"
                size="tiny"
                loading={reveal.isPending}
                onClick={() => reveal.mutate()}
              >
                Reveal
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
              variant={studio === 'stopped' && stackRunning ? 'warning' : STUDIO_BADGE[studio].variant}
              aria-label={`Studio: ${STUDIO_BADGE[studio].label}`}
            >
              {STUDIO_BADGE[studio].label}
            </Badge>
          </div>
        )}
      </Card>
      {reveal.error && <Alert variant="destructive" title={reveal.error.message} />}
    </SettingsSection>
  )
}
