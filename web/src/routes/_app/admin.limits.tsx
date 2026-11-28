/*
 * Instance › Resource Limits: how many organizations one person may create,
 * and how many projects an organization may have. Unlimited unless set.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { AdminLayout } from '@/components/layout/admin-layout'
import { SettingsSection } from '@/components/layout/section'
import { countOf, LimitField, useLimitDraft } from '@/components/limit-field'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { resourceLimitsQuery } from '@/lib/api/queries'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/admin/limits')({
  component: LimitsPage,
})

function LimitsPage() {
  const { data: me } = useProfile()
  const limits = useQuery({ ...resourceLimitsQuery, enabled: !!me?.is_instance_admin })
  const saved = limits.data
  return (
    <AdminLayout
      title={t('admin:adminLimits.resourceLimits')}
      description={t('admin:adminLimits.howMuchPeopleCanCreateOn')}
    >
      {limits.error ? (
        <Alert variant="destructive" title={limits.error.message} />
      ) : !saved ? (
        <Skeleton className="h-64" />
      ) : (
        // Remount after saving, so the form starts from what's saved.
        <LimitsForm
          key={`${saved.max_organizations_per_user}-${saved.max_projects_per_organization}`}
          saved={saved}
        />
      )}
    </AdminLayout>
  )
}

function LimitsForm({ saved }: { saved: Schemas['ResourceLimits'] }) {
  const queryClient = useQueryClient()
  const orgs = useLimitDraft(saved.max_organizations_per_user)
  const projects = useLimitDraft(saved.max_projects_per_organization)
  const dirty = orgs.dirty || projects.dirty
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/admin/limits', {
          body: {
            max_organizations_per_user: orgs.value,
            max_projects_per_organization: projects.value,
          },
        })
      ),
    onSuccess: async (l) => {
      toast.success(t('admin:adminLimits.resourceLimitsSaved'))
      queryClient.setQueryData(resourceLimitsQuery.queryKey, l)
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
  })
  // A valid limit below what someone already has: they keep it, but can't add more.
  const over = (d: typeof orgs, most: number) => d.valid && d.value !== null && most > d.value

  return (
    <SettingsSection title={t('admin:adminLimits.limits')}>
      <Card>
        <CardContent className="flex flex-col gap-8">
          <LimitField
            id="max-orgs"
            label={t('admin:adminLimits.organizationsPerPerson')}
            unit="organizations"
            draft={orgs}
            suggested={Math.max(saved.most_organizations_by_one_person, 1)}
            description={t('admin:adminLimits.howManyOrganizationsOnePersonCan')}
            notice={
              over(orgs, saved.most_organizations_by_one_person) && (
                <Alert
                  variant="warning"
                  title={t('admin:adminLimits.someoneHasAlreadyCreated', { countOf: countOf(saved.most_organizations_by_one_person, 'organization', 'organizations') })}
                >
                  {t('admin:adminLimits.theyKeepThemButCanT')}
                </Alert>
              )
            }
          />
          <LimitField
            id="max-projects"
            label={t('admin:adminLimits.projectsPerOrganization')}
            unit="projects"
            draft={projects}
            suggested={Math.max(saved.most_projects_in_one_organization, 1)}
            description={t('admin:adminLimits.howManyProjectsAnyOneOrganization')}
            notice={
              over(projects, saved.most_projects_in_one_organization) && (
                <Alert
                  variant="warning"
                  title={t('admin:adminLimits.anOrganizationAlreadyHas', { countOf: countOf(saved.most_projects_in_one_organization, 'project', 'projects') })}
                >
                  {t('admin:adminLimits.itKeepsThemButCanT')}
                </Alert>
              )
            }
          />
          {save.error && <Alert variant="destructive" title={save.error.message} />}
        </CardContent>
        <CardFooter>
          <Button
            variant="default"
            disabled={!dirty}
            onClick={() => {
              orgs.reset()
              projects.reset()
            }}
          >
            {t('admin:adminLimits.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !orgs.valid || !projects.valid}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('admin:adminLimits.save')}
          </Button>
        </CardFooter>
      </Card>
    </SettingsSection>
  )
}
