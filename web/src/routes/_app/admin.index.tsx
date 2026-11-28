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
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { localized, t, Trans, language } from '@/lib/i18n'
import { formatDate } from '@/lib/i18n/format'

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
    onSuccess: (r) => toast.success(t('admin:admin.sentATestEmailTo', { sentTo: r.sent_to })),
    onError: (e) => toast.error(e.message),
  })
  return (
    <AdminLayout title={t('admin:admin.overview')} description={t('admin:admin.thisSupermixerInstanceAtAGlance')}>
      {overview.error ? (
        <Alert variant="destructive" title={overview.error.message} />
      ) : !o ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {o.password_change_required > 0 && (
            <Alert variant="warning" title={t('admin:admin.stillToChooseANewPassword', { count: o.password_change_required })}>
              <Trans i18nKey="admin:admin.theyCanTDoAnythingElse" components={{ link: <Link to="/admin/users" className="text-link" /> }} />
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label={t('admin:admin.users')} value={o.active_users} detail={t('admin:admin.disabled', { users: o.users - o.active_users })} />
            <Stat label={t('admin:admin.instanceAdmins')} value={o.instance_admins} />
            <Stat label={t('admin:admin.twoFactorSignIn')} value={o.mfa_enabled} detail={t('admin:admin.ofActiveUsers', { activeUsers: o.active_users })} />
            <Stat label={t('admin:admin.organizations')} value={o.organizations} to="/admin/organizations" />
            <Stat
              label={t('admin:admin.projects')}
              value={o.projects}
              detail={t('admin:admin.createdBySupermixer', { managedProjects: o.managed_projects })}
              to="/admin/projects"
            />
          </div>
          <SettingsSection title={t('admin:admin.settings')} description={t('admin:admin.fromTheServerSConfigurationFile')}>
            <Card className="flex flex-col divide-y text-sm">
              <Row label={t('admin:admin.version')}>
                <span className="font-mono text-xs">{o.version}</span>
              </Row>
              <Row label={t('admin:admin.creatingStacks')}>
                {o.provisioning.enabled ? (
                  <span>
                    <Trans i18nKey="admin:admin.onInReachedAt" values={{ stacksDir: o.provisioning.stacks_dir, publicHost: o.provisioning.public_host }} components={{ span: <span className="font-mono text-xs" />, span2: <span className="font-mono text-xs" /> }} />
                  </span>
                ) : (
                  t('admin:admin.offProvisioningEnabled')
                )}
              </Row>
              <Row label={t('admin:admin.backups')}>
                {o.backups.interval_hours > 0
                  ? t('admin:admin.newestKept', { every: every(o.backups.interval_hours), keep: o.backups.keep })
                  : t('admin:admin.scheduledBackupsOff')}
                <Trans i18nKey="admin:admin.inDir" values={{ dir: o.backups.dir }} components={{ code: <span className="font-mono text-xs" /> }} />
              </Row>
              <Row label={t('admin:admin.backupCopies')}>
                {o.backups.s3 ? <span className="font-mono text-xs">{o.backups.s3}</span> : t('admin:admin.notCopiedToABucket')}
              </Row>
              <Row label={t('admin:admin.singleSignOn')}>
                {o.sso.length === 0 ? (
                  t('admin:admin.noProvidersSsoProviders')
                ) : (
                  <span className="flex flex-col gap-2">
                    {o.sso.map((p) => (
                      <span key={p.id} className="flex flex-col">
                        <span className="text-foreground">
                          {p.name}{' '}
                          <span className="text-xs text-foreground-lighter">
                            {p.create_users ? t('admin:admin.createsAccounts') : t('admin:admin.connectedAccountsOnly')}
                            {p.allowed_domains.length > 0 && <> · {p.allowed_domains.join(', ')}</>}
                          </span>
                        </span>
                        <span className="font-mono text-xs break-all text-foreground-lighter">{p.redirect_uri}</span>
                      </span>
                    ))}
                  </span>
                )}
              </Row>
              <Row label={t('admin:admin.email')}>
                {o.email.enabled ? (
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <Trans i18nKey="admin:admin.asThrough" values={{ from: o.email.from, server: o.email.server }} components={{ span: <span className="font-mono text-xs" />, span2: <span className="font-mono text-xs" /> }} />
                    </span>
                    <Button size="tiny" variant="default" loading={testEmail.isPending} onClick={() => testEmail.mutate()}>
                      {t('admin:admin.sendTestEmail')}
                    </Button>
                  </span>
                ) : (
                  t('admin:admin.offEmailSmtpHostInvitationsGive')
                )}
              </Row>
              <Row label={t('admin:admin.auditLogDrains')}>
                {o.audit_drains.length === 0 ? (
                  t('admin:admin.noneAuditDrainsTheAuditLog')
                ) : (
                  <span className="flex flex-col gap-2">
                    {o.audit_drains.map((d) => (
                      <span key={d.id} className="flex flex-col">
                        <span className="flex flex-wrap items-center gap-2 text-foreground">
                          {d.id}
                          {d.state === 'not_started' ? (
                            <Badge variant="warning">{t('admin:admin.notStarted')}</Badge>
                          ) : d.state === 'unknown' ? (
                            <Badge>{t('admin:admin.statusUnknown')}</Badge>
                          ) : d.last_error ? (
                            <Badge variant="destructive">{t('admin:admin.failing')}</Badge>
                          ) : (
                            d.last_success_at && <Badge variant="success">{t('admin:admin.delivering')}</Badge>
                          )}
                          <span className="text-xs text-foreground-lighter">
                            {d.state === 'not_started'
                              ? t('admin:admin.startsWhenAnInstanceTakesOn')
                              : d.pending == null
                                ? null
                                : d.pending === 0
                                  ? t('admin:admin.upToDate')
                                  : t('admin:admin.toSend', { value: d.pending.toLocaleString(language()) })}
                            {d.last_success_at && <> {t('admin:admin.lastSent', { relativeTime: relativeTime(d.last_success_at) })}</>}
                          </span>
                        </span>
                        <span className="font-mono text-xs break-all text-foreground-lighter">{d.target}</span>
                        {d.last_error && <span className="text-xs text-destructive">{d.last_error}</span>}
                      </span>
                    ))}
                  </span>
                )}
              </Row>
              <Row label={t('admin:admin.metrics')}>
                {o.metrics_listen ? (
                  <span>
                    <Trans i18nKey="admin:admin.metricsOn" values={{ listen: o.metrics_listen }} components={{ code: <span className="font-mono text-xs" /> }} />
                    {o.metrics_listen.startsWith(':') && t('admin:admin.everyAddressOfEachReplica')}
                  </span>
                ) : (
                  t('admin:admin.offMetricsListen')
                )}
              </Row>
            </Card>
          </SettingsSection>
          <Certificates tls={o.tls} />
        </>
      )}
    </AdminLayout>
  )
}

