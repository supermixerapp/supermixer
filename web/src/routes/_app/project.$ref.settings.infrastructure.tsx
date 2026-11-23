import { useMutation, useQuery } from '@tanstack/react-query'
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
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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

      <StudioLogin project={project} />

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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
      <span className="text-foreground-lighter">{label}</span>
      <span className="col-span-2">{children}</span>
    </div>
  )
}

/** Studio sits behind basic auth with a login Supermixer generated. */
function StudioLogin({ project }: { project: Schemas['Project'] }) {
  const canReveal = can(project, 'project:secrets:read')
  const reveal = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/studio-login', { params: { path: { ref: project.ref } } })),
  })
  return (
    <SettingsSection title="Studio" description="Supabase Studio for this stack, at its API URL. It asks for this login.">
      <Card className="flex flex-col divide-y text-sm">
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
      </Card>
      {reveal.error && <Alert variant="destructive" title={reveal.error.message} />}
    </SettingsSection>
  )
}
