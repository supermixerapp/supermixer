/*
 * Rotating a created stack's keys (Stage 4.5): Settings › API Keys.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { stackQuery } from '@/components/project/stack'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'

type Rotation = 'secret_key' | 'publishable_key' | 'signing_key' | 'jwt_secret' | 'functions_db_password'

const ROTATIONS: { id: Rotation; label: string; effect: string }[] = [
  {
    id: 'secret_key',
    label: 'Secret key',
    effect: 'Servers using the current sb_secret_ key stop working until they get the new one.',
  },
  {
    id: 'publishable_key',
    label: 'Publishable key',
    effect: 'Apps using the current sb_publishable_ key stop working until they get the new one.',
  },
  {
    id: 'signing_key',
    label: 'JWT signing key',
    effect:
      'New sessions are signed with a new key. Sessions signed with the current one stay valid until the next rotation.',
  },
  {
    id: 'jwt_secret',
    label: 'Legacy JWT secret',
    effect: 'The legacy anon and service_role keys are replaced; anything using them stops working.',
  },
  {
    id: 'functions_db_password',
    label: 'Edge Functions database password',
    effect: 'Edge Functions restart with the new password; nothing outside the stack uses it.',
  },
]

export function RotateKeys({ project }: { project: Schemas['Project'] }) {
  const ref = project.ref
  const queryClient = useQueryClient()
  const allowed = can(project, 'project:update')
  const stack = useQuery(stackQuery(ref))
  const [chosen, setChosen] = useState<Rotation[]>([])
  const [confirming, setConfirming] = useState(false)
  const rotate = useMutation({
    mutationFn: (keys: Rotation[]) =>
      unwrap(
        api.POST('/projects/{ref}/stack/rotate-keys', { params: { path: { ref } }, body: { keys } })
      ),
    onSuccess: () => {
      toast.success('Rotating keys')
      setChosen([])
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] })
    },
  })

  // Show the new keys once the rotation finishes.
  const operation = stack.data?.operation
  const last = useRef(operation)
  useEffect(() => {
    if (last.current === 'rotating_keys' && !operation) {
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'api-keys'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'rotation-advisories'] })
    }
    last.current = operation
  }, [operation, queryClient, ref])

  const s = stack.data
  const notReady = !s
    ? 'Loading'
    : s.operation
      ? 'The stack is busy; wait for it to finish'
      : s.status !== 'running' && s.status !== 'paused'
        ? 'Start the stack first'
        : null
  const toggle = (id: Rotation, on: boolean) =>
    setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)))

  return (
    <SettingsSection
      title="Rotate keys"
      description="Replace keys that may have leaked. Supermixer writes the new values to the stack and restarts the services that use them."
    >
      <Card className="flex flex-col divide-y text-sm">
        {ROTATIONS.map((r) => (
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
            <span className="text-xs text-foreground-lighter">Rotating…</span>
          )}
          <PermissionButton
            allowed={allowed}
            action="rotate this project's keys"
            variant="warning"
            disabled={chosen.length === 0 || !!notReady}
            title={notReady ?? undefined}
            loading={rotate.isPending}
            onClick={() => setConfirming(true)}
          >
            Rotate {chosen.length > 0 ? chosen.length : ''} {chosen.length === 1 ? 'key' : 'keys'}
          </PermissionButton>
        </div>
      </Card>
      {s?.error && !s.operation && <Alert variant="warning" title={s.error.split('\n')[0]!} />}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title="Rotate these keys?"
        description={
          <ul className="list-disc space-y-1 pl-4">
            {ROTATIONS.filter((r) => chosen.includes(r.id)).map((r) => (
              <li key={r.id}>
                <span className="text-foreground">{r.label}:</span> {r.effect}
              </li>
            ))}
          </ul>
        }
        confirmLabel="Rotate"
        confirmText={project.name}
        loading={rotate.isPending}
        onConfirm={() => rotate.mutate(chosen)}
      />
    </SettingsSection>
  )
}
