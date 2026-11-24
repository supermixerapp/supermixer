import { useQuery } from '@tanstack/react-query'
import { createFileRoute, notFound, Outlet, useLocation } from '@tanstack/react-router'

import { MfaRequired } from '@/components/auth/mfa-required'
import { SsoRequired } from '@/components/auth/sso-required'
import { AppShell } from '@/components/layout/app-shell'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { Sidebar, type SidebarLink } from '@/components/layout/sidebar'
import { useProfile } from '@/lib/api/hooks'
import { organizationsQuery } from '@/lib/api/queries'
import { orgNav, orgSettingsMenu } from '@/lib/navigation'

import { NotFound } from '../__root'

const settingsPaths = orgSettingsMenu.groups.flatMap((g) => g.items.map((i) => i.path))

export const Route = createFileRoute('/_app/org/$slug')({
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
  const sub = pathname.slice(base.length).replace(/^\/+|\/+$/g, '')
  const inSettings = settingsPaths.includes(sub.split('/')[0])
  const { data: me } = useProfile()
  const org = useQuery(organizationsQuery).data?.find((o) => o.slug === slug)

  if (org && !org.sso_satisfied) {
    return (
      <AppShell>
        <SsoRequired orgName={org.name} provider={org.sso_required_provider ?? undefined} />
      </AppShell>
    )
  }
  if (org?.mfa_required && me && !me.mfa_enabled) {
    return (
      <AppShell>
        <MfaRequired orgName={org.name} orgSlug={org.slug} />
      </AppShell>
    )
  }

  const links: SidebarLink[] = orgNav.map((r) => {
    const to = r.path ? `${base}/${r.path}` : base
    const active = r.key === 'settings' ? inSettings : r.path ? sub.startsWith(r.path) : sub === ''
    return { key: r.key, label: r.label, icon: r.icon, to, active }
  })

  const menu = inSettings ? (
    <ProductMenu
      title={orgSettingsMenu.title}
      sections={orgSettingsMenu.groups.map((g) => ({
        title: g.title,
        links: g.items.map((i) => ({ label: i.label, to: `${base}/${i.path}`, active: sub === i.path })),
      }))}
    />
  ) : undefined

  return (
    <AppShell sidebar={<Sidebar groups={[links]} />}>
      <WithProductMenu menu={menu}>
        <Outlet />
      </WithProductMenu>
    </AppShell>
  )
}
