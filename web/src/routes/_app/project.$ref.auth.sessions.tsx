import { createFileRoute } from '@tanstack/react-router'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'

export const Route = createFileRoute('/_app/project/$ref/auth/sessions')({
  component: SessionsPage,
})

function SessionsPage() {
  return (
    <AuthConfigPage title="Sessions" description="How long users stay signed in, and how refresh tokens behave.">
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title="Refresh tokens"
            fields={[
              {
                name: 'refresh_token_rotation_enabled',
                label: 'Detect and revoke compromised refresh tokens',
                description: 'Each refresh token can be used once; reusing an old one signs out the whole session.',
                type: 'bool',
                default: true,
              },
              {
                name: 'security_refresh_token_reuse_interval',
                label: 'Reuse interval',
                description: 'How long an old refresh token still works, for clients that retry or race.',
                type: 'number',
                unit: 'seconds',
                default: 10,
                step: 1,
              },
            ]}
          />
          <AuthSection
            ctx={ctx}
            title="User sessions"
            description="0 or empty means no limit."
            fields={[
              {
                name: 'sessions_timebox',
                label: 'Time-box user sessions',
                description: 'Sign users out after this long, however active they are.',
                type: 'number',
                unit: 'hours',
                scale: 3600,
              },
              {
                name: 'sessions_inactivity_timeout',
                label: 'Inactivity timeout',
                description: 'Sign users out after this long without refreshing their session.',
                type: 'number',
                unit: 'hours',
                scale: 3600,
              },
              {
                name: 'sessions_single_per_user',
                label: 'Enforce single session per user',
                description: 'Signing in ends the user’s other sessions; only the newest stays signed in.',
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
