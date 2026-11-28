/*
 * The language menu, beside Sign in or the account menu: each language in
 * its own name, with its flag, and the current one's flag on the button.
 * Choosing one switches the app to it in place, then saves it to the
 * account (when signed in).
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { LanguageFlag } from '@/components/flags'
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
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { profileQuery } from '@/lib/api/queries'
import {
  isLanguage,
  language,
  LANGUAGES,
  rememberChosenSignedOut,
  switchLanguage,
  t,
  takeChosenSignedOut,
  type Language,
} from '@/lib/i18n'
import { hasUnsavedChanges } from '@/lib/unsaved'

/** saveToAccount: signed in, so the choice is saved on the account too. */
export function LanguageMenu({ saveToAccount = false }: { saveToAccount?: boolean }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  // A language waiting for the user to agree to lose unsaved work.
  const [confirming, setConfirming] = useState<Language | null>(null)
  const current = language()

  const switchTo = async (lng: Language) => {
    setSaving(true)
    try {
      await switchLanguage(lng)
    } catch (e) {
      // Nothing changed, and nothing was saved.
      console.warn('switching the language', e)
      toast.error(t('common:language.notLoaded'))
      setSaving(false)
      return
    }
    // The app has drawn again in lng, so this is in lng too.
    toast.success(t('common:language.switched'))
    if (!saveToAccount) {
      rememberChosenSignedOut(lng)
      return
    }
    try {
      const p = await unwrap(api.PATCH('/profile', { body: { language: lng } }))
      queryClient.setQueryData(profileQuery.queryKey, p)
    } catch (e) {
      // This browser keeps it; the account keeps its own for other browsers.
      console.warn('saving the language', e)
    }
  }

  const choose = (lng: Language) => {
    if (lng === current) return
    if (hasUnsavedChanges()) setConfirming(lng)
    else void switchTo(lng)
  }

  const confirmingName = LANGUAGES.find((l) => l.code === confirming)?.name ?? ''

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="text"
            rounded
            aria-label={t('common:language.label')}
            title={t('common:language.label')}
            loading={saving}
            className="h-[26px] w-[26px] px-0 [&_svg]:!h-[15px] [&_svg]:!w-5"
            icon={<LanguageFlag lng={current} />}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>{t('common:language.label')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={current} onValueChange={(v) => isLanguage(v) && choose(v)}>
            {LANGUAGES.map((l) => (
              <DropdownMenuRadioItem key={l.code} value={l.code} lang={l.code} className="gap-2">
                <LanguageFlag lng={l.code} />
                {l.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('common:language.unsavedTitle', { name: confirmingName })}
        description={t('common:language.unsavedText')}
        confirmLabel={t('common:language.switchAnyway')}
        variant="warning"
        onConfirm={() => {
          const lng = confirming
          setConfirming(null)
          if (lng) void switchTo(lng)
        }}
      />
    </>
  )
}

/** The account whose language was last taken up in this tab. */
let syncedFor: string | null = null

/** Call on signing out, so the next account to sign in is synced afresh. */
export function forgetLanguageSync() {
  syncedFor = null
}

/**
 * Keeps the language in step with the signed-in account, once per sign-in:
 * a language saved there wins (the app switches to it); a choice made from
 * the menu while signed out is saved to an account that has none. Later
 * profile reloads don't switch, so the page never changes language under
 * someone's unsaved work.
 */
export function LanguageSync() {
  const { data: me } = useProfile()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!me || syncedFor === me.id) return
    syncedFor = me.id
    const chosen = takeChosenSignedOut()
    const saved = me.language ?? null
    if (saved) {
      if (saved !== language()) void switchLanguage(saved).catch((e) => console.warn('switching the language', e))
      return
    }
    if (chosen) {
      unwrap(api.PATCH('/profile', { body: { language: chosen } }))
        .then((p: Schemas['Profile']) => queryClient.setQueryData(profileQuery.queryKey, p))
        .catch(() => {
          // kept in this browser anyway
        })
    }
  }, [me, queryClient])

  return null
}
