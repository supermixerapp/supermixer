import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/icons'
import { GlobalNotice } from '@/components/layout/global-notice'
import { LanguageMenu } from '@/components/layout/language-menu'
import { t } from '@/lib/i18n'

/**
 * Split layout for sign-in and invitation pages, modelled on Studio's
 * SignInLayout: form on the left, brand panel on the right, under the
 * global notice if one is posted. signedIn: shown to a signed-in account
 * (choosing a new password), so a language chosen here is saved on it.
 */
export function AuthLayout({ children, signedIn = false }: { children: ReactNode; signedIn?: boolean }) {
  return (
    <div className="flex min-h-full flex-col bg-alternative">
      {/* A downtime notice reaches people before they sign in, too. */}
      <GlobalNotice />
      {/* The logo exactly where the homepage's and the app's navbar have it
          (their 1px bottom border included, here transparent). */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-transparent pr-3 pl-4">
        <Link to="/" className="flex shrink-0 items-center gap-1.5 rounded-sm text-primary focus-ring">
          <AppIcon size={22} />
          <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">Supermixer</span>
        </Link>
        <LanguageMenu saveToAccount={signedIn} />
      </header>
      <div className="flex flex-1">
        <main className="flex flex-1 shrink-0 flex-col items-center justify-center border-r bg-studio px-5 pb-12 lg:max-w-[600px]">
          <div className="w-full max-w-[384px]">{children}</div>
        </main>
        <aside className="hidden flex-1 flex-col items-center justify-center gap-6 px-16 lg:flex">
          <AppIcon size={120} className="text-primary opacity-90" />
          <p className="max-w-md text-center font-heading text-2xl leading-snug text-foreground">
            {t('common:authLayout.theManagementPlaneForYourSelf')}
          </p>
          <p className="max-w-sm text-center text-sm text-foreground-lighter">
            {t('common:authLayout.organizationsProjectsTeamsAndAccessControl')}
          </p>
        </aside>
      </div>
    </div>
  )
}
