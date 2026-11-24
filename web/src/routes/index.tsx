/*
 * The landing page after signing in (and the app's root): someone in just
 * one organization goes straight to its projects; otherwise, the list of
 * organizations. /organizations itself always shows the list.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

import { isApiError } from '@/lib/api/client'
import { organizationsQuery, profileQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    // Only a 401 means signed out; other errors are left to the app's layout
    // (via /organizations), which shows them.
    const profile = await context.queryClient
      .ensureQueryData(profileQuery)
      .catch((e: unknown) => (isApiError(e, 401) ? null : undefined))
    if (profile === null) throw redirect({ to: '/sign-in' })
    if (!profile) throw redirect({ to: '/organizations' })
    const orgs = await context.queryClient.fetchQuery(organizationsQuery).catch(() => undefined)
    if (orgs?.length === 1) throw redirect({ to: '/org/$slug', params: { slug: orgs[0].slug } })
    throw redirect({ to: '/organizations' })
  },
})
