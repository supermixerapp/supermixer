import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { Alert } from '@/components/ui/alert'
import { useProfile } from '@/lib/api/hooks'
import { usersQuery } from '@/lib/api/queries'
import { localized, t } from '@/lib/i18n'

// Reports on how the instance is used: read-only, and no access to what they list.
const USAGE = localized(() => [
  { label: t('common:adminLayout.organizations'), to: '/admin/organizations' },
  { label: t('common:adminLayout.projects'), to: '/admin/projects' },
])

const LINKS = localized(() => [
  { label: t('common:adminLayout.overview'), to: '/admin' },
  { label: t('common:adminLayout.users'), to: '/admin/users' },
  { label: t('common:adminLayout.signUp'), to: '/admin/sign-up' },
  { label: t('common:adminLayout.globalNotice'), to: '/admin/notice' },
  { label: t('common:adminLayout.resourceLimits'), to: '/admin/limits' },
  { label: t('common:adminLayout.auditLog'), to: '/admin/audit' },
])

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
  // Accounts waiting for approval, counted beside Users.
  const users = useQuery({ ...usersQuery, enabled: !!me?.is_instance_admin })
  const waiting = users.data?.filter((u) => u.waiting_approval).length ?? 0
  return (
    <AppShell title={t('common:adminLayout.instance')}>
      <WithProductMenu
        menu={
          <ProductMenu
            title={t('common:adminLayout.instance')}
            sections={[
              {
                title: t('common:adminLayout.administration'),
                links: LINKS().map((l) => ({
                  ...l,
                  active: pathname === l.to,
                  count: l.to === '/admin/users' ? waiting : undefined,
                })),
              },
              { title: t('common:adminLayout.usage'), links: USAGE().map((l) => ({ ...l, active: pathname === l.to })) },
            ]}
          />
        }
      >
        <PageHeader title={title} description={description} size="large" actions={me?.is_instance_admin && actions} />
        <PageContainer size="large" className="flex flex-col gap-6 pb-16">
          {!me ? null : me.is_instance_admin ? children : <Alert variant="warning" title={t('common:adminLayout.onlyInstanceAdminsCanSeeThis')} />}
        </PageContainer>
      </WithProductMenu>
    </AppShell>
  )
}
