/*
 * In place of an organization's pages (or one of its projects) when it
 * requires two-factor sign-in and the user hasn't turned it on.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { VerifiedUserIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { t } from '@/lib/i18n'

export function MfaRequired({ orgName, orgSlug }: { orgName?: string; orgSlug?: string }) {
  const { data: me } = useProfile()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const leave = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/organizations/{slug}/members/{user_id}', { params: { path: { slug: orgSlug!, user_id: me!.id } } })
      ),
    onSuccess: async () => {
      toast.success(t('auth:mfaRequired.youLeft', { orgName }))
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      void navigate({ to: '/organizations' })
    },
    onError: (e) => {
      setLeaving(false)
      toast.error(e.message)
    },
  })
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <VerifiedUserIcon size={40} className="text-foreground-lighter" />
      <h1 className="heading-title">{orgName ? t('auth:mfaRequired.orgRequires', { orgName }) : t('auth:mfaRequired.twoFactorSignInRequired')}</h1>
      <p className="max-w-md text-sm text-foreground-light">
        {orgName ? t('auth:mfaRequired.thisOrganizationOnlyLetsIn') : t('auth:mfaRequired.projectOrganizationOnlyLetsIn')}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="primary">
          <Link to="/account/security">{t('auth:mfaRequired.setUpTwoFactorSignIn')}</Link>
        </Button>
        <Button asChild variant="default">
          <Link to="/organizations">{t('auth:mfaRequired.allOrganizations')}</Link>
        </Button>
        {orgSlug && me && (
          <Button variant="text" onClick={() => setLeaving(true)}>
            {t('auth:mfaRequired.leaveOrganization')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        variant="danger"
        title={t('auth:mfaRequired.leave', { orgName })}
        description={t('auth:mfaRequired.youLoseAccessToItsProjects')}
        confirmLabel={t('auth:mfaRequired.leave2')}
        loading={leave.isPending}
        onConfirm={() => leave.mutate()}
      />
    </div>
  )
}
