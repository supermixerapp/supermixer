import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'

import { AppShell } from '@/components/layout/app-shell'
import { CommandMenu } from '@/components/layout/command-menu'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/toaster'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <>
      <Outlet />
      <CommandMenu />
      <Toaster />
    </>
  ),
  notFoundComponent: NotFound,
})

/** Not-found message for use inside an existing layout. */
export function NotFoundContent() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24 text-center">
      <h1 className="heading-title">Page not found</h1>
      <p className="text-sm text-foreground-light">The page you are looking for does not exist.</p>
      <Button asChild variant="default">
        <Link to="/organizations">Go to organizations</Link>
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
