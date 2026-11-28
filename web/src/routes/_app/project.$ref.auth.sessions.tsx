import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/auth/sessions')({
  component: SessionsPage,
})

function SessionsPage() {
  return (
    <AuthConfigPage title={t('authentication:authSessions.sessions')} description={t('authentication:authSessions.howLongUsersStaySignedIn')}>
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title={t('authentication:authSessions.refreshTokens')}
            fields={[
              {
                name: 'refresh_token_rotation_enabled',
                label: t('authentication:authSessions.detectAndRevokeCompromisedRefreshTokens'),
                description: t('authentication:authSessions.eachRefreshTokenCanBeUsed'),
                type: 'bool',
                default: true,
              },
              {
                name: 'security_refresh_token_reuse_interval',
                label: t('authentication:authSessions.reuseInterval'),
                description: t('authentication:authSessions.howLongAnOldRefreshToken'),
                type: 'number',
                unit: 'seconds',
                default: 10,
                step: 1,
              },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title={t('authentication:authSessions.userSessions')}
            description={t('authentication:authSessions.n0OrEmptyMeansNoLimit')}
            fields={[
              {
                name: 'sessions_timebox',
                label: t('authentication:authSessions.timeBoxUserSessions'),
                description: t('authentication:authSessions.signUsersOutAfterThisLong'),
                type: 'number',
                unit: 'hours',
                scale: 3600,
              },
              {
                name: 'sessions_inactivity_timeout',
                label: t('authentication:authSessions.inactivityTimeout'),
                description: t('authentication:authSessions.signUsersOutAfterThisLong2'),
                type: 'number',
                unit: 'hours',
                scale: 3600,
              },
              {
                name: 'sessions_single_per_user',
                label: t('authentication:authSessions.enforceSingleSessionPerUser'),
                description: t('authentication:authSessions.signingInEndsTheUserS'),
                type: 'bool',
                default: false,
              },
            ]}
          />
        </>
      )}
    </AuthConfigPage>
  )
}
