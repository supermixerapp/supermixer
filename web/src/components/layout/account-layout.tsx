import { useLocation } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'

const LINKS = [
  { label: 'Preferences', to: '/account/me' },
  { label: 'Security', to: '/account/security' },
  { label: 'Access Tokens', to: '/account/access-tokens' },
  { label: 'Appearance', to: '/account/appearance' },
  { label: 'Audit Logs', to: '/account/audit' },
]

/** Account settings pages: the menu, a header and a narrow column. */
export function AccountLayout({ title, children }: { title: string; children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <AppShell title="Account">
      <WithProductMenu
        menu={
          <ProductMenu
            title="Account settings"
            sections={[{ title: 'Account', links: LINKS.map((l) => ({ ...l, active: pathname === l.to })) }]}
          />
        }
      >
        <PageHeader title={title} size="small" />
        <PageContainer size="small" className="flex flex-col gap-10 pb-16">
          {children}
        </PageContainer>
      </WithProductMenu>
    </AppShell>
  )
}
