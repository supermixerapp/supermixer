/*
 * Storage › Settings: the upload limit and image transformations of a stack
 * Supermixer created (written to its .env; Storage restarts).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { DatabasePage } from '@/components/database/catalog-page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { BYTE_UNITS, joinBytes, splitBytes, type ByteUnit } from '@/lib/byte-units'

export const Route = createFileRoute('/_app/project/$ref/storage/settings')({
  component: StorageSettingsPage,
})

const storageConfigQuery = (ref: string) => ({
  queryKey: ['projects', ref, 'storage-config'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/storage/config', { params: { path: { ref } } })),
})

function StorageSettingsPage() {
  const project = useSelectedProject()
  const config = useQuery({ ...storageConfigQuery(project?.ref ?? ''), enabled: !!project?.stack })
  if (!project) return null
  return (
    <DatabasePage
      title="Storage Settings"
      description="Limits and features of this project's Storage."
    >
      {!project.stack ? (
        <Alert title="Supermixer connects to this stack, so its Storage settings are set where it runs">
          Self-hosted Storage reads them from its service&apos;s environment in the stack&apos;s
          compose file: <code className="font-mono text-xs">FILE_SIZE_LIMIT</code> (bytes) and{' '}
          <code className="font-mono text-xs">ENABLE_IMAGE_TRANSFORMATION</code>. Projects created
          with &ldquo;Create a new stack&rdquo; are configured here.
        </Alert>
      ) : config.error ? (
        <Alert variant="destructive" title={config.error.message} />
      ) : !config.data ? (
        <Skeleton className="h-48" />
      ) : (
        // Remount after saving, so the form starts from what's saved.
        <StorageSettingsForm
          key={JSON.stringify(config.data)}
          project={project}
          saved={config.data}
        />
      )}
    </DatabasePage>
  )
}

function StorageSettingsForm({
  project,
  saved,
}: {
  project: Schemas['Project']
  saved: Schemas['StorageConfig']
}) {
  const queryClient = useQueryClient()
  const canChange = can(project, 'project:update')
  const initial = splitBytes(saved.file_size_limit)
  const [amount, setAmount] = useState(initial.amount)
  const [unit, setUnit] = useState<ByteUnit>(initial.unit)
  const [transform, setTransform] = useState(saved.image_transformation)
  const bytes = joinBytes(amount, unit)
  const valid = Number.isFinite(bytes) && bytes >= 1024 && bytes <= 500 * (1 << 30)
  const bad = (setting: Schemas['StorageProblem']['setting']) =>
    !!saved.problems?.some((p) => p.setting === setting)
  const edited = {
    file_size_limit: bytes !== saved.file_size_limit,
    image_transformation: transform !== saved.image_transformation,
  }
  const anyEdited = edited.file_size_limit || edited.image_transformation
  // Sent: the settings changed here; with none, those whose .env value can't
  // be read (saving them as shown replaces it). Others are left as they are.
  const sending = anyEdited
    ? edited
    : { file_size_limit: bad('file_size_limit'), image_transformation: bad('image_transformation') }
  const dirty = sending.file_size_limit || sending.image_transformation
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/projects/{ref}/storage/config', {
          params: { path: { ref: project.ref } },
          body: {
            ...(sending.file_size_limit && { file_size_limit: bytes }),
            ...(sending.image_transformation && { image_transformation: transform }),
          },
        })
      ),
    onSuccess: (c) => {
      toast.success(
        c.restarted
          ? 'Saved; Storage restarted with the new settings'
          : project.stack?.status === 'running'
            ? 'Saved'
            : 'Saved; they take effect when the stack starts'
      )
      queryClient.setQueryData(storageConfigQuery(project.ref).queryKey, {
        ...c,
        restarted: undefined,
      })
    },
  })
  const reset = () => {
    setAmount(initial.amount)
    setUnit(initial.unit)
    setTransform(saved.image_transformation)
  }
  return (
    <>
      {!canChange && <Alert title="Only Owners and Administrators can change Storage settings" />}
      {saved.problems?.map((p) => (
        <Alert key={p.setting} variant="warning" title={p.message}>
          Storage is given it as it is, and the setting below shows its default. Save it as shown,
          or change it, to replace the value.
        </Alert>
      ))}
      {project.stack?.status !== 'running' && (
        <Alert title="The stack isn't running">Saved settings take effect when it starts.</Alert>
      )}
      <SettingsSection title="Uploads">
        <Card>
          <CardContent className="flex flex-col gap-6">
            <FormField
              label="Upload file size limit"
              htmlFor="upload-limit"
              layout="horizontal"
              description="The largest file anyone can upload, in any bucket. A bucket's own limit can only be lower. Between 1 KB and 500 GB."
            >
              <div className="flex gap-2">
                <Input
                  id="upload-limit"
                  type="number"
                  min={0}
                  step="any"
                  className="max-w-40"
                  disabled={!canChange}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <Select
                  value={unit}
                  onValueChange={(v) => setUnit(v as ByteUnit)}
                  disabled={!canChange}
                >
                  <SelectTrigger aria-label="Unit" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BYTE_UNITS.map((u) => (
                      <SelectItem key={u.value} value={u.value}>
                        {u.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FormField>
            <FormField
              label="Image transformations"
              layout="horizontal"
              description="Resize and convert images on the fly, through render URLs (imgproxy). Turning it off refuses those requests."
            >
              <Switch
                aria-label="Image transformations"
                checked={transform}
                disabled={!canChange}
                onCheckedChange={setTransform}
              />
            </FormField>
            {!valid && (
              <Alert variant="warning" title="The upload limit must be between 1 KB and 500 GB" />
            )}
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </CardContent>
          <CardFooter>
            <Button variant="default" disabled={!anyEdited} onClick={reset}>
              Cancel
            </Button>
            <PermissionButton
              allowed={canChange}
              action="change Storage settings"
              variant="primary"
              disabled={!dirty || !valid}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </PermissionButton>
          </CardFooter>
        </Card>
      </SettingsSection>
      <p className="text-sm text-foreground-lighter">
        Saving restarts Storage, so uploads in progress may fail. S3 clients connect as described
        under{' '}
        <Link to="/project/$ref/storage/s3" params={{ ref: project.ref }} className="text-link">
          S3 Connection
        </Link>
        .
      </p>
    </>
  )
}
