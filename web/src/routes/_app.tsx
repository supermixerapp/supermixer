import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { ChoosePassword } from '@/components/auth/choose-password'
import { ThemeSync } from '@/components/layout/theme-sync'

import { isApiError } from '@/lib/api/client'
import { profileQuery } from '@/lib/api/queries'

/** Everything under this layout needs a signed-in user. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(profileQuery)
    } catch (e) {
      if (isApiError(e, 401)) {
        throw redirect({ to: '/sign-in', search: { redirect: location.href } })
      }
      throw e
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const { data: me } = useQuery(profileQuery)
  return (
    <>
      <ThemeSync />
      {me?.password_change_required ? <ChoosePassword username={me.username} mfa={me.mfa_enabled} /> : <Outlet />}
    </>
  )
}
