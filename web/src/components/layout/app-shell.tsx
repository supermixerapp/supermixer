import type { ReactNode } from 'react'

import { LayoutHeader } from './layout-header'

/** Header across the top; optional icon rail and content below (Studio's layout). */
export function AppShell({ sidebar, title, children }: { sidebar?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <LayoutHeader title={title} />
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
