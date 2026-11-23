/*
 * Second-level product menu (256px column), modelled on Studio's
 * ProductMenuBar and Menu "pills" items (Apache-2.0; see NOTICE).
 */
import { Link } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface ProductMenuLink {
  label: string
  to: string
  active: boolean
}

export interface ProductMenuSection {
  title?: string
  links: ProductMenuLink[]
}

export function ProductMenu({ title, sections }: { title: string; sections: ProductMenuSection[] }) {
  return (
    <aside
      aria-label={title}
      className="hidden w-(--product-menu-width) shrink-0 flex-col border-r bg-dash-sidebar md:flex"
    >
      <div className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b px-6">
        <h4 className="min-w-0 flex-1 truncate font-sans text-sm font-normal">{title}</h4>
      </div>
      <div className="grow overflow-y-auto no-scrollbar">
        {sections.map((section, i) => (
          <Fragment key={section.title ?? i}>
            {i > 0 && <div className="h-px w-full bg-border" />}
            <div className="py-5">
              {section.title && (
                <div className="mb-2 flex px-6">
                  <span className="w-full text-sm text-foreground-lighter">{section.title}</span>
                </div>
              )}
              <ul className="px-3">
                {section.links.map((link) => (
                  <MenuItem key={link.to} {...link} />
                ))}
              </ul>
            </div>
          </Fragment>
        ))}
      </div>
    </aside>
  )
}

function MenuItem({ label, to, active }: ProductMenuLink) {
  return (
    <li>
      <Link to={to} aria-current={active ? 'page' : undefined} className="group block rounded-md focus-ring">
        <div
          className={cn(
            'my-px flex items-center rounded-md px-3 py-[3px] transition-colors active:bg-sidebar-accent/50',
            active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'
          )}
        >
          <span
            className={cn(
              'w-full truncate text-sm transition',
              active ? 'font-semibold text-foreground' : 'text-foreground-light group-hover:text-foreground'
            )}
          >
            {label}
          </span>
        </div>
      </Link>
    </li>
  )
}

/** Content area beside an optional product menu. */
export function WithProductMenu({ menu, children }: { menu?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full">
      {menu}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-dash-sidebar">{children}</div>
    </div>
  )
}
