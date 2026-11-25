import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { CommandMenuProvider } from '@/components/layout/command-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isApiError } from '@/lib/api/client'
import { profileQuery } from '@/lib/api/queries'
import { ThemeProvider } from '@/lib/theme'

import { routeTree } from './routeTree.gen'
import './styles/globals.css'

// A 401 anywhere means the session ended (expired, revoked, or the user was
// disabled): drop cached data and go to sign-in.
// Pages for people who aren't signed in, where a 401 is expected: the
// homepage (/ exactly), and these and everything under them.
const PUBLIC_PAGES = ['/sign-in', '/sign-up', '/join', '/forgot-password', '/reset-password']
const isPublicPage = (path: string) => path === '/' || PUBLIC_PAGES.some((p) => path.startsWith(p))

function onAuthError(error: unknown) {
  if (isApiError(error, 401) && !isPublicPage(window.location.pathname)) {
    queryClient.clear()
    void router.navigate({ to: '/sign-in', search: { redirect: window.location.pathname + window.location.search } })
  }
  // An admin asked for a new password while this tab was open: refetching
  // the profile brings up the screen to choose one.
  if (isApiError(error, 403) && error.code === 'password_change_required') {
    void queryClient.invalidateQueries({ queryKey: profileQuery.queryKey })
  }
  // An organization started requiring two-factor sign-in, or this account
  // turned it off elsewhere: refetching brings up the notice in its place.
  if (isApiError(error, 403) && error.code === 'mfa_required') {
    void queryClient.invalidateQueries({ queryKey: profileQuery.queryKey })
    void queryClient.invalidateQueries({ queryKey: ['organizations'], exact: true })
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !isApiError(error) && count < 1,
      refetchOnWindowFocus: false,
    },
  },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <CommandMenuProvider>
            <RouterProvider router={router} />
          </CommandMenuProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
