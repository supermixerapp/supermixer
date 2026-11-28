/*
 * Organization Settings › SSO: which of the instance's sign-in providers the
 * organization uses, whether members must sign in through it, and whether
 * people signing in through it join by themselves. Owners only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useLocation } from '@tanstack/react-router'
import { useState } from 'react'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedOrganization } from '@/lib/api/hooks'
import { ORG_ROLES, type OrgRole } from '@/lib/roles'
import { localized, t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/org/$slug/sso')({
  component: OrgSsoPage,
})

const NONE = 'none'
const JOIN_ROLES = localized(() => ORG_ROLES().filter((r) => r.value !== 'owner'))

const ssoQuery = (slug: string) => ({
  queryKey: ['organizations', slug, 'sso'],
  queryFn: () => unwrap(api.GET('/organizations/{slug}/sso', { params: { path: { slug } } })),
})

function OrgSsoPage() {
  const org = useSelectedOrganization()
  const isOwner = can(org, 'org:update')
  const settings = useQuery({ ...ssoQuery(org?.slug ?? ''), enabled: !!org && isOwner })
  if (!org) return null
  return (
    <>
      <PageHeader title={t('org:sso.sso')} size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        {!isOwner ? (
          <Alert title={t('org:sso.onlyOwnersChangeSingleSignOn')} />
        ) : settings.isPending ? (
          <Skeleton className="h-40" />
        ) : settings.isError ? (
          <Alert variant="destructive" title={settings.error.message} />
        ) : (
          // Remount after saving so the form starts from what's saved.
          <SsoForm key={JSON.stringify(settings.data)} slug={org.slug} saved={settings.data} />
        )}
      </PageContainer>
    </>
  )
}

function SsoForm({ slug, saved }: { slug: string; saved: Schemas['OrganizationSso'] }) {
  const queryClient = useQueryClient()
  const { pathname } = useLocation()
  const [provider, setProvider] = useState(saved.provider ?? NONE)
  const [required, setRequired] = useState(saved.required)
  const [joins, setJoins] = useState(saved.join_role != null)
  const [role, setRole] = useState<OrgRole>(saved.join_role ?? 'developer')
  const [domains, setDomains] = useState(saved.join_domains.join(', '))
  const chosen = saved.providers.find((p) => p.id === provider)
  // Anyone has a GitHub account and its verified addresses go stale, so
  // nobody joins through it (the server refuses it too).
  const canJoin = chosen?.type !== 'github'
  const signedInWithIt = !!chosen && saved.signed_in_with === chosen.id
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/organizations/{slug}/sso', {
          params: { path: { slug } },
          body: {
            provider: chosen ? chosen.id : null,
            required: !!chosen && required,
            join_role: chosen && canJoin && joins ? role : null,
            join_domains: chosen && joins ? domains.split(/[\s,]+/).filter(Boolean) : [],
          },
        })
      ),
    onSuccess: async () => {
      toast.success(t('org:sso.singleSignOnSettingsSaved'))
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
  })

  if (saved.providers.length === 0) {
    return (
      <Alert title={t('org:sso.noSignInProvidersOnThis')}>
        <Trans i18nKey="org:sso.anInstanceAdminAddsThemIn" components={{ code: <code className="font-mono text-xs" /> }} />
      </Alert>
    )
  }
  return (
    <SettingsSection
      title={t('org:sso.singleSignOn')}
      description={t('org:sso.useOneOfThisInstanceS')}
    >
      {saved.provider_missing && (
        <Alert variant="warning" title={t('org:sso.isNoLongerSetUpOn', { provider: saved.provider })}>
          {t('org:sso.nothingAboutItIsEnforcedUntil')}
        </Alert>
      )}
      <Card>
        <CardContent className="flex flex-col gap-6">
          <FormField label={t('org:sso.provider')} layout="horizontal">
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger aria-label={t('org:sso.provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('org:sso.none')}</SelectItem>
                {saved.providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {chosen && (
            <>
              <FormField
                label={t('org:sso.requireIt')}
                layout="horizontal"
                description={
                  signedInWithIt || required
                    ? t('org:sso.membersCanOnlyOpenThisOrganization', { name: chosen.name })
                    : t('org:sso.signInWithYourselfFirstSo', { name: chosen.name })
                }
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Switch
                    aria-label={t('org:sso.requireSigningInWithTheProvider')}
                    checked={required}
                    disabled={!required && !signedInWithIt}
                    onCheckedChange={setRequired}
                  />
                  {!signedInWithIt && !required && (
                    <Button asChild size="tiny" variant="default">
                      <a href={`/api/v1/auth/sso/${encodeURIComponent(chosen.id)}/start?redirect=${encodeURIComponent(pathname)}`}>
                        {t('org:sso.signInWith', { name: chosen.name })}
                      </a>
                    </Button>
                  )}
                </div>
              </FormField>
              {!canJoin ? (
                <FormField label={t('org:sso.joinBySigningIn')} layout="horizontal">
                  <p className="pt-2 text-sm text-foreground-light">
                    {t('org:sso.notWithAnyoneCanHaveAn', { name: chosen.name })}
                  </p>
                </FormField>
              ) : (
                <FormField
                  label={t('org:sso.joinBySigningIn')}
                  layout="horizontal"
                  description={t('org:sso.peopleSigningInWithBecomeMembers', { name: chosen.name })}
                >
                  <Switch aria-label={t('org:sso.letPeopleJoinBySigningIn')} checked={joins} onCheckedChange={setJoins} />
                </FormField>
              )}
              {canJoin && joins && (
                <>
                  <FormField label={t('org:sso.as')} layout="horizontal" description={JOIN_ROLES().find((r) => r.value === role)?.description}>
                    <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
                      <SelectTrigger aria-label={t('org:sso.roleForPeopleWhoJoin')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {JOIN_ROLES().map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField
                    label={t('org:sso.emailDomains')}
                    htmlFor="sso-domains"
                    layout="horizontal"
                    description={t('org:sso.onlyPeopleWhoseEmailAsVouches', { name: chosen.name, name2: chosen.name })}
                  >
                    <Input id="sso-domains" placeholder="example.com" value={domains} onChange={(e) => setDomains(e.target.value)} />
                  </FormField>
                </>
              )}
            </>
          )}
          {save.error && <Alert variant="destructive" title={save.error.message} />}
        </CardContent>
        <CardFooter>
          <PermissionButton allowed action={t('org:sso.changeSingleSignOnSettings')} variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('org:sso.save')}
          </PermissionButton>
        </CardFooter>
      </Card>
    </SettingsSection>
  )
}
