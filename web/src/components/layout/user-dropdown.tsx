import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'

import { AccountIcon, LogoutIcon, ManageAccountsIcon, PaletteIcon, TuneIcon } from '@/components/icons'
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
import { useProfile } from '@/lib/api/hooks'
import { useTheme, type ThemePreference } from '@/lib/theme'

/** Account menu (Studio's UserDropdown): preferences, theme, sign out. */
export function UserDropdown() {
  const { preference, setPreference } = useTheme()
  const { data: me } = useProfile()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const signOut = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/sign-out')),
    onSettled: () => {
      queryClient.clear()
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
              <Link to="/admin/users">
                <ManageAccountsIcon size={14} className="text-foreground-lighter" />
                Users
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link to="/design-system">
              <PaletteIcon size={14} className="text-foreground-lighter" />
              Design system
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
