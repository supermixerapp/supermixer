import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { Fragment, useSyncExternalStore } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { CommandMenu } from '@/components/layout/command-menu'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/toaster'
import { language, onLanguageChange, t } from '@/lib/i18n'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: NotFound,
})

/**
 * Everything is drawn again, from scratch, when the language changes, so
 * every word switches at once. The router, the URL and fetched data stay;
 * toasts stay too, so one can confirm the switch.
 */
function Root() {
  const lng = useSyncExternalStore(onLanguageChange, language)
  return (
    <>
      <Fragment key={lng}>
        <Outlet />
        <CommandMenu />
      </Fragment>
      <Toaster />
    </>
  )
}

/** Not-found message for use inside an existing layout. */
export function NotFoundContent() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-center">
      <h1 className="heading-title">{t('common:root.pageNotFound')}</h1>
      <p className="text-sm text-foreground-light">{t('common:root.thePageYouAreLookingFor')}</p>
      <Button asChild variant="default">
        <Link to="/organizations">{t('common:root.goToOrganizations')}</Link>
      </Button>
    </div>
  )
}

export function NotFound() {
  return (
    <AppShell>
      <NotFoundContent />
    </AppShell>
  )
}
