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

export const Route = createFileRoute('/_app/org/$slug/security')({
  component: OrgSecurityPage,
})

function OrgSecurityPage() {
  const org = useSelectedOrganization()
  if (!org) return null
  return (
    <>
      <PageHeader title="Security" size="small" />
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
    ? 'Members may sign in with a password.'
    : required
      ? `Members must sign in with ${required.name}.`
      : ui.data
        ? `Signing in with “${requiredId}” is required, but this server no longer offers it, so members may sign in with a password until it does. Choose another provider, or stop requiring it, under SSO.`
        : 'Members must sign in with single sign-on.'
  return (
    <SettingsSection title="Single sign-on">
      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            {status}
          </p>
          <p className="text-sm text-foreground-lighter">
            Choose a sign-in provider, require it, and let people join by signing in with it under{' '}
            <Link to="/org/$slug/sso" params={{ slug: org.slug }} className="text-link">
              Organization Settings › SSO
            </Link>
            .
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
      toast.success(o.mfa_required ? 'Two-factor sign-in is now required' : 'Two-factor sign-in is no longer required')
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
    onError: (e) => toast.error(e.message),
  })
  // Requiring it without having it would lock you out.
  const needOwn = !org.mfa_required && !me?.mfa_enabled
  return (
    <SettingsSection title="Two-factor sign-in">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-1">
              <Label htmlFor="org-mfa">Require two-factor sign-in</Label>
              <p className="text-sm text-foreground-lighter">
                Members must sign in with a code from an authenticator app as well as their password. Until they turn
                it on, they can see this organization&apos;s name and leave it, nothing else.
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
            <p className="text-xs text-foreground-lighter">Only Owners can change this.</p>
          ) : (
            needOwn && (
              <p className="text-xs text-foreground-lighter">
                Turn on two-factor sign-in for your own account first, under{' '}
                <Link to="/account/security" className="text-link">
                  Account › Security
                </Link>
                .
              </p>
            )
          )}
          {org.mfa_required && without.length > 0 && (
            <Alert variant="warning" title={`${without.length} ${without.length === 1 ? 'member hasn’t' : 'members haven’t'} turned it on`}>
              {without.map((m) => m.username).join(', ')} can&apos;t open this organization until they do.
            </Alert>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title="Require two-factor sign-in?"
        description={
          without.length > 0
            ? `${without.map((m) => m.username).join(', ')} ${without.length === 1 ? 'doesn’t' : 'don’t'} use it yet, and won’t be able to open this organization or its projects until they turn it on.`
            : 'Every member already uses it. New members will need it too.'
        }
        confirmLabel="Require it"
        loading={set.isPending}
        onConfirm={() => set.mutate(true)}
      />
    </SettingsSection>
  )
}
