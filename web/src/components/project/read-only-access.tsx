import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { projectQuery } from '@/lib/api/queries'
import { t, Trans } from '@/lib/i18n'

/**
 * Whether Read-only members' queries run as their own database login. Without
 * one they run as the project's admin user inside a read-only transaction:
 * data can't change, but functions such as pg_terminate_backend still work.
 */
export function ReadOnlyAccess({ project }: { project: Schemas['Project'] }) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState(false)
  const user = project.database.read_only_user
  const canUpdate = can(project, 'project:update')
  const done = (p: Schemas['Project']) => {
    queryClient.setQueryData(projectQuery(p.ref).queryKey, p)
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  }
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/read-only-user', { params: { path: { ref: project.ref } } })),
    onSuccess: (p) => {
      done(p)
      toast.success(t('project:readOnlyAccess.created', { readOnlyUser: p.database.read_only_user }))
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/projects/{ref}/read-only-user', { params: { path: { ref: project.ref } } })),
    onSuccess: (p) => {
      setRemoving(false)
      done(p)
      toast.success(t('project:readOnlyAccess.readOnlyUserRemoved'))
    },
    onError: (e) => {
      setRemoving(false)
      toast.error(e.message)
    },
  })

  return (
    <SettingsSection
      title={t('project:readOnlyAccess.readOnlyAccess')}
      description={t('project:readOnlyAccess.howQueriesRunForMembersWith')}
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          {user ? (
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1 text-sm">
                <span className="flex items-center gap-2 text-foreground">
                  <Trans i18nKey="project:readOnlyAccess.separateDatabaseUserOn" components={{ badge: <Badge variant="success" /> }} />
                </span>
                <span className="text-foreground-light">
                  <Trans i18nKey="project:readOnlyAccess.readOnlyQueriesSignInAs" values={{ user }} components={{ code: <code className="font-mono text-xs" /> }} />
                </span>
              </div>
              <PermissionButton
                allowed={canUpdate}
                action={t('project:readOnlyAccess.changeProjectSettings')}
                variant="default"
                onClick={() => setRemoving(true)}
              >
                {t('project:readOnlyAccess.remove')}
              </PermissionButton>
            </div>
          ) : (
            <>
              <Alert variant="warning" title={t('project:readOnlyAccess.readOnlyQueriesShareTheAdmin')}>
                {t('project:readOnlyAccess.theyRunInAReadOnly')}
              </Alert>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-foreground-light">
                  {t('project:readOnlyAccess.createASeparateLoginOnThis')}
                </p>
                <PermissionButton
                  allowed={canUpdate}
                  action={t('project:readOnlyAccess.changeProjectSettings')}
                  variant="primary"
                  loading={create.isPending}
                  onClick={() => create.mutate()}
                >
                  {t('project:readOnlyAccess.createReadOnlyUser')}
                </PermissionButton>
              </div>
              {create.error && <Alert variant="destructive" title={create.error.message} />}
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('project:readOnlyAccess.removeTheReadOnlyUser')}
        description={t('project:readOnlyAccess.thisDropsFromTheDatabaseRead', { user })}
        confirmLabel={t('project:readOnlyAccess.remove')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </SettingsSection>
  )
}
