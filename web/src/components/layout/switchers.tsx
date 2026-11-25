/*
 * Organization and project breadcrumb switchers, modelled on Studio's
 * OrganizationDropdown / ProjectDropdown (a link plus a popover command list).
 */
import { Link, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'

import { AddIcon, CheckIcon, ChevronsUpDownIcon, ProjectsIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { NewOrganizationDialog } from '@/components/organization/new-organization-dialog'
import { can, useOrganizations, useProjects, useSelectedOrganization, useSelectedProject } from '@/lib/api/hooks'

function SwitcherShell({
  href,
  label,
  leading,
  ariaLabel,
  children,
  open,
  onOpenChange,
}: {
  href: string
  label: ReactNode
  leading?: ReactNode
  ariaLabel: string
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <div className="flex shrink-0 items-center">
        <Link to={href} className="flex shrink-0 items-center gap-2 text-sm">
          {leading}
          <span className="hidden truncate text-foreground md:block md:max-w-32 lg:max-w-none">{label}</span>
        </Link>
        <PopoverTrigger asChild>
          <Button
            variant="text"
            size="tiny"
            aria-label={ariaLabel}
            className="ml-1 px-1.5 py-4 [&_svg]:!h-5 [&_svg]:!w-5"
            iconRight={<ChevronsUpDownIcon />}
          />
        </PopoverTrigger>
      </div>
      <PopoverContent className="w-64 p-0" side="bottom" align="start">
        {children}
      </PopoverContent>
    </Popover>
  )
}


export function OrganizationSwitcher() {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const { data: orgs = [] } = useOrganizations()
  const selected = useSelectedOrganization()
  if (!selected) return null

  // The dialog sits beside the switcher, not in its popover: choosing "New
  // organization" closes the popover, which would take the dialog with it.
  return (
    <>
      <SwitcherShell
        href={`/org/${selected.slug}`}
        label={selected.name}
        leading={<ProjectsIcon size={14} className="text-foreground-lighter" />}
        ariaLabel="Show organizations"
        open={open}
        onOpenChange={setOpen}
      >
        <Command>
          <CommandInput placeholder="Find organization..." />
          <CommandList>
            <CommandEmpty>No organizations found</CommandEmpty>
            <CommandGroup>
              {orgs.map((org) => (
                <CommandItem
                  key={org.slug}
                  value={`${org.name} ${org.slug}`}
                  onSelect={() => {
                    setOpen(false)
                    void navigate({ to: '/org/$slug', params: { slug: org.slug } })
                  }}
                  className="justify-between"
                >
                  <span className="truncate">{org.name}</span>
                  {org.slug === selected.slug && <CheckIcon size={16} />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  void navigate({ to: '/organizations' })
                }}
              >
                All Organizations
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  setCreating(true)
                }}
              >
                <AddIcon size={14} />
                New organization
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </SwitcherShell>
      <NewOrganizationDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const org = useSelectedOrganization()
  const selected = useSelectedProject()
  if (!selected) return null
  const siblings = projects.filter((p) => p.organization_slug === selected.organization_slug)

  return (
    <SwitcherShell
      href={`/project/${selected.ref}`}
      label={selected.name}
      ariaLabel="Show projects"
      open={open}
      onOpenChange={setOpen}
    >
      <Command>
        <CommandInput placeholder="Find project..." />
        <CommandList>
          <CommandEmpty>No projects found</CommandEmpty>
          <CommandGroup>
            {siblings.map((p) => (
              <CommandItem
                key={p.ref}
                value={`${p.name} ${p.ref}`}
                onSelect={() => {
                  setOpen(false)
                  void navigate({ to: '/project/$ref', params: { ref: p.ref } })
                }}
                className="justify-between"
              >
                <span className="truncate">{p.name}</span>
                {p.ref === selected.ref && <CheckIcon size={16} />}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup>
            {org && (
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  void navigate({ to: '/org/$slug', params: { slug: org.slug } })
                }}
              >
                All Projects
              </CommandItem>
            )}
            {org && can(org, 'projects:create') && (
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  void navigate({ to: '/new/$slug', params: { slug: org.slug } })
                }}
              >
                <AddIcon size={14} />
                New project
              </CommandItem>
            )}
          </CommandGroup>
        </CommandList>
      </Command>
    </SwitcherShell>
  )
}
