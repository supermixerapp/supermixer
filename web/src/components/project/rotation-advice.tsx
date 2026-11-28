/*
 * Advice to rotate a project's keys after someone who could read them lost
 * that access (removed, left, a lower role, account disabled).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { t } from '@/lib/i18n'

const REASONS = {
  removed: 'project:rotationAdvice.wasRemoved',
  left: 'project:rotationAdvice.left',
  role_changed: 'project:rotationAdvice.lostAccessToTheKeys',
  disabled: 'project:rotationAdvice.hadTheirAccountDisabled',
  transferred: 'project:rotationAdvice.lostAccessWhenTheProjectMoved',
} as const satisfies Record<Schemas['RotationAdvisory']['reason'], string>

export function RotationAdvice({ project, linkToKeys = false }: { project: Schemas['Project']; linkToKeys?: boolean }) {
  const ref = project.ref
  const queryClient = useQueryClient()
  const readable = can(project, 'project:secrets:read')
  const advice = useQuery({
    queryKey: ['projects', ref, 'rotation-advisories'],
    queryFn: () => unwrap(api.GET('/projects/{ref}/rotation-advisories', { params: { path: { ref } } })),
    enabled: readable,
  })
  const dismiss = useMutation({
    mutationFn: () => unwrap(api.DELETE('/projects/{ref}/rotation-advisories', { params: { path: { ref } } })),
    onSuccess: () => toast.success(t('project:rotationAdvice.dismissed')),
    onError: (e) => toast.error(e.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'rotation-advisories'] }),
  })
  const list = advice.data ?? []
  if (list.length === 0) return null
  const managed = !!project.stack
  return (
    <Alert
      variant="warning"
      title={t('project:rotationAdvice.rotateThisProjectSKeys')}
      actions={
        <>
          {linkToKeys && managed && (
            <Button asChild size="tiny" variant="warning">
              <Link to="/project/$ref/settings/api-keys" params={{ ref }}>
                {t('project:rotationAdvice.rotateKeys')}
              </Link>
            </Button>
          )}
          <PermissionButton
            allowed={can(project, 'project:update')}
            action={t('project:rotationAdvice.changeProjectSettings')}
            size="tiny"
            variant="default"
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            {t('project:rotationAdvice.dismiss')}
          </PermissionButton>
        </>
      }
    >
      <ul className="mb-2 list-disc pl-4">
        {list.map((a) => (
          <li key={`${a.username}-${a.created_at}`}>
            {t(REASONS[a.reason], { username: a.username, when: relativeTime(a.created_at) })}
          </li>
        ))}
      </ul>
      {t('project:rotationAdvice.theyCouldReadThisProjectS')}{' '}
      {managed
        ? t('project:rotationAdvice.rotateAtLeastTheSecretKey')
        : t('project:rotationAdvice.rotateTheKeysWhereTheStack')}{' '}
      {t('project:rotationAdvice.alsoCheckTheProjectForAnything')}
    </Alert>
  )
}