const MODES = localized(() => ({ off: t('admin:admin.offTlsMode'), files: t('admin:admin.yourOwnFilesTlsModeFiles'), acme: t('admin:admin.letSEncryptTlsModeAcme') }))

/** Where the certificate comes from, when it expires, and where it's used. */
function Certificates({ tls }: { tls: Schemas['TlsStatus'] }) {
  return (
    <SettingsSection
      title={t('admin:admin.certificate')}
      description={t('admin:admin.encryptsSupermixerSOwnAddressAnd')}
    >
      <Card className="flex flex-col divide-y text-sm">
        <Row label={t('admin:admin.source')}>{MODES()[tls.mode]}</Row>
        {tls.mode !== 'off' && (
          <>
            <Row label={t('admin:admin.hostNames')}>
              <span className="font-mono text-xs">{tls.names.join(', ')}</span>
            </Row>
            {tls.certificates.map((c) => (
              <Row key={c.names.join(',')} label={t('admin:admin.certificate')}>
                <span className="flex flex-col">
                  <span className="text-foreground">
                    {c.issuer}
                    {tls.private_ca && <span className="text-xs text-foreground-lighter"> {t('admin:admin.yourOwnCa')}</span>}
                  </span>
                  <span className={`text-xs ${expiresSoon(c.not_after) ? 'text-warning-600' : 'text-foreground-lighter'}`}>
                    {t('admin:admin.expiresOn', { date: formatDate(c.not_after) })}
                    {expiresSoon(c.not_after) && (
                      <>
                        {' '}
                        ({relativeTime(c.not_after)}):{' '}
                        {tls.mode === 'acme' ? t('admin:admin.itShouldHaveBeenRenewedBy') : t('admin:admin.replaceTheFilesSoon')}
                      </>
                    )}
                  </span>
                </span>
              </Row>
            ))}
            {tls.missing.length > 0 && (
              <Row label={t('admin:admin.waitingFor')}>
                <span className="font-mono text-xs">{tls.missing.join(', ')}</span>
              </Row>
            )}
            {tls.last_error && (
              <Row label={t('admin:admin.lastProblem')}>
                <span className="text-xs text-destructive">
                  {tls.last_error}
                  {tls.last_error_at && <> ({relativeTime(tls.last_error_at)})</>}
                </span>
              </Row>
            )}
          </>
        )}
        <Row label={t('admin:admin.https')}>
          {tls.https_listen ? (
            <span>
              <Trans i18nKey="admin:admin.servedOn" values={{ httpsListen: tls.https_listen }} components={{ span: <span className="font-mono text-xs" /> }} />
            </span>
          ) : (
            t('admin:admin.notServedBySupermixerServerHttps')
          )}
        </Row>
        <Row label={t('admin:admin.hsts')}>
          {tls.hsts ? (
            <span className="font-mono text-xs">{tls.hsts}</span>
          ) : tls.hsts_blocked ? (
            t('admin:admin.heldBackAProjectOnThe')
          ) : (
            t('admin:admin.notSent')
          )}
        </Row>
        {tls.stacks_tls + tls.stacks_plain > 0 && (
          <Row label={t('admin:admin.stacks')}>
            <span className="flex flex-wrap items-center gap-2">
              {/* Design.md › Badge: success (brand) for a good state, warning for a risk, default (outline) for none. */}
              <Badge variant={tls.stacks_tls > 0 ? 'success' : 'default'}>{t('admin:admin.encrypted', { stacksTls: tls.stacks_tls })}</Badge>
              <Badge variant={tls.stacks_plain > 0 ? 'warning' : 'default'}>
                {t('admin:admin.unencrypted', { stacksPlain: tls.stacks_plain })}
              </Badge>
              {tls.stacks_plain > 0 && tls.mode !== 'off' && (
                <span className="text-xs text-foreground-lighter">
                  {t('admin:admin.eachProjectTurnsItOnUnder')}
                </span>
              )}
            </span>
          </Row>
        )}
      </Card>
    </SettingsSection>
  )
}

/** Within 21 days: renewal should have happened by then. */
function expiresSoon(at: string) {
  return new Date(at).getTime() - Date.now() < 21 * 24 * 3600 * 1000
}

/** "Every hour", "Every 6 hours", "Every 30 minutes". */
function every(hours: number) {
  if (hours === 1) return t('admin:admin.everyHour')
  if (Number.isInteger(hours)) return t('admin:admin.everyHours', { hours })
  const minutes = Math.round(hours * 60)
  if (minutes < 60) return minutes === 1 ? t('admin:admin.everyMinute') : t('admin:admin.everyMinutes', { minutes })
  return t('admin:admin.everyHMin', { floor: Math.floor(minutes / 60), minutes: minutes % 60 })
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
      <span className="text-foreground-lighter">{label}</span>
      <span className="col-span-2 text-foreground-light">{children}</span>
    </div>
  )
}
