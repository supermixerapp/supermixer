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

const REASONS: Record<Schemas['RotationAdvisory']['reason'], string> = {
  removed: 'was removed',
  left: 'left',
  role_changed: 'lost access to the keys',
  disabled: 'had their account disabled',
  transferred: 'lost access when the project moved to another organization',
}

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
    onSuccess: () => toast.success('Dismissed'),
    onError: (e) => toast.error(e.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'rotation-advisories'] }),
  })
  const list = advice.data ?? []
  if (list.length === 0) return null
  const managed = !!project.stack
  return (
    <Alert
      variant="warning"
      title="Rotate this project's keys"
      actions={
        <>
          {linkToKeys && managed && (
            <Button asChild size="tiny" variant="warning">
              <Link to="/project/$ref/settings/api-keys" params={{ ref }}>
                Rotate keys
              </Link>
            </Button>
          )}
          <PermissionButton
            allowed={can(project, 'project:update')}
            action="change project settings"
            size="tiny"
            variant="default"
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            Dismiss
          </PermissionButton>
        </>
      }
    >
      <ul className="mb-2 list-disc pl-4">
        {list.map((a) => (
          <li key={`${a.username}-${a.created_at}`}>
            {a.username} {REASONS[a.reason]} {relativeTime(a.created_at)}
          </li>
        ))}
      </ul>
      They could read this project’s keys, or deploy Edge Functions that can, so they may still have them.{' '}
      {managed
        ? 'Rotate at least the secret key, the legacy JWT secret and the Storage S3 access keys, together or one by one; this notice goes once all three are new.'
        : 'Rotate the keys where the stack runs, update this project’s connection here, then dismiss this.'}{' '}
      Also check the project for anything they may have left behind: Advisors › Changes compares the database with a
      snapshot from before.
    </Alert>
  )
}
