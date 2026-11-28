import { useLocation } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { localized, t } from '@/lib/i18n'

const LINKS = localized(() => [
  { label: t('common:accountLayout.preferences'), to: '/account/me' },
  { label: t('common:accountLayout.security'), to: '/account/security' },
  { label: t('common:accountLayout.accessTokens'), to: '/account/access-tokens' },
  { label: t('common:accountLayout.appearance'), to: '/account/appearance' },
  { label: t('common:accountLayout.auditLogs'), to: '/account/audit' },
])

/** Account settings pages: the menu, a header and a narrow column. */
export function AccountLayout({ title, children }: { title: string; children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <AppShell title={t('common:accountLayout.account')}>
      <WithProductMenu
        menu={
          <ProductMenu
            title={t('common:accountLayout.accountSettings')}
            sections={[{ title: t('common:accountLayout.account'), links: LINKS().map((l) => ({ ...l, active: pathname === l.to })) }]}
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
