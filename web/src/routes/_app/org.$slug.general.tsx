import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { can, useSelectedOrganization } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/org/$slug/general')({
  component: OrgGeneralPage,
})

function OrgGeneralPage() {
  const { slug } = Route.useParams()
  const org = useSelectedOrganization()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(org?.name ?? '')
  const [deleting, setDeleting] = useState(false)
  useEffect(() => setName(org?.name ?? ''), [org?.name])

  const canUpdate = can(org, 'org:update')
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH('/organizations/{slug}', { params: { path: { slug } }, body: { name } })),
    onSuccess: async () => {
      toast.success('Organization updated')
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/organizations/{slug}', { params: { path: { slug } } })),
    onSuccess: async () => {
      toast.success(`Deleted ${org?.name}`)
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      void navigate({ to: '/organizations' })
    },
    onError: (e) => {
      setDeleting(false)
      toast.error(e.message)
    },
  })

  if (!org) return null
  return (
    <>
      <PageHeader title="General" size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection title="Organization details">
          <Card>
            <CardContent className="flex flex-col gap-6">
              <FormField label="Organization name" htmlFor="org-name" layout="horizontal">
                <Input id="org-name" value={name} maxLength={64} disabled={!canUpdate} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label="Organization slug" layout="horizontal" description="Used in URLs. It does not change.">
                <CopyField value={org.slug} />
              </FormField>
              {save.error && <Alert variant="destructive" title={save.error.message} />}
            </CardContent>
            <CardFooter>
              <Button variant="default" disabled={name === org.name} onClick={() => setName(org.name)}>
                Cancel
              </Button>
              <PermissionButton
                allowed={canUpdate}
                action="update organization settings"
                variant="primary"
                loading={save.isPending}
                disabled={!name.trim() || name === org.name}
                onClick={() => save.mutate()}
              >
                Save
              </PermissionButton>
            </CardFooter>
          </Card>
        </SettingsSection>

        <SettingsSection title="Danger zone">
          <Alert
            variant="destructive"
            title="Delete this organization"
            actions={
              <PermissionButton
                allowed={can(org, 'org:delete')}
                action="delete this organization"
                variant="danger"
                onClick={() => setDeleting(true)}
              >
                Delete organization
              </PermissionButton>
            }
          >
            Removes the organization, its members and invitations. Projects must be transferred or removed first;
            {org.project_count > 0
              ? ` this organization still has ${org.project_count} project${org.project_count === 1 ? '' : 's'}.`
              : ' it has none.'}
          </Alert>
        </SettingsSection>
      </PageContainer>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${org.name}?`}
        description="This cannot be undone."
        confirmLabel="Delete organization"
        confirmText={org.slug}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}
