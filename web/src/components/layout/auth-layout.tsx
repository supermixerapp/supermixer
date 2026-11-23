import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/icons'

/**
 * Split layout for sign-in and invitation pages, modelled on Studio's
 * SignInLayout: form on the left, brand panel on the right.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-alternative">
      <header className="flex h-16 shrink-0 items-center px-8">
        <Link to="/" className="flex items-center gap-1.5 rounded-sm text-primary focus-ring">
          <AppIcon size={24} />
          <span className="font-heading text-base font-semibold tracking-tight text-foreground">Supermixer</span>
        </Link>
      </header>
      <div className="flex flex-1">
        <main className="flex flex-1 shrink-0 flex-col items-center justify-center border-r bg-studio px-5 pb-12 lg:max-w-[600px]">
          <div className="w-full max-w-[384px]">{children}</div>
        </main>
        <aside className="hidden flex-1 flex-col items-center justify-center gap-6 px-16 lg:flex">
          <AppIcon size={120} className="text-primary opacity-90" />
          <p className="max-w-md text-center font-heading text-2xl leading-snug text-foreground">
            The management plane for your self-hosted Supabase.
          </p>
          <p className="max-w-sm text-center text-sm text-foreground-lighter">
            Organizations, projects, teams and access control for every stack you run.
          </p>
        </aside>
      </div>
    </div>
  )
}
