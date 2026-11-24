import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useProfile, useSelectedOrganization } from '@/lib/api/hooks'
import { membersQuery } from '@/lib/api/queries'

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

        <OrgSecurity org={org} />

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

/** Requiring two-factor sign-in of every member. */
function OrgSecurity({ org }: { org: Schemas['Organization'] }) {
  const { data: me } = useProfile()
  const queryClient = useQueryClient()
  const canUpdate = can(org, 'org:update')
  const members = useQuery({ ...membersQuery(org.slug), enabled: can(org, 'members:read') })
  const without = (members.data ?? []).filter((m) => !m.mfa_enabled)
  const [confirming, setConfirming] = useState(false)
  const set = useMutation({
    mutationFn: (on: boolean) =>
      unwrap(api.PATCH('/organizations/{slug}', { params: { path: { slug: org.slug } }, body: { mfa_required: on } })),
    onSuccess: async (o) => {
      setConfirming(false)
      toast.success(o.mfa_required ? 'Two-factor sign-in is now required' : 'Two-factor sign-in is no longer required')
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
    onError: (e) => toast.error(e.message),
  })
  // Requiring it without having it would lock you out.
  const needOwn = !org.mfa_required && !me?.mfa_enabled
  return (
    <SettingsSection title="Security">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-1">
              <Label htmlFor="org-mfa">Require two-factor sign-in</Label>
              <p className="text-sm text-foreground-lighter">
                Members must sign in with a code from an authenticator app as well as their password. Until they turn
                it on, they can see this organization&apos;s name and leave it, nothing else.
              </p>
            </div>
            <Switch
              id="org-mfa"
              checked={org.mfa_required}
              disabled={!canUpdate || needOwn || set.isPending}
              onCheckedChange={(on) => (on ? setConfirming(true) : set.mutate(false))}
            />
          </div>
          {!canUpdate ? (
            <p className="text-xs text-foreground-lighter">Only Owners can change this.</p>
          ) : (
            needOwn && (
              <p className="text-xs text-foreground-lighter">
                Turn on two-factor sign-in for your own account first, under{' '}
                <Link to="/account/security" className="text-link">
                  Account › Security
                </Link>
                .
              </p>
            )
          )}
          {org.mfa_required && without.length > 0 && (
            <Alert variant="warning" title={`${without.length} ${without.length === 1 ? 'member hasn’t' : 'members haven’t'} turned it on`}>
              {without.map((m) => m.username).join(', ')} can&apos;t open this organization until they do.
            </Alert>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title="Require two-factor sign-in?"
        description={
          without.length > 0
            ? `${without.map((m) => m.username).join(', ')} ${without.length === 1 ? 'doesn’t' : 'don’t'} use it yet, and won’t be able to open this organization or its projects until they turn it on.`
            : 'Every member already uses it. New members will need it too.'
        }
        confirmLabel="Require it"
        loading={set.isPending}
        onConfirm={() => set.mutate(true)}
      />
    </SettingsSection>
  )
}
