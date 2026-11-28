import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import {
  ConnectionFields,
  connectionFromProject,
  HealthChecks,
  toConnectionPayload,
  type ConnectionValue,
} from '@/components/project/connection-form'
import { ReadOnlyAccess } from '@/components/project/read-only-access'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useOrganizations, useSelectedProject } from '@/lib/api/hooks'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/settings/general')({
  component: ProjectGeneralSettings,
})

function ProjectGeneralSettings() {
  const project = useSelectedProject()
  // Remount after each save so the forms start from the stored values.
  return project ? <ProjectSettings key={project.updated_at} project={project} /> : null
}

function ProjectSettings({ project }: { project: Schemas['Project'] }) {
  const ref = project.ref
  const { data: orgs = [] } = useOrganizations()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(project.name)
  const [conn, setConn] = useState<ConnectionValue>(() => connectionFromProject(project))
  const [target, setTarget] = useState('')
  const [confirmTransfer, setConfirmTransfer] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['projects'] })
    await queryClient.invalidateQueries({ queryKey: ['organizations'] })
  }
  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH('/projects/{ref}', { params: { path: { ref } }, body: { name } })),
    onSuccess: async () => {
      toast.success(t('project:settingsGeneral.projectRenamed'))
      await refresh()
    },
  })
  const saveConnection = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH('/projects/{ref}', { params: { path: { ref } }, body: { connection: toConnectionPayload(conn) } })),
    onSuccess: async () => {
      toast.success(t('project:settingsGeneral.connectionDetailsSaved'))
      await refresh()
    },
  })
  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/organizations/{slug}/projects/test-connection', {
          params: { path: { slug: project.organization_slug } },
          body: toConnectionPayload(conn),
        })
      ),
  })
  const transfer = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/projects/{ref}/transfer', { params: { path: { ref } }, body: { organization_slug: target } })),
    onSuccess: async (p) => {
      setConfirmTransfer(false)
      toast.success(t('project:settingsGeneral.movedTo', { organizationName: p.organization_name }))
      await refresh()
    },
    onError: (e) => {
      setConfirmTransfer(false)
      toast.error(e.message)
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/projects/{ref}', { params: { path: { ref } } })),
    onSuccess: async () => {
      const slug = project.organization_slug
      toast.success(project.stack ? t('project:settingsGeneral.deletingAndItsStack', { name: project.name }) : t('project:settingsGeneral.removedFromSupermixer', { name: project.name }))
      await refresh()
      void navigate({ to: '/org/$slug', params: { slug } })
    },
    onError: (e) => {
      setDeleting(false)
      toast.error(e.message)
    },
  })

  const canUpdate = can(project, 'project:update')
  const canDelete = can(project, 'project:delete')
  const sourceOrg = orgs.find((o) => o.slug === project.organization_slug)
  const transferTargets = orgs.filter((o) => o.slug !== project.organization_slug && o.role === 'owner')
  // The test-connection endpoint is org-scoped; editing implies Owner/Administrator there.
  const testSecretsNeeded = !conn.password && !conn.service_role && !conn.secret

  return (
    <>
      <PageHeader title={t('project:settingsGeneral.general')} size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection title={t('project:settingsGeneral.projectDetails')}>
          <Card>
            <CardContent className="flex flex-col gap-6">
              <FormField label={t('project:settingsGeneral.projectName')} htmlFor="project-name" layout="horizontal">
                <Input id="project-name" value={name} maxLength={64} disabled={!canUpdate} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label={t('project:settingsGeneral.referenceId')} layout="horizontal">
                <CopyField value={project.ref} />
              </FormField>
              {rename.error && <Alert variant="destructive" title={rename.error.message} />}
            </CardContent>
            <CardFooter>
              <Button variant="default" disabled={name === project.name} onClick={() => setName(project.name)}>
                {t('project:settingsGeneral.cancel')}
              </Button>
              <PermissionButton
                allowed={canUpdate}
                action={t('project:settingsGeneral.changeProjectSettings')}
                variant="primary"
                loading={rename.isPending}
                disabled={!name.trim() || name === project.name}
                onClick={() => rename.mutate()}
              >
                {t('project:settingsGeneral.save')}
              </PermissionButton>
            </CardFooter>
          </Card>
        </SettingsSection>

        {canUpdate && !project.stack && (
          <SettingsSection
            title={t('project:settingsGeneral.connection')}
            description={t('project:settingsGeneral.whereSupermixerReachesThisStackLeave')}
          >
            <Card>
              <ConnectionFields value={conn} onChange={setConn} editing keysPresent={project.keys_present} />
              {(test.data || test.error || saveConnection.error) && (
                <div className="flex flex-col gap-3 border-t px-card py-5">
                  {test.data && <HealthChecks report={test.data} />}
                  {(test.error ?? saveConnection.error) && (
                    <Alert variant="destructive" title={(test.error ?? saveConnection.error)!.message} />
                  )}
                </div>
              )}
              <CardFooter>
                <Button
                  variant="default"
                  loading={test.isPending}
                  disabled={testSecretsNeeded}
                  onClick={() => test.mutate()}
                  title={testSecretsNeeded ? t('project:settingsGeneral.enterTheDatabasePasswordAndAn') : undefined}
                >
                  {t('project:settingsGeneral.testConnection')}
                </Button>
                <Button variant="primary" loading={saveConnection.isPending} onClick={() => saveConnection.mutate()}>
                  {t('project:settingsGeneral.saveConnection')}
                </Button>
              </CardFooter>
            </Card>
          </SettingsSection>
        )}

        <ReadOnlyAccess project={project} />

        <SettingsSection
          title={t('project:settingsGeneral.transferProject')}
          description={t('project:settingsGeneral.moveThisProjectToAnotherOrganization')}
        >
          <Card>
            <CardContent className="flex flex-col gap-4">
              {sourceOrg?.role !== 'owner' ? (
                <p className="text-sm text-foreground-lighter">{t('project:settingsGeneral.onlyOwnersOfCanTransferIts', { organizationName: project.organization_name })}</p>
              ) : transferTargets.length === 0 ? (
                <p className="text-sm text-foreground-lighter">{t('project:settingsGeneral.youAreNotAnOwnerOf')}</p>
              ) : (
                <FormField label={t('project:settingsGeneral.destinationOrganization')} layout="horizontal">
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('project:settingsGeneral.chooseAnOrganization')} />
                    </SelectTrigger>
                    <SelectContent>
                      {transferTargets.map((o) => (
                        <SelectItem key={o.slug} value={o.slug}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}
            </CardContent>
            <CardFooter>
              <Button variant="default" disabled={!target} onClick={() => setConfirmTransfer(true)}>
                {t('project:settingsGeneral.transferProject')}
              </Button>
            </CardFooter>
          </Card>
        </SettingsSection>

        <SettingsSection title={t('project:settingsGeneral.dangerZone')}>
          {project.stack ? (
            <Alert
              variant="destructive"
              title={t('project:settingsGeneral.deleteThisProjectAndItsStack')}
              actions={
                <PermissionButton allowed={canDelete} action={t('project:settingsGeneral.deleteThisProject')} variant="danger" onClick={() => setDeleting(true)}>
                  {t('project:settingsGeneral.deleteProject')}
                </PermissionButton>
              }
            >
              {t('project:settingsGeneral.supermixerCreatedThisStackSoDeleting')}
            </Alert>
          ) : (
            <Alert
              variant="destructive"
              title={t('project:settingsGeneral.removeThisProjectFromSupermixer')}
              actions={
                <PermissionButton allowed={canDelete} action={t('project:settingsGeneral.removeThisProject')} variant="danger" onClick={() => setDeleting(true)}>
                  {t('project:settingsGeneral.removeProject')}
                </PermissionButton>
              }
            >
              {t('project:settingsGeneral.supermixerForgetsThisProjectAndIts')}
            </Alert>
          )}
        </SettingsSection>
      </PageContainer>

      <ConfirmDialog
        open={confirmTransfer}
        onOpenChange={setConfirmTransfer}
        variant="warning"
        title={t('project:settingsGeneral.transfer', { name: project.name })}
        description={t('project:settingsGeneral.itWillMoveToMembersOf', { name: orgs.find((o) => o.slug === target)?.name, organizationName: project.organization_name })}
        confirmLabel={t('project:settingsGeneral.transferProject')}
        loading={transfer.isPending}
        onConfirm={() => transfer.mutate()}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={project.stack ? t('project:settingsGeneral.deleteAndItsStack', { name: project.name }) : t('project:settingsGeneral.remove', { name: project.name })}
        description={
          project.stack
            ? t('project:settingsGeneral.itsContainersDatabaseStoredFilesAnd')
            : t('project:settingsGeneral.theSupabaseStackIsNotAffected')
        }
        confirmLabel={project.stack ? t('project:settingsGeneral.deleteProject') : t('project:settingsGeneral.removeProject')}
        confirmText={project.name}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}
