/*
 * Keeps the theme in step with the signed-in user's account: adopts the
 * saved choice when the profile loads, and saves new choices to it.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { profileQuery } from '@/lib/api/queries'
import { useTheme } from '@/lib/theme'
import { t } from '@/lib/i18n'

export function ThemeSync() {
  const { data: profile } = useProfile()
  const { adopt, registerSave } = useTheme()
  const queryClient = useQueryClient()
  const saved = profile?.theme ?? null
  const loaded = !!profile

  useEffect(() => {
    if (loaded) adopt(saved)
  }, [loaded, saved, adopt])

  useEffect(() => {
    registerSave((theme) => {
      // Optimistic, so a profile refetch mid-save doesn't flip the theme back.
      const before = queryClient.getQueryData<Schemas['Profile']>(profileQuery.queryKey)
      if (before) queryClient.setQueryData(profileQuery.queryKey, { ...before, theme })
      unwrap(api.PATCH('/profile', { body: { theme } }))
        .then((p) => queryClient.setQueryData(profileQuery.queryKey, p))
        .catch((e: unknown) => {
          if (before) queryClient.setQueryData(profileQuery.queryKey, before)
          toast.error(t('common:themeSync.couldnTSaveYourTheme', { value: e instanceof Error ? e.message : String(e) }))
        })
    })
    return () => registerSave(null)
  }, [queryClient, registerSave])

  return null
}
