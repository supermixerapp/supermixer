/*
 * Instance › Overview: the instance at a glance, for instance admins.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AdminLayout } from '@/components/layout/admin-layout'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'

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
            <Stat label="Organizations" value={o.organizations} />
            <Stat label="Projects" value={o.projects} detail={`${o.managed_projects} created by Supermixer`} />
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

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <Card className="flex flex-col gap-1 px-5 py-4">
      <span className="text-xs text-foreground-lighter">{label}</span>
      <span className="text-2xl text-foreground">{value}</span>
      {detail && <span className="text-xs text-foreground-lighter">{detail}</span>}
    </Card>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
      <span className="text-foreground-lighter">{label}</span>
      <span className="col-span-2 text-foreground-light">{children}</span>
    </div>
  )
}
