import { useLocation } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { Alert } from '@/components/ui/alert'
import { useProfile } from '@/lib/api/hooks'

const LINKS = [
  { label: 'Overview', to: '/admin' },
  { label: 'Users', to: '/admin/users' },
  { label: 'Global notice', to: '/admin/notice' },
  { label: 'Audit log', to: '/admin/audit' },
]

/** The instance admin console: its menu, a header, and the page (instance admins only). */
export function AdminLayout({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const pathname = useLocation().pathname.replace(/\/+$/, '') || '/'
  const { data: me } = useProfile()
  return (
    <AppShell title="Instance">
      <WithProductMenu
        menu={
          <ProductMenu
            title="Instance"
            sections={[{ title: 'Administration', links: LINKS.map((l) => ({ ...l, active: pathname === l.to })) }]}
          />
        }
      >
        <PageHeader title={title} description={description} size="large" actions={me?.is_instance_admin && actions} />
        <PageContainer size="large" className="flex flex-col gap-6 pb-16">
          {!me ? null : me.is_instance_admin ? children : <Alert variant="warning" title="Only instance admins can see this" />}
        </PageContainer>
      </WithProductMenu>
    </AppShell>
  )
}
