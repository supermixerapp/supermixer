/*
 * Left icon rail, modelled on Studio's Sidebar.tsx and the shadcn sidebar in
 * packages/ui (Apache-2.0; see NOTICE): 48px collapsed, 208px expanded, and
 * three behaviours (expand on hover, always expanded, always collapsed).
 */
import { Link } from '@tanstack/react-router'
import { Fragment, useState } from 'react'

import type { Icon } from '@/components/icon'
import { SidebarIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocalStorage } from '@/lib/storage'
import { cn } from '@/lib/utils'

const BEHAVIOURS = ['expandable', 'open', 'closed'] as const
type SidebarBehaviour = (typeof BEHAVIOURS)[number]

export interface SidebarLink {
  key: string
  label: string
  icon: Icon
  to: string
  active: boolean
}

export function Sidebar({ groups }: { groups: SidebarLink[][] }) {
  const [behaviour, setBehaviour] = useLocalStorage<SidebarBehaviour>(
    'supermixer.sidebar-behaviour',
    'expandable',
    BEHAVIOURS
  )
  const [hovered, setHovered] = useState(false)
  const expanded = behaviour === 'open' || (behaviour === 'expandable' && hovered)

  return (
    // The outer box reserves layout space; the rail floats over content when
    // it expands on hover, like Studio.
    <div className={cn('relative hidden shrink-0 md:block', behaviour === 'open' ? 'w-(--sidebar-width)' : 'w-(--sidebar-width-icon)')}>
      <nav
        aria-label="Main"
        data-state={expanded ? 'expanded' : 'collapsed'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          'group/sidebar absolute inset-y-0 left-0 z-40 flex flex-col border-r bg-dash-sidebar text-sidebar-foreground',
          'transition-[width] duration-100 ease-linear',
          expanded ? 'w-(--sidebar-width)' : 'w-(--sidebar-width-icon)'
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto no-scrollbar">
          {groups.map((group, i) => (
            <Fragment key={i}>
              {i > 0 && <Separator className="mx-auto w-[calc(100%-1rem)]" />}
              <ul className="flex flex-col gap-0.5 p-2">
                {group.map((link) => (
                  <SidebarItem key={link.key} link={link} expanded={expanded} />
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
        <div className="flex flex-col gap-2 p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="text"
                className="mx-0.5 w-min px-1.5 [&_svg]:!h-5 [&_svg]:!w-5"
                icon={<SidebarIcon />}
                aria-label="Sidebar control"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-40">
              <DropdownMenuLabel>Sidebar control</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={behaviour} onValueChange={(v) => setBehaviour(v as SidebarBehaviour)}>
                <DropdownMenuRadioItem value="open">Expanded</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="closed">Collapsed</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="expandable">Expand on hover</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
    </div>
  )
}

function SidebarItem({ link, expanded }: { link: SidebarLink; expanded: boolean }) {
  const Icon = link.icon
  const item = (
    <Link
      to={link.to}
      data-active={link.active}
      aria-current={link.active ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-1.5 py-2 text-left text-sm text-foreground-lighter outline-hidden',
        'transition-[width,height,padding] focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        'hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-foreground'
      )}
    >
      <Icon size={20} />
      <span className={cn('truncate transition-opacity', expanded ? 'opacity-100' : 'opacity-0')}>{link.label}</span>
    </Link>
  )

  return (
    <li>
      {expanded ? (
        item
      ) : (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>{item}</TooltipTrigger>
          <TooltipContent side="right">{link.label}</TooltipContent>
        </Tooltip>
      )}
    </li>
  )
}
