/*
 * ⌘K command menu, like Studio's CommandMenu: jump to pages, switch theme.
 */
import { useNavigate } from '@tanstack/react-router'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { Icon } from '@/components/icon'
import { DarkModeIcon, LightModeIcon, PaletteIcon, SearchIcon, SystemThemeIcon, TuneIcon } from '@/components/icons'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSelectedOrganization, useSelectedProject } from '@/lib/api/hooks'
import { orgNav, productMenus, projectNavGroups } from '@/lib/navigation'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

const CommandMenuContext = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null)

export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key?.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(() => ({ open, setOpen }), [open])
  return <CommandMenuContext.Provider value={value}>{children}</CommandMenuContext.Provider>
}

function useCommandMenu() {
  const ctx = useContext(CommandMenuContext)
  if (!ctx) throw new Error('useCommandMenu must be used inside CommandMenuProvider')
  return ctx
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * The header search trigger: Studio's "Search..." pill on desktop, an icon
 * button on small screens (where the sidebar is hidden and ⌘K is unavailable,
 * this is the way to navigate).
 */
export function CommandMenuTrigger() {
  const { setOpen } = useCommandMenu()
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'hidden h-[26px] min-w-32 items-center gap-2 rounded-full border border-control bg-field pr-1 pl-2 text-xs text-foreground-lighter transition-colors md:flex',
          'hover:border-control-hover hover:text-foreground-light focus-ring'
        )}
      >
        <SearchIcon size={14} />
        <span className="flex-1 text-left">Search...</span>
        <kbd className="pr-1 font-sans text-[11px] text-foreground-lighter">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <Button
        variant="text"
        rounded
        aria-label="Search and navigate"
        onClick={() => setOpen(true)}
        className="h-[26px] w-[26px] px-0 md:hidden [&_svg]:!h-5 [&_svg]:!w-5"
        icon={<SearchIcon />}
      />
    </>
  )
}

interface Entry {
  label: string
  icon: Icon
  to: string
}

export function CommandMenu() {
  const { open, setOpen } = useCommandMenu()
  const navigate = useNavigate()
  const { setPreference } = useTheme()
  const org = useSelectedOrganization()
  const project = useSelectedProject()

  const projectEntries: Entry[] = project
    ? projectNavGroups.flat().map((r) => ({
        label: r.label,
        icon: r.icon,
        to: `/project/${project.ref}${r.path ? `/${r.path}` : ''}`,
      }))
    : []
  // Every product-menu page, so the palette alone can reach the whole app.
  const projectPageEntries: Entry[] = project
    ? Object.values(productMenus).flatMap((menu) => {
        const route = projectNavGroups.flat().find((r) => productMenus[r.key] === menu)
        return menu.groups.flatMap((g) =>
          g.items.map((item) => ({
            label: `${menu.title}: ${item.label}`,
            icon: route?.icon ?? SearchIcon,
            to: `/project/${project.ref}/${item.path}`,
          }))
        )
      })
    : []
  const orgEntries: Entry[] = org
    ? orgNav.map((r) => ({ label: r.label, icon: r.icon, to: `/org/${org.slug}${r.path ? `/${r.path}` : ''}` }))
    : []

  const go = (to: string) => {
    setOpen(false)
    void navigate({ to })
  }
  const theme = (p: ThemePreference) => {
    setPreference(p)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="large" hideClose className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <Command loop>
          <CommandInput placeholder="Type a command or search..." />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No results found.</CommandEmpty>
            {projectEntries.length > 0 && (
              <CommandGroup heading={`Project: ${project?.name}`}>
                {projectEntries.map((e) => (
                  <NavItem key={e.to} entry={e} onSelect={go} />
                ))}
              </CommandGroup>
            )}
            {projectPageEntries.length > 0 && (
              <CommandGroup heading="Project pages">
                {projectPageEntries.map((e) => (
                  <NavItem key={e.to} entry={e} onSelect={go} />
                ))}
              </CommandGroup>
            )}
            {orgEntries.length > 0 && (
              <CommandGroup heading={`Organization: ${org?.name}`}>
                {orgEntries.map((e) => (
                  <NavItem key={e.to} entry={e} onSelect={go} />
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Supermixer">
              <NavItem entry={{ label: 'All organizations', icon: SearchIcon, to: '/organizations' }} onSelect={go} />
              <NavItem entry={{ label: 'Preferences', icon: TuneIcon, to: '/account/me' }} onSelect={go} />
              <NavItem entry={{ label: 'Design system', icon: PaletteIcon, to: '/design-system' }} onSelect={go} />
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Theme">
              <CommandItem onSelect={() => theme('dark')}>
                <DarkModeIcon size={16} className="text-foreground-lighter" /> Use dark theme
              </CommandItem>
              <CommandItem onSelect={() => theme('light')}>
                <LightModeIcon size={16} className="text-foreground-lighter" /> Use light theme
              </CommandItem>
              <CommandItem onSelect={() => theme('system')}>
                <SystemThemeIcon size={16} className="text-foreground-lighter" /> Use system theme
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function NavItem({ entry, onSelect }: { entry: Entry; onSelect: (to: string) => void }) {
  const Icon = entry.icon
  return (
    <CommandItem value={`${entry.label} ${entry.to}`} onSelect={() => onSelect(entry.to)}>
      <Icon size={16} className="text-foreground-lighter" />
      {entry.label}
      <CommandShortcut className="font-mono text-[10px] tracking-normal">{entry.to}</CommandShortcut>
    </CommandItem>
  )
}
