import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { countOf, LimitField, MAX_LIMIT, useLimitDraft } from '@/components/limit-field'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedOrganization } from '@/lib/api/hooks'
import { organizationLimitsQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/org/$slug/general')({
  component: OrgGeneralPage,
})

function OrgGeneralPage() {
  const org = useSelectedOrganization()
  // Remount when the saved name changes so the form starts from it.
  return org ? <OrgGeneral key={org.name} org={org} /> : null
}

function OrgGeneral({ org }: { org: Schemas['Organization'] }) {
  const slug = org.slug
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(org.name)
  const [deleting, setDeleting] = useState(false)

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
      toast.success(`Deleted ${org.name}`)
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      void navigate({ to: '/organizations' })
    },
    onError: (e) => {
      setDeleting(false)
      toast.error(e.message)
    },
  })

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

        <OrgLimits org={org} />

        <SettingsSection title="Security">
          <Alert title="Two-factor sign-in and single sign-on">
            Require them for members under{' '}
            <Link to="/org/$slug/security" params={{ slug }} className="text-link">
              Organization Settings › Security
            </Link>{' '}
            and{' '}
            <Link to="/org/$slug/sso" params={{ slug }} className="text-link">
              SSO
            </Link>
            .
          </Alert>
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

/** The organization's own project limit, within the instance's (Owners and Administrators). */
function OrgLimits({ org }: { org: Schemas['Organization'] }) {
  const limits = useQuery(organizationLimitsQuery(org.slug))
  return (
    <SettingsSection title="Resource limits">
      {limits.error ? (
        <Alert variant="destructive" title={limits.error.message} />
      ) : !limits.data ? (
        <Skeleton className="h-40" />
      ) : (
        // Remount after saving, so the form starts from what's saved.
        <OrgLimitsForm key={String(limits.data.max_projects)} org={org} saved={limits.data} />
      )}
    </SettingsSection>
  )
}

function OrgLimitsForm({ org, saved }: { org: Schemas['Organization']; saved: Schemas['OrganizationLimits'] }) {
  const queryClient = useQueryClient()
  const canChange = can(org, 'org:limits:update')
  const instanceMax = saved.instance_max_projects ?? null
  const draft = useLimitDraft(saved.max_projects ?? null, instanceMax ?? MAX_LIMIT)
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/organizations/{slug}/limits', {
          params: { path: { slug: org.slug } },
          body: { max_projects: draft.value },
        })
      ),
    onSuccess: async () => {
      toast.success('Project limit saved')
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
  })
  const limit = saved.project_limit ?? null
  const count = saved.project_count
  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <FormField label="Projects" layout="horizontal">
          <p className="pt-2 text-sm text-foreground">
            {limit === null
              ? `${count} ${count === 1 ? 'project' : 'projects'}, no limit`
              : `${count} of ${limit} ${limit === 1 ? 'project' : 'projects'} used`}
          </p>
        </FormField>
        <LimitField
          id="org-max-projects"
          label="Project limit"
          unit="projects"
          draft={draft}
          disabled={!canChange}
          suggested={Math.max(count, 1)}
          description={
            instanceMax === null
              ? 'The most projects this organization can have. This instance has no limit of its own.'
              : `The most projects this organization can have, up to ${instanceMax}, this instance's limit. Unlimited means the instance's limit applies.`
          }
          notice={
            draft.on &&
            draft.valid &&
            draft.value !== null &&
            draft.value < count && (
              <Alert variant="warning" title={`This organization already has ${countOf(count, 'project', 'projects')}`}>
                It keeps them, but can&apos;t add more until it&apos;s under the limit.
              </Alert>
            )
          }
        />
        {!canChange && <p className="text-xs text-foreground-lighter">Only Owners and Administrators can change this.</p>}
        {save.error && <Alert variant="destructive" title={save.error.message} />}
      </CardContent>
      <CardFooter>
        <Button variant="default" disabled={!draft.dirty} onClick={draft.reset}>
          Cancel
        </Button>
        <PermissionButton
          allowed={canChange}
          action="change this organization's limits"
          variant="primary"
          loading={save.isPending}
          disabled={!draft.dirty || !draft.valid}
          onClick={() => save.mutate()}
        >
          Save
        </PermissionButton>
      </CardFooter>
    </Card>
  )
}
