/*
 * Storage › S3 Connection: reaching Storage with S3 clients (aws, rclone,
 * the AWS SDKs). For stacks Supermixer created: the region and the access
 * key pair from the stack's .env, and new keys (key rotation, s3_keys).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DatabasePage } from '@/components/database/catalog-page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { stackQuery, useKeyRotationDone } from '@/components/project/stack'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/project/$ref/storage/s3')({
  component: StorageS3Page,
})

const s3Query = (ref: string, reveal: boolean) => ({
  queryKey: ['projects', ref, 'storage-s3', reveal],
  queryFn: () => unwrap(api.GET('/projects/{ref}/storage/s3', { params: { path: { ref }, query: { reveal } } })),
})

function StorageS3Page() {
  const project = useSelectedProject()
  const s3 = useQuery({ ...s3Query(project?.ref ?? '', false), enabled: !!project })
  if (!project) return null
  return (
    <DatabasePage
      title="S3 Connection"
      description="Storage speaks the S3 protocol, so S3 tools and SDKs can read and write its buckets."
    >
      {s3.error ? (
        <Alert variant="destructive" title={s3.error.message} />
      ) : !s3.data ? (
        <Skeleton className="h-48" />
      ) : (
        <S3Details project={project} s3={s3.data} />
      )}
    </DatabasePage>
  )
}

function S3Details({ project, s3 }: { project: Schemas['Project']; s3: Schemas['StorageS3'] }) {
  const ref = project.ref
  const queryClient = useQueryClient()
  const canSee = can(project, 'project:secrets:read')
  const canChange = can(project, 'project:update')
  // The secret is fetched on its own, so revealing it leaves the page in place.
  const [reveal, setReveal] = useState(false)
  const secret = useQuery({ ...s3Query(ref, true), enabled: reveal && s3.managed })
  const secretKey = reveal ? secret.data?.secret_access_key : undefined
  // Forgotten on Hide: each Reveal fetches it again (and is logged).
  const hide = () => {
    setReveal(false)
    queryClient.removeQueries({ queryKey: s3Query(ref, true).queryKey })
  }
  const stack = useQuery({ ...stackQuery(ref), enabled: s3.managed })
  const [confirming, setConfirming] = useState(false)
  // Show the new keys once the rotation finishes.
  const rotationStarted = useKeyRotationDone(
    ref,
    useCallback(() => {
      // The old secret is gone: hide it rather than fetch (and log revealing) the new one.
      setReveal(false)
      queryClient.removeQueries({ queryKey: s3Query(ref, true).queryKey })
      void queryClient.invalidateQueries({ queryKey: s3Query(ref, false).queryKey })
    }, [queryClient, ref]),
    s3.managed
  )
  const rotate = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/stack/rotate-keys', { params: { path: { ref } }, body: { keys: ['s3_keys'] } })),
    onSuccess: async () => {
      toast.success('Making new keys; Storage restarts with them')
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
    ? 'Loading'
    : s.operation
      ? 'The stack is busy; wait for it to finish'
      : s.status !== 'running' && s.status !== 'paused'
        ? 'Start the stack first'
        : null

  const example = [
    `export AWS_ACCESS_KEY_ID=${s3.access_key_id ?? '<access key ID>'}`,
    `export AWS_SECRET_ACCESS_KEY=${secretKey ?? '<secret access key>'}`,
    `aws s3 ls --endpoint-url ${s3.endpoint} --region ${s3.region ?? '<region>'}`,
  ].join('\n')

  return (
    <>
      <SettingsSection title="Connection">
        <Card>
          <CardContent className="flex flex-col gap-6">
            <FormField label="Endpoint" layout="horizontal">
              <CopyField value={s3.endpoint} />
            </FormField>
            {s3.managed && (
              <FormField label="Region" layout="horizontal" description="Storage accepts any region in requests; use this one.">
                <CopyField value={s3.region ?? ''} />
              </FormField>
            )}
          </CardContent>
        </Card>
      </SettingsSection>

      {!s3.managed ? (
        <Alert title="Supermixer connects to this stack, so its S3 keys are where it runs">
          Self-hosted Storage takes the access key pair from the stack&apos;s .env (
          <code className="font-mono text-xs">S3_PROTOCOL_ACCESS_KEY_ID</code>,{' '}
          <code className="font-mono text-xs">S3_PROTOCOL_ACCESS_KEY_SECRET</code>) and the region from{' '}
          <code className="font-mono text-xs">REGION</code>.
        </Alert>
      ) : (
        <SettingsSection
          title="Access keys"
          description="One key pair for the whole stack. It can read and write every bucket, past any Row Level Security policy, like the secret API key: keep it on servers."
        >
          <Card>
            <CardContent className="flex flex-col gap-6">
              <FormField label="Access key ID" layout="horizontal">
                <CopyField value={s3.access_key_id ?? ''} />
              </FormField>
              <FormField label="Secret access key" layout="horizontal">
                <div className="flex flex-col gap-1">
                  <CopyField
                    value={secretKey ?? ''}
                    masked={!secretKey}
                    actions={
                      reveal ? (
                        <Button size="tiny" variant="default" loading={secret.isFetching && !secretKey} onClick={hide}>
                          Hide
                        </Button>
                      ) : (
                        <PermissionButton allowed={canSee} action="view the secret access key" size="tiny" variant="default" onClick={() => setReveal(true)}>
                          Reveal
                        </PermissionButton>
                      )
                    }
                  />
                  {reveal && secret.error && <p className="text-xs text-destructive">{secret.error.message}</p>}
                </div>
              </FormField>
            </CardContent>
            <div className="flex items-center justify-end gap-3 border-t px-card py-3">
              {s?.operation === 'rotating_keys' && <span className="text-xs text-foreground-lighter">Making new keys…</span>}
              <PermissionButton
                allowed={canChange}
                action="replace the S3 keys"
                variant="warning"
                disabled={!!notReady}
                title={notReady ?? undefined}
                loading={rotate.isPending}
                onClick={() => setConfirming(true)}
              >
                New access keys
              </PermissionButton>
            </div>
          </Card>
        </SettingsSection>
      )}

      <SettingsSection title="Try it" description="With the AWS CLI; other S3 clients take the same endpoint, region and keys, with path-style addressing.">
        <CodeBlock code={example} />
      </SettingsSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title="Replace the S3 access keys?"
        description="S3 clients using the current keys stop working. Storage restarts with the new ones, so uploads in progress may fail."
        confirmLabel="Make new keys"
        loading={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
    </>
  )
}
