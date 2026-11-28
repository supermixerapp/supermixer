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
import { t, Trans } from '@/lib/i18n'

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
      toast.success(t('org:general.organizationUpdated'))
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/organizations/{slug}', { params: { path: { slug } } })),
    onSuccess: async () => {
      toast.success(t('org:general.deleted', { name: org.name }))
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
      <PageHeader title={t('org:general.general')} size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection title={t('org:general.organizationDetails')}>
          <Card>
            <CardContent className="flex flex-col gap-6">
              <FormField label={t('org:general.organizationName')} htmlFor="org-name" layout="horizontal">
                <Input id="org-name" value={name} maxLength={64} disabled={!canUpdate} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label={t('org:general.organizationSlug')} layout="horizontal" description={t('org:general.usedInUrlsItDoesNot')}>
                <CopyField value={org.slug} />
              </FormField>
              {save.error && <Alert variant="destructive" title={save.error.message} />}
            </CardContent>
            <CardFooter>
              <Button variant="default" disabled={name === org.name} onClick={() => setName(org.name)}>
                {t('org:general.cancel')}
              </Button>
              <PermissionButton
                allowed={canUpdate}
                action={t('org:general.updateOrganizationSettings')}
                variant="primary"
                loading={save.isPending}
                disabled={!name.trim() || name === org.name}
                onClick={() => save.mutate()}
              >
                {t('org:general.save')}
              </PermissionButton>
            </CardFooter>
          </Card>
        </SettingsSection>

        <OrgLimits org={org} />

        <SettingsSection title={t('org:general.security')}>
          <Alert title={t('org:general.twoFactorSignInAndSingle')}>
            <Trans i18nKey="org:general.requireThemForMembersUnderOrganization" components={{ link: <Link to="/org/$slug/security" params={{ slug }} className="text-link" />, link2: <Link to="/org/$slug/sso" params={{ slug }} className="text-link" /> }} />
          </Alert>
        </SettingsSection>

        <SettingsSection title={t('org:general.dangerZone')}>
          <Alert
            variant="destructive"
            title={t('org:general.deleteThisOrganization')}
            actions={
              <PermissionButton
                allowed={can(org, 'org:delete')}
                action={t('org:general.deleteThisOrganization2')}
                variant="danger"
                onClick={() => setDeleting(true)}
              >
                {t('org:general.deleteOrganization')}
              </PermissionButton>
            }
          >
            {org.project_count > 0
              ? t('org:general.removesTheOrganizationStillHas', { count: org.project_count })
              : t('org:general.removesTheOrganizationHasNone')}
          </Alert>
        </SettingsSection>
      </PageContainer>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('org:general.delete', { name: org.name })}
        description={t('org:general.thisCannotBeUndone')}
        confirmLabel={t('org:general.deleteOrganization')}
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
    <SettingsSection title={t('org:general.resourceLimits')}>
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
      toast.success(t('org:general.projectLimitSaved'))
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
  })
  const limit = saved.project_limit ?? null
  const count = saved.project_count
  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <FormField label={t('org:general.projects')} layout="horizontal">
          <p className="pt-2 text-sm text-foreground">
            {limit === null
              ? t('org:general.noLimit', { count })
              : t('org:general.ofUsed', { used: count, count: limit })}
          </p>
        </FormField>
        <LimitField
          id="org-max-projects"
          label={t('org:general.projectLimit')}
          unit="projects"
          draft={draft}
          disabled={!canChange}
          suggested={Math.max(count, 1)}
          description={
            instanceMax === null
              ? t('org:general.theMostProjectsThisOrganizationCan')
              : t('org:general.theMostProjectsThisOrganizationCan2', { instanceMax })
          }
          notice={
            draft.on &&
            draft.valid &&
            draft.value !== null &&
            draft.value < count && (
              <Alert variant="warning" title={t('org:general.thisOrganizationAlreadyHas', { countOf: countOf(count, 'project', 'projects') })}>
                {t('org:general.itKeepsThemButCanT')}
              </Alert>
            )
          }
        />
        {!canChange && <p className="text-xs text-foreground-lighter">{t('org:general.onlyOwnersAndAdministratorsCanChange')}</p>}
        {save.error && <Alert variant="destructive" title={save.error.message} />}
      </CardContent>
      <CardFooter>
        <Button variant="default" disabled={!draft.dirty} onClick={draft.reset}>
          {t('org:general.cancel')}
        </Button>
        <PermissionButton
          allowed={canChange}
          action={t('org:general.changeThisOrganizationSLimits')}
          variant="primary"
          loading={save.isPending}
          disabled={!draft.dirty || !draft.valid}
          onClick={() => save.mutate()}
        >
          {t('org:general.save')}
        </PermissionButton>
      </CardFooter>
    </Card>
  )
}
