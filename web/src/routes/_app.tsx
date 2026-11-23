import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

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
  component: Outlet,
})
