/*
 * Rotating a created stack's keys: Settings › API Keys.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { stackQuery, useKeyRotationDone } from '@/components/project/stack'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { localized, t } from '@/lib/i18n'

type Rotation = 'secret_key' | 'publishable_key' | 'signing_key' | 'jwt_secret' | 'functions_db_password' | 's3_keys'

const ROTATIONS = localized((): { id: Rotation; label: string; effect: string }[] => [
  {
    id: 'secret_key',
    label: t('project:rotateKeys.secretKey'),
    effect: t('project:rotateKeys.serversUsingTheCurrentSbSecret'),
  },
  {
    id: 'publishable_key',
    label: t('project:rotateKeys.publishableKey'),
    effect: t('project:rotateKeys.appsUsingTheCurrentSbPublishable'),
  },
  {
    id: 'signing_key',
    label: t('project:rotateKeys.jwtSigningKey'),
    effect:
      t('project:rotateKeys.newSessionsAreSignedWithA'),
  },
  {
    id: 'jwt_secret',
    label: t('project:rotateKeys.legacyJwtSecret'),
    effect: t('project:rotateKeys.theLegacyAnonAndServiceRole'),
  },
  {
    id: 'functions_db_password',
    label: t('project:rotateKeys.edgeFunctionsDatabasePassword'),
    effect: t('project:rotateKeys.edgeFunctionsRestartWithTheNew'),
  },
  {
    id: 's3_keys',
    label: t('project:rotateKeys.storageS3AccessKeys'),
    effect: t('project:rotateKeys.s3ClientsUsingTheCurrentKeys'),
  },
])

export function RotateKeys({ project }: { project: Schemas['Project'] }) {
  const ref = project.ref
  const queryClient = useQueryClient()
  const allowed = can(project, 'project:update')
  const stack = useQuery(stackQuery(ref))
  const [chosen, setChosen] = useState<Rotation[]>([])
  const [confirming, setConfirming] = useState(false)
  // Show the new keys once the rotation finishes.
  const rotationStarted = useKeyRotationDone(
    ref,
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'api-keys'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'rotation-advisories'] })
      // The S3 page's details; a revealed secret is dropped, not fetched again.
      queryClient.removeQueries({ queryKey: ['projects', ref, 'storage-s3', true] })
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'storage-s3', false] })
    }, [queryClient, ref])
  )
  const rotate = useMutation({
    mutationFn: (keys: Rotation[]) =>
      unwrap(
        api.POST('/projects/{ref}/stack/rotate-keys', { params: { path: { ref } }, body: { keys } })
      ),
    onSuccess: async () => {
      toast.success(t('project:rotateKeys.rotatingKeys'))
      setChosen([])
      await rotationStarted()
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] })
    },
  })


  const s = stack.data
  const notReady = !s
    ? t('project:rotateKeys.loading')
    : s.operation
      ? t('project:rotateKeys.theStackIsBusyWaitFor')
      : s.status !== 'running' && s.status !== 'paused'
        ? t('project:rotateKeys.startTheStackFirst')
        : null
  const toggle = (id: Rotation, on: boolean) =>
    setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)))

  return (
    <SettingsSection
      title={t('project:rotateKeys.rotateKeys')}
      description={t('project:rotateKeys.replaceKeysThatMayHaveLeaked')}
    >
      <Card className="flex flex-col divide-y text-sm">
        {ROTATIONS().map((r) => (
          <label key={r.id} className="flex cursor-pointer items-start gap-3 px-5 py-3">
            <Checkbox
              className="mt-0.5"
              checked={chosen.includes(r.id)}
              disabled={!allowed}
              onCheckedChange={(v) => toggle(r.id, v === true)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-foreground">{r.label}</span>
              <span className="text-xs text-foreground-lighter">{r.effect}</span>
            </span>
          </label>
        ))}
        <div className="flex items-center justify-end gap-3 px-5 py-3">
          {s?.operation === 'rotating_keys' && (
            <span className="text-xs text-foreground-lighter">{t('project:rotateKeys.rotating')}</span>
          )}
          <PermissionButton
            allowed={allowed}
            action={t('project:rotateKeys.rotateThisProjectSKeys')}
            variant="warning"
            disabled={chosen.length === 0 || !!notReady}
            title={notReady ?? undefined}
            loading={rotate.isPending}
            onClick={() => setConfirming(true)}
          >
            {chosen.length > 0 ? t('project:rotateKeys.rotateKeyCount', { count: chosen.length }) : t('project:rotateKeys.rotateNone')}
          </PermissionButton>
        </div>
      </Card>
      {s?.error && !s.operation && <Alert variant="warning" title={s.error.split('\n')[0]!} />}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title={t('project:rotateKeys.rotateTheseKeys')}
        description={
          <ul className="list-disc space-y-1 pl-4">
            {ROTATIONS().filter((r) => chosen.includes(r.id)).map((r) => (
              <li key={r.id}>
                <span className="text-foreground">{r.label}:</span> {r.effect}
              </li>
            ))}
          </ul>
        }
        confirmLabel={t('project:rotateKeys.rotate')}
        confirmText={project.name}
        loading={rotate.isPending}
        onConfirm={() => rotate.mutate(chosen)}
      />
    </SettingsSection>
  )
}
