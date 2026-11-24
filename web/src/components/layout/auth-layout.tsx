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
      {/* The logo exactly where the homepage's and the app's navbar have it
          (their 1px bottom border included, here transparent). */}
      <header className="flex h-12 shrink-0 items-center border-b border-transparent pr-3 pl-4">
        <Link to="/" className="flex shrink-0 items-center gap-1.5 rounded-sm text-primary focus-ring">
          <AppIcon size={22} />
          <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">Supermixer</span>
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
