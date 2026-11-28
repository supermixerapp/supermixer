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
import { t, Trans } from '@/lib/i18n'

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
      title={t('storage:storageSettings.storageSettings')}
      description={t('storage:storageSettings.limitsAndFeaturesOfThisProject')}
    >
      {!project.stack ? (
        <Alert title={t('storage:storageSettings.supermixerConnectsToThisStackSo')}>
          <Trans i18nKey="storage:storageSettings.selfHostedStorageReadsThemFrom" components={{ code: <code className="font-mono text-xs" />, code2: <code className="font-mono text-xs" /> }} />
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
          ? t('storage:storageSettings.savedStorageRestartedWithTheNew')
          : project.stack?.status === 'running'
            ? t('storage:storageSettings.saved')
            : t('storage:storageSettings.savedTheyTakeEffectWhenThe')
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
      {!canChange && <Alert title={t('storage:storageSettings.onlyOwnersAndAdministratorsCanChange')} />}
      {saved.problems?.map((p) => (
        <Alert key={p.setting} variant="warning" title={p.message}>
          {t('storage:storageSettings.storageIsGivenItAsIt')}
        </Alert>
      ))}
      {project.stack?.status !== 'running' && (
        <Alert title={t('storage:storageSettings.theStackIsnTRunning')}>{t('storage:storageSettings.savedSettingsTakeEffectWhenIt')}</Alert>
      )}
      <SettingsSection title={t('storage:storageSettings.uploads')}>
        <Card>
          <CardContent className="flex flex-col gap-6">
            <FormField
              label={t('storage:storageSettings.uploadFileSizeLimit')}
              htmlFor="upload-limit"
              layout="horizontal"
              description={t('storage:storageSettings.theLargestFileAnyoneCanUpload')}
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
                  <SelectTrigger aria-label={t('storage:storageSettings.unit')} className="w-28">
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
              label={t('storage:storageSettings.imageTransformations')}
              layout="horizontal"
              description={t('storage:storageSettings.resizeAndConvertImagesOnThe')}
            >
              <Switch
                aria-label={t('storage:storageSettings.imageTransformations')}
                checked={transform}
                disabled={!canChange}
                onCheckedChange={setTransform}
              />
            </FormField>
            {!valid && (
              <Alert variant="warning" title={t('storage:storageSettings.theUploadLimitMustBeBetween')} />
            )}
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </CardContent>
          <CardFooter>
            <Button variant="default" disabled={!anyEdited} onClick={reset}>
              {t('storage:storageSettings.cancel')}
            </Button>
            <PermissionButton
              allowed={canChange}
              action={t('storage:storageSettings.changeStorageSettings')}
              variant="primary"
              disabled={!dirty || !valid}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('storage:storageSettings.save')}
            </PermissionButton>
          </CardFooter>
        </Card>
      </SettingsSection>
      <p className="text-sm text-foreground-lighter">
        <Trans i18nKey="storage:storageSettings.savingRestartsStorageSoUploadsIn" components={{ link: <Link to="/project/$ref/storage/s3" params={{ ref: project.ref }} className="text-link" /> }} />
      </p>
    </>
  )
}
