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
      toast.success('Project renamed')
      await refresh()
    },
  })
  const saveConnection = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH('/projects/{ref}', { params: { path: { ref } }, body: { connection: toConnectionPayload(conn) } })),
    onSuccess: async () => {
      toast.success('Connection details saved')
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
      toast.success(`Moved to ${p.organization_name}`)
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
      toast.success(`Removed ${project.name} from Supermixer`)
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
      <PageHeader title="General" size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection title="Project details">
          <Card>
            <CardContent className="flex flex-col gap-6">
              <FormField label="Project name" htmlFor="project-name" layout="horizontal">
                <Input id="project-name" value={name} maxLength={64} disabled={!canUpdate} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label="Reference ID" layout="horizontal">
                <CopyField value={project.ref} />
              </FormField>
              {rename.error && <Alert variant="destructive" title={rename.error.message} />}
            </CardContent>
            <CardFooter>
              <Button variant="default" disabled={name === project.name} onClick={() => setName(project.name)}>
                Cancel
              </Button>
              <PermissionButton
                allowed={canUpdate}
                action="change project settings"
                variant="primary"
                loading={rename.isPending}
                disabled={!name.trim() || name === project.name}
                onClick={() => rename.mutate()}
              >
                Save
              </PermissionButton>
            </CardFooter>
          </Card>
        </SettingsSection>

        {canUpdate && (
          <SettingsSection
            title="Connection"
            description="Where Supermixer reaches this stack. Leave secret fields blank to keep their current values."
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
                  title={testSecretsNeeded ? 'Enter the database password and an admin key to test' : undefined}
                >
                  Test connection
                </Button>
                <Button variant="primary" loading={saveConnection.isPending} onClick={() => saveConnection.mutate()}>
                  Save connection
                </Button>
              </CardFooter>
            </Card>
          </SettingsSection>
        )}

        <SettingsSection
          title="Transfer project"
          description="Move this project to another organization where you are an Owner. Project-scoped roles are removed."
        >
          <Card>
            <CardContent className="flex flex-col gap-4">
              {sourceOrg?.role !== 'owner' ? (
                <p className="text-sm text-foreground-lighter">Only Owners of {project.organization_name} can transfer its projects.</p>
              ) : transferTargets.length === 0 ? (
                <p className="text-sm text-foreground-lighter">You are not an Owner of any other organization.</p>
              ) : (
                <FormField label="Destination organization" layout="horizontal">
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose an organization" />
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
                Transfer project
              </Button>
            </CardFooter>
          </Card>
        </SettingsSection>

        <SettingsSection title="Danger zone">
          <Alert
            variant="destructive"
            title="Remove this project from Supermixer"
            actions={
              <PermissionButton allowed={canDelete} action="remove this project" variant="danger" onClick={() => setDeleting(true)}>
                Remove project
              </PermissionButton>
            }
          >
            Supermixer forgets this project and its stored credentials. The Supabase stack itself keeps running and is
            not changed.
          </Alert>
        </SettingsSection>
      </PageContainer>

      <ConfirmDialog
        open={confirmTransfer}
        onOpenChange={setConfirmTransfer}
        variant="warning"
        title={`Transfer ${project.name}?`}
        description={`It will move to ${orgs.find((o) => o.slug === target)?.name}. Members of ${project.organization_name} lose access unless they also belong there.`}
        confirmLabel="Transfer project"
        loading={transfer.isPending}
        onConfirm={() => transfer.mutate()}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Remove ${project.name}?`}
        description="The Supabase stack is not affected. You can register it again later."
        confirmLabel="Remove project"
        confirmText={project.name}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}
