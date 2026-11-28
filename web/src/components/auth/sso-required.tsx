/*
 * In place of an organization's pages (or one of its projects) when it
 * requires signing in through its single sign-on provider and this session
 * didn't.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from '@tanstack/react-router'

import { VerifiedUserIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, unwrap } from '@/lib/api/client'
import { uiConfigQuery } from '@/lib/api/queries'
import { t } from '@/lib/i18n'

export function SsoRequired({ orgName, provider, message }: { orgName?: string; provider?: string; message?: string }) {
  const { pathname } = useLocation()
  const providers = useQuery(uiConfigQuery).data?.sso_providers ?? []
  const name = providers.find((p) => p.id === provider)?.name ?? t('auth:ssoRequired.itsSignInProvider')
  const identities = useQuery({
    queryKey: ['profile', 'identities'],
    queryFn: () => unwrap(api.GET('/profile/identities')),
    enabled: !!provider,
  })
  const connected = identities.data?.some((i) => i.provider === provider)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <VerifiedUserIcon size={40} className="text-foreground-lighter" />
      <h1 className="heading-title">{orgName ? t('auth:ssoRequired.requiresSigningInWith', { orgName, name }) : t('auth:ssoRequired.singleSignOnRequired')}</h1>
      <p className="max-w-md text-sm text-foreground-light">
        {message ??
          t('auth:ssoRequired.thisOrganizationOnlyLetsInMembers', { name }) +
            (connected === false
              ? t('auth:ssoRequired.connectToYourAccountFirstAccount', { name })
              : t('auth:ssoRequired.signInWithItToContinue'))}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {provider && connected === false ? (
          <Button asChild variant="primary">
            <Link to="/account/security">{t('auth:ssoRequired.connect', { name })}</Link>
          </Button>
        ) : provider ? (
          <Button asChild variant="primary">
            <a href={`/api/v1/auth/sso/${encodeURIComponent(provider)}/start?redirect=${encodeURIComponent(pathname)}`}>
              {t('auth:ssoRequired.signInWith', { name })}
            </a>
          </Button>
        ) : null}
        <Button asChild variant="default">
          <Link to="/organizations">{t('auth:ssoRequired.allOrganizations')}</Link>
        </Button>
      </div>
    </div>
  )
}
