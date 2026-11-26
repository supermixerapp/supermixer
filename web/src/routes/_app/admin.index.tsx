/*
 * Instance › Overview: the instance at a glance, for instance admins.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Stat } from '@/components/admin/report-parts'
import { AdminLayout } from '@/components/layout/admin-layout'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'

export const Route = createFileRoute('/_app/admin/')({
  component: OverviewPage,
})

function OverviewPage() {
  const { data: me } = useProfile()
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => unwrap(api.GET('/admin/overview')),
    enabled: !!me?.is_instance_admin,
  })
  const o = overview.data
  const testEmail = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/email/test')),
    onSuccess: (r) => toast.success(`Sent a test email to ${r.sent_to}`),
    onError: (e) => toast.error(e.message),
  })
  return (
    <AdminLayout title="Overview" description="This Supermixer instance at a glance.">
      {overview.error ? (
        <Alert variant="destructive" title={overview.error.message} />
      ) : !o ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {o.password_change_required > 0 && (
            <Alert variant="warning" title={`${o.password_change_required} ${o.password_change_required === 1 ? 'account has' : 'accounts have'} still to choose a new password`}>
              They can’t do anything else until they do. See <Link to="/admin/users" className="text-link">Users</Link>.
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Users" value={o.active_users} detail={`${o.users - o.active_users} disabled`} />
            <Stat label="Instance admins" value={o.instance_admins} />
            <Stat label="Two-factor sign-in" value={o.mfa_enabled} detail={`of ${o.active_users} active users`} />
            <Stat label="Organizations" value={o.organizations} to="/admin/organizations" />
            <Stat
              label="Projects"
              value={o.projects}
              detail={`${o.managed_projects} created by Supermixer`}
              to="/admin/projects"
            />
          </div>
          <SettingsSection title="Settings" description="From the server's configuration file (.env.toml); restart Supermixer after changing them.">
            <Card className="flex flex-col divide-y text-sm">
              <Row label="Version">
                <span className="font-mono text-xs">{o.version}</span>
              </Row>
              <Row label="Creating stacks">
                {o.provisioning.enabled ? (
                  <span>
                    On, in <span className="font-mono text-xs">{o.provisioning.stacks_dir}</span>, reached at{' '}
                    <span className="font-mono text-xs">{o.provisioning.public_host}</span>
                  </span>
                ) : (
                  'Off (provisioning.enabled)'
                )}
              </Row>
              <Row label="Backups">
                {o.backups.interval_hours > 0
                  ? `${every(o.backups.interval_hours)}, newest ${o.backups.keep} kept`
                  : 'Scheduled backups off'}
                , in <span className="font-mono text-xs">{o.backups.dir}</span>
              </Row>
              <Row label="Backup copies">
                {o.backups.s3 ? <span className="font-mono text-xs">{o.backups.s3}</span> : 'Not copied to a bucket'}
              </Row>
              <Row label="Single sign-on">
                {o.sso.length === 0 ? (
                  'No providers (sso.providers)'
                ) : (
                  <span className="flex flex-col gap-2">
                    {o.sso.map((p) => (
                      <span key={p.id} className="flex flex-col">
                        <span className="text-foreground">
                          {p.name}{' '}
                          <span className="text-xs text-foreground-lighter">
                            {p.create_users ? 'creates accounts' : 'connected accounts only'}
                            {p.allowed_domains.length > 0 && <> · {p.allowed_domains.join(', ')}</>}
                          </span>
                        </span>
                        <span className="font-mono text-xs break-all text-foreground-lighter">{p.redirect_uri}</span>
                      </span>
                    ))}
                  </span>
                )}
              </Row>
              <Row label="Email">
                {o.email.enabled ? (
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      As <span className="font-mono text-xs">{o.email.from}</span>, through{' '}
                      <span className="font-mono text-xs">{o.email.server}</span>
                    </span>
                    <Button size="tiny" variant="default" loading={testEmail.isPending} onClick={() => testEmail.mutate()}>
                      Send test email
                    </Button>
                  </span>
                ) : (
                  'Off (email.smtp_host): invitations give a link to share, and only admins reset passwords'
                )}
              </Row>
              <Row label="Audit log drains">
                {o.audit_drains.length === 0 ? (
                  'None (audit.drains): the audit log stays in Supermixer'
                ) : (
                  <span className="flex flex-col gap-2">
                    {o.audit_drains.map((d) => (
                      <span key={d.id} className="flex flex-col">
                        <span className="flex flex-wrap items-center gap-2 text-foreground">
                          {d.id}
                          {d.state === 'not_started' ? (
                            <Badge variant="warning">Not started</Badge>
                          ) : d.state === 'unknown' ? (
                            <Badge>Status unknown</Badge>
                          ) : d.last_error ? (
                            <Badge variant="destructive">Failing</Badge>
                          ) : (
                            d.last_success_at && <Badge variant="success">Delivering</Badge>
                          )}
                          <span className="text-xs text-foreground-lighter">
                            {d.state === 'not_started'
                              ? 'starts when an instance takes on background work'
                              : d.pending == null
                                ? null
                                : d.pending === 0
                                  ? 'up to date'
                                  : `${d.pending.toLocaleString()} to send`}
                            {d.last_success_at && <> · last sent {relativeTime(d.last_success_at)}</>}
                          </span>
                        </span>
                        <span className="font-mono text-xs break-all text-foreground-lighter">{d.target}</span>
                        {d.last_error && <span className="text-xs text-destructive">{d.last_error}</span>}
                      </span>
                    ))}
                  </span>
                )}
              </Row>
              <Row label="Metrics">
                {o.metrics_listen ? (
                  <span>
                    <span className="font-mono text-xs">/metrics</span> on{' '}
                    <span className="font-mono text-xs">{o.metrics_listen}</span>
                    {o.metrics_listen.startsWith(':') && ' (every address of each replica)'}
                  </span>
                ) : (
                  'Off (metrics.listen)'
                )}
              </Row>
            </Card>
          </SettingsSection>
        </>
      )}
    </AdminLayout>
  )
}

/** "Every hour", "Every 6 hours", "Every 30 minutes". */
function every(hours: number) {
  if (hours === 1) return 'Every hour'
  if (Number.isInteger(hours)) return `Every ${hours} hours`
  const minutes = Math.round(hours * 60)
  if (minutes < 60) return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`
  return `Every ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
      <span className="text-foreground-lighter">{label}</span>
      <span className="col-span-2 text-foreground-light">{children}</span>
    </div>
  )
}
