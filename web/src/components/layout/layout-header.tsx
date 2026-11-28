/*
 * Top bar, modelled on Studio's LayoutHeader.tsx (Apache-2.0; see NOTICE):
 * logo, Org / Project breadcrumb switchers, then search and account menu.
 */
import { Link } from '@tanstack/react-router'
import type { HTMLProps } from 'react'

import { AppIcon } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSelectedOrganization, useSelectedProject } from '@/lib/api/hooks'
import { cn } from '@/lib/utils'

import { ConnectSheet } from '@/components/project/connect-sheet'

import { CommandMenuTrigger } from './command-menu'
import { OrganizationSwitcher, ProjectSwitcher } from './switchers'
import { LanguageMenu } from './language-menu'
import { UserDropdown } from './user-dropdown'
import { t } from '@/lib/i18n'

export function LayoutHeaderDivider({ className, ...props }: HTMLProps<HTMLSpanElement>) {
  return (
    <span className={cn('pr-2 text-border-stronger', className)} {...props}>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        shapeRendering="geometricPrecision"
        aria-hidden
      >
        <path d="M16 3.549L7.12 20.600" />
      </svg>
    </span>
  )
}

export function HomeLink() {
  const org = useSelectedOrganization()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          {...(org ? { to: '/org/$slug', params: { slug: org.slug } } : { to: '/organizations' })}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-sm text-primary focus-ring"
        >
          <AppIcon size={22} />
          <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">Supermixer</span>
          <span className="sr-only">{t('common:layoutHeader.backToOrganizationHome')}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent>{t('common:layoutHeader.backToOrganizationHome')}</TooltipContent>
    </Tooltip>
  )
}

export function LayoutHeader({ title }: { title?: string }) {
  const org = useSelectedOrganization()
  const project = useSelectedProject()

  return (
    <header className="flex h-12 shrink-0 items-center border-b">
      <div className="flex h-full flex-1 items-center justify-between gap-x-8 overflow-x-auto pr-3 pl-4">
        <div className="flex items-center text-sm">
          <HomeLink />
          <div className="flex items-center md:pl-2">
            {org && (
              <>
                <LayoutHeaderDivider className="hidden md:block" />
                <OrganizationSwitcher />
              </>
            )}
            {project && (
              <>
                <LayoutHeaderDivider />
                <ProjectSwitcher />
                <div className="ml-3 hidden md:block">
                  <ConnectSheet project={project} />
                </div>
              </>
            )}
            {title && (
              <>
                <LayoutHeaderDivider />
                <span className="text-foreground">{title}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-x-2">
          <CommandMenuTrigger />
          <LanguageMenu saveToAccount />
          <UserDropdown />
        </div>
      </div>
    </header>
  )
}
