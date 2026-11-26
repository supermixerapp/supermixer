import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'

import { AccountIcon, ApiIcon, LogoutIcon, ManageAccountsIcon, TuneIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, unwrap } from '@/lib/api/client'
import { useProfile, useSelectedOrganization, useSelectedProject } from '@/lib/api/hooks'
import { roleLabel } from '@/lib/roles'
import { useTheme, type ThemePreference } from '@/lib/theme'

/** Account menu (Studio's UserDropdown): preferences, theme, sign out. */
export function UserDropdown() {
  const { preference, setPreference, forget } = useTheme()
  const { data: me } = useProfile()
  // Your role where you are: in the project in the URL (counting a role
  // given for it alone), else in the organization.
  const project = useSelectedProject()
  const org = useSelectedOrganization()
  const access = project
    ? { role: project.role, name: project.name }
    : org
      ? { role: org.role, name: org.name }
      : undefined
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const signOut = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-out')),
    onSettled: () => {
      queryClient.clear()
      // The theme was this user's; the next one starts from the default.
      forget()
      void navigate({ to: '/sign-in', search: { redirect: undefined } })
    },
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="text"
          rounded
          aria-label="Account menu"
          className="h-[26px] w-[26px] px-0 [&_svg]:!h-5 [&_svg]:!w-5"
          icon={<AccountIcon />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {me && (
          <div className="flex flex-col px-2 py-1.5">
            <span className="truncate text-sm text-foreground">{me.display_name || me.username}</span>
            <span className="truncate text-xs text-foreground-lighter">{me.email ?? me.username}</span>
            {(me.is_instance_admin || access) && (
              <div className="mt-2 flex flex-col gap-1.5">
                {access && (
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-lighter">
                    <Badge variant={access.role === 'owner' ? 'success' : 'default'}>
                      {access.role === 'no_access' ? 'Chosen projects' : roleLabel(access.role)}
                    </Badge>
                    <span className="truncate" title={access.name}>
                      in {access.name}
                    </span>
                  </span>
                )}
                {me.is_instance_admin && (
                  <span>
                    <Badge variant="green" title="Manages this Supermixer instance's accounts and settings">
                      Instance admin
                    </Badge>
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link to="/account/me">
              <TuneIcon size={14} className="text-foreground-lighter" />
              Preferences
            </Link>
          </DropdownMenuItem>
          {me?.is_instance_admin && (
            <DropdownMenuItem asChild>
              <Link to="/admin">
                <ManageAccountsIcon size={14} className="text-foreground-lighter" />
                Instance admin
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link to="/docs/api">
              <ApiIcon size={14} className="text-foreground-lighter" />
              API endpoints
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut.mutate()}>
          <LogoutIcon size={14} className="text-foreground-lighter" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
