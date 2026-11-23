import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { CommandMenuProvider } from '@/components/layout/command-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isApiError } from '@/lib/api/client'
import { ThemeProvider } from '@/lib/theme'

import { routeTree } from './routeTree.gen'
import './styles/globals.css'

// A 401 anywhere means the session ended (expired, revoked, or the user was
// disabled): drop cached data and go to sign-in.
function onAuthError(error: unknown) {
  if (isApiError(error, 401) && !window.location.pathname.startsWith('/sign-in')) {
    queryClient.clear()
    void router.navigate({ to: '/sign-in', search: { redirect: window.location.pathname + window.location.search } })
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
