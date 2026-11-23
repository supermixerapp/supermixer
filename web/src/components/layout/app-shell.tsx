import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { WarningIcon } from '@/components/icons'
import { useProfile } from '@/lib/api/hooks'

import { LayoutHeader } from './layout-header'

/** Header across the top; optional icon rail and content below (Studio's layout). */
export function AppShell({ sidebar, title, children }: { sidebar?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <DefaultPasswordBanner />
      <LayoutHeader title={title} />
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  )
}

/** Shown on every page while the signed-in account uses the bootstrap password. */
function DefaultPasswordBanner() {
  const { data: me } = useProfile()
  if (!me?.default_password) return null
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-warning-500 bg-warning-200 px-4 py-1.5 text-xs text-foreground"
    >
      <WarningIcon size={14} className="text-warning-600" />
      You are signed in with the default password.
      <Link to="/account/me" hash="password" className="text-link">
        Change it now
      </Link>
    </div>
  )
}
