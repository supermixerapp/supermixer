/*
 * Organization Settings › Security: requiring two-factor sign-in, and where
 * single sign-on is required (Organization Settings › SSO).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useProfile, useSelectedOrganization } from '@/lib/api/hooks'
import { membersQuery, uiConfigQuery } from '@/lib/api/queries'
import { t, Trans } from '@/lib/i18n'
import { formatList } from '@/lib/i18n/format'

export const Route = createFileRoute('/_app/org/$slug/security')({
  component: OrgSecurityPage,
})

function OrgSecurityPage() {
  const org = useSelectedOrganization()
  if (!org) return null
  return (
    <>
      <PageHeader title={t('org:security.security')} size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <OrgSecurity org={org} />
        <SingleSignOn org={org} />
      </PageContainer>
    </>
  )
}

/** Where single sign-on stands, and the way to its settings. */
function SingleSignOn({ org }: { org: Schemas['Organization'] }) {
  const ui = useQuery(uiConfigQuery)
  const requiredId = org.sso_required_provider
  const required = ui.data?.sso_providers.find((p) => p.id === requiredId)
  // A provider the server no longer offers isn't enforced (ssoGate), but
  // still set: it applies again if the provider comes back.
  const status = !requiredId
    ? t('org:security.membersMaySignInWithA')
    : required
      ? t('org:security.membersMustSignInWith', { name: required.name })
      : ui.data
        ? t('org:security.signingInWithIsRequiredBut', { requiredId })
        : t('org:security.membersMustSignInWithSingle')
  return (
    <SettingsSection title={t('org:security.singleSignOn')}>
      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            {status}
          </p>
          <p className="text-sm text-foreground-lighter">
            <Trans i18nKey="org:security.chooseASignInProviderRequire" components={{ link: <Link to="/org/$slug/sso" params={{ slug: org.slug }} className="text-link" /> }} />
          </p>
        </CardContent>
      </Card>
    </SettingsSection>
  )
}

function OrgSecurity({ org }: { org: Schemas['Organization'] }) {
  const { data: me } = useProfile()
  const queryClient = useQueryClient()
  const canUpdate = can(org, 'org:update')
  const members = useQuery({ ...membersQuery(org.slug), enabled: can(org, 'members:read') })
  const without = (members.data ?? []).filter((m) => !m.mfa_enabled)
  const [confirming, setConfirming] = useState(false)
  const set = useMutation({
    mutationFn: (on: boolean) =>
      unwrap(api.PATCH('/organizations/{slug}', { params: { path: { slug: org.slug } }, body: { mfa_required: on } })),
    onSuccess: async (o) => {
      setConfirming(false)
      toast.success(o.mfa_required ? t('org:security.twoFactorSignInIsNow') : t('org:security.twoFactorSignInIsNo'))
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
    onError: (e) => toast.error(e.message),
  })
  // Requiring it without having it would lock you out.
  const needOwn = !org.mfa_required && !me?.mfa_enabled
  return (
    <SettingsSection title={t('org:security.twoFactorSignIn')}>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-1">
              <Label htmlFor="org-mfa">{t('org:security.requireTwoFactorSignIn')}</Label>
              <p className="text-sm text-foreground-lighter">
                {t('org:security.membersMustSignInWithA')}
              </p>
            </div>
            <Switch
              id="org-mfa"
              checked={org.mfa_required}
              disabled={!canUpdate || needOwn || set.isPending}
              onCheckedChange={(on) => (on ? setConfirming(true) : set.mutate(false))}
            />
          </div>
          {!canUpdate ? (
            <p className="text-xs text-foreground-lighter">{t('org:security.onlyOwnersCanChangeThis')}</p>
          ) : (
            needOwn && (
              <p className="text-xs text-foreground-lighter">
                <Trans i18nKey="org:security.turnOnTwoFactorSignIn" components={{ link: <Link to="/account/security" className="text-link" /> }} />
              </p>
            )
          )}
          {org.mfa_required && without.length > 0 && (
            <Alert variant="warning" title={t('org:security.turnedItOn', { count: without.length })}>
              {t('org:security.canTOpenThisOrganizationUntil', { names: formatList(without.map((m) => m.username)) })}
            </Alert>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title={t('org:security.requireTwoFactorSignIn2')}
        description={
          without.length > 0
            ? t('org:security.useItYetAndWonT', { names: formatList(without.map((m) => m.username)), count: without.length })
            : t('org:security.everyMemberAlreadyUsesItNew')
        }
        confirmLabel={t('org:security.requireIt')}
        loading={set.isPending}
        onConfirm={() => set.mutate(true)}
      />
    </SettingsSection>
  )
}
