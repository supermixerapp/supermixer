import { createFileRoute } from '@tanstack/react-router'

import { NotFoundContent } from './__root'

/**
 * Unknown pages under a valid organization render inside the org layout.
 * Without this route, TanStack's fuzzy not-found would render the layout's
 * full-shell NotFound inside its own Outlet, nesting a second header and sidebar.
 */
export const Route = createFileRoute('/org/$slug/$')({
  component: NotFoundContent,
})
