import { createFileRoute, notFound, Outlet, useLocation } from '@tanstack/react-router'

import { AppShell } from '@/components/layout/app-shell'
import { Sidebar, type SidebarLink } from '@/components/layout/sidebar'
import { organizationsQuery } from '@/lib/api/fixtures'
import { orgNav } from '@/lib/navigation'

import { NotFound } from './__root'

export const Route = createFileRoute('/org/$slug')({
  loader: async ({ context, params }) => {
    const orgs = await context.queryClient.ensureQueryData(organizationsQuery)
    if (!orgs.some((o) => o.slug === params.slug)) throw notFound()
  },
  component: OrgLayout,
  notFoundComponent: NotFound,
})

function OrgLayout() {
  const { slug } = Route.useParams()
  const { pathname } = useLocation()
  const base = `/org/${slug}`

  const links: SidebarLink[] = orgNav.map((r) => {
    const to = r.path ? `${base}/${r.path}` : base
    return {
      key: r.key,
      label: r.label,
      icon: r.icon,
      to,
      active: r.path ? pathname.startsWith(to) : pathname === base || pathname === `${base}/`,
    }
  })

  return (
    <AppShell sidebar={<Sidebar groups={[links]} />}>
      <div className="flex h-full flex-col overflow-y-auto">
        <Outlet />
      </div>
    </AppShell>
  )
}
