import { createFileRoute, ErrorComponent, notFound, Outlet, useLocation } from '@tanstack/react-router'

import { MfaRequired } from '@/components/auth/mfa-required'
import { SsoRequired } from '@/components/auth/sso-required'
import { AppShell } from '@/components/layout/app-shell'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { Sidebar, type SidebarLink } from '@/components/layout/sidebar'
import { isApiError } from '@/lib/api/client'
import { projectQuery } from '@/lib/api/queries'
import { productMenus, projectNavGroups } from '@/lib/navigation'

import { NotFound } from '../__root'

export const Route = createFileRoute('/_app/project/$ref')({
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(projectQuery(params.ref))
    } catch (e) {
      if (isApiError(e, 404)) throw notFound()
      throw e
    }
  },
  component: ProjectLayout,
  notFoundComponent: NotFound,
  // The project's organization requires two-factor sign-in.
  errorComponent: ({ error }) => {
    if (isApiError(error, 403) && error.code === 'mfa_required') {
      return (
        <AppShell>
          <MfaRequired />
        </AppShell>
      )
    }
    // ...or signing in through its single sign-on provider.
    if (isApiError(error, 403) && error.code === 'sso_required') {
      return (
        <AppShell>
          <SsoRequired message={`${error.message}. Open the organization to sign in with it.`} />
        </AppShell>
      )
    }
    return <ErrorComponent error={error} />
  },
})

function ProjectLayout() {
  const { ref } = Route.useParams()
  const { pathname } = useLocation()
  const base = `/project/${ref}`
  const subPath = pathname.slice(base.length).replace(/^\/+|\/+$/g, '')
  // A page belongs to the product menu that lists it (Settings › Vault lives at
  // integrations/vault); otherwise fall back to the first path segment.
  const owningMenu = Object.entries(productMenus).find(([, m]) =>
    m.groups.some((g) => g.items.some((i) => subPath === i.path || subPath.startsWith(`${i.path}/`)))
  )?.[0]
  const section = owningMenu ?? (subPath.split('/')[0] || 'home')

  const groups: SidebarLink[][] = projectNavGroups.map((group) =>
    group.map((r) => ({
      key: r.key,
      label: r.label,
      icon: r.icon,
      to: r.path ? `${base}/${r.path}` : base,
      active: r.key === section,
    }))
  )

  const menu = productMenus[section]
  // Only the most specific match is active: observability/api, not also observability.
  const matches = (path: string) => subPath === path || subPath.startsWith(`${path}/`)
  const activePath = menu?.groups
    .flatMap((g) => g.items.map((i) => i.path))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0]
  const productMenu = menu && (
    <ProductMenu
      title={menu.title}
      sections={menu.groups.map((g) => ({
        title: g.title,
        links: g.items.map((item) => ({
          label: item.label,
          to: `${base}/${item.path}`,
          active: item.path === activePath,
        })),
      }))}
    />
  )

  return (
    <AppShell sidebar={<Sidebar groups={groups} />}>
      <WithProductMenu menu={productMenu}>
        <Outlet />
      </WithProductMenu>
    </AppShell>
  )
}
