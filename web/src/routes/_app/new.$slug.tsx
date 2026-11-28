import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { HealthBadge } from '@/components/health-badge'
import { ArticleIcon } from '@/components/icons'
import { AppShell } from '@/components/layout/app-shell'
import { PageContainer } from '@/components/layout/page'
import {
  ConnectionFields,
  emptyConnection,
  EnvImportDialog,
  HealthChecks,
  toConnectionPayload,
  type ConnectionValue,
} from '@/components/project/connection-form'
import { CreateStackForm } from '@/components/project/create-stack'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { organizationLimitsQuery, organizationsQuery, uiConfigQuery } from '@/lib/api/queries'
import { cn } from '@/lib/utils'

import { NotFound } from '../__root'
import { t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/new/$slug')({
  loader: async ({ context, params }) => {
    const orgs = await context.queryClient.ensureQueryData(organizationsQuery)
    const org = orgs.find((o) => o.slug === params.slug)
    if (!org) throw notFound()
    return { org }
  },
  component: NewProjectPage,
  notFoundComponent: NotFound,
})

function NewProjectPage() {
  const { org } = Route.useLoaderData()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [conn, setConn] = useState<ConnectionValue>(emptyConnection)
  const [importing, setImporting] = useState(false)
  const allowed = can(org, 'projects:create')
  const limits = useQuery(organizationLimitsQuery(org.slug)).data
  const limit = limits?.project_limit ?? null
  const full = limit !== null && (limits?.project_count ?? 0) >= limit
  const ui = useQuery(uiConfigQuery)
  const provisioning = ui.data?.provisioning.enabled ?? false
  const [mode, setMode] = useState<'create' | 'connect'>('create')
  const cancel = () => navigate({ to: '/org/$slug', params: { slug: org.slug } })

  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/organizations/{slug}/projects/test-connection', {
          params: { path: { slug: org.slug } },
          body: toConnectionPayload(conn),
        })
      ),
  })
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/organizations/{slug}/projects', {
          params: { path: { slug: org.slug } },
          body: { name, connection: toConnectionPayload(conn) },
        })
      ),
    onSuccess: async (project) => {
      toast.success(t('org:new.registered', { name: project.name }))
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      void navigate({ to: '/project/$ref', params: { ref: project.ref } })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  const error = create.error ?? test.error

  return (
    <AppShell title={t('org:new.newProject')}>
      <div className="overflow-y-auto py-12">
        <PageContainer size="medium">
          {!allowed ? (
            <Alert variant="warning" title={t('org:new.youNeedAdditionalPermissionsToAdd')}>
              {t('org:new.onlyOwnersAndAdministratorsOfCan', { name: org.name })}
            </Alert>
          ) : full ? (
            <Alert
              variant="warning"
              title={t('org:new.hasReachedItsLimitOf', { name: org.name, count: limit })}
            >
              <Trans i18nKey="org:new.removeAProjectFirstOrRaise" components={{ link: <Link to="/org/$slug/general" params={{ slug: org.slug }} className="text-link" /> }} />
            </Alert>
          ) : (
            <div className="flex flex-col gap-6">
              {provisioning && (
                <div role="radiogroup" aria-label={t('org:new.newProject')} className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ['create', t('org:new.createANewStack'), t('org:new.supermixerStartsANewSupabaseStack')],
                      ['connect', t('org:new.connectAnExistingStack'), t('org:new.registerASelfHostedSupabaseStack')],
                    ] as const
                  ).map(([value, title, text]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={mode === value}
                      onClick={() => setMode(value)}
                      className={cn(
                        'flex flex-col gap-1 rounded-panel border px-4 py-3 text-left focus-ring',
                        mode === value ? 'border-primary-bright bg-surface-100' : 'hover:border-strong'
                      )}
                    >
                      <span className="text-sm text-foreground">{title}</span>
                      <span className="text-xs text-foreground-lighter">{text}</span>
                    </button>
                  ))}
                </div>
              )}
              {provisioning && mode === 'create' ? (
                <CreateStackForm org={org} template={ui.data?.provisioning.template ?? ''} onCancel={cancel} />
              ) : (
                <form onSubmit={submit}>
                  <Card>
                    <div className="flex items-start justify-between gap-4 border-b px-card py-4">
                      <div>
                        <h3 className="font-sans text-base font-normal text-foreground">{t('org:new.registerAProject')}</h3>
                        <p className="mt-1 text-sm text-foreground-lighter">
                          {t('org:new.connectASelfHostedSupabaseStack')}
                        </p>
                      </div>
                      <Button variant="default" icon={<ArticleIcon />} onClick={() => setImporting(true)}>
                        {t('org:new.fillFromSupabaseEnv')}
                      </Button>
                    </div>
                    <div className="grid gap-4 border-b px-card py-6 md:grid-cols-12 md:gap-x-6">
                      <div className="md:col-span-4">
                        <h4 className="font-sans text-sm font-normal text-foreground">{t('org:new.project')}</h4>
                      </div>
                      <div className="flex flex-col gap-4 md:col-span-8">
                        <FormField label={t('org:new.organization')}>
                          <Input value={org.name} readOnly />
                        </FormField>
                        <FormField label={t('org:new.projectName')} htmlFor="project-name">
                          <Input
                            id="project-name"
                            required
                            maxLength={64}
                            autoFocus
                            placeholder={t('org:new.production')}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </FormField>
                      </div>
                    </div>
                    <ConnectionFields value={conn} onChange={setConn} />
                    {(test.data || error) && (
                      <div className="flex flex-col gap-3 border-t px-card py-5">
                        {test.data && (
                          <>
                            <div className="flex items-center gap-2 text-sm">
                              <Trans i18nKey="org:new.connectionTest" components={{ healthbadge: <HealthBadge status={test.data.status} /> }} />
                            </div>
                            <HealthChecks report={test.data} />
                          </>
                        )}
                        {error && <Alert variant="destructive" title={error.message} />}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 border-t px-card py-4">
                      <Button variant="default" onClick={cancel}>
                        {t('org:new.cancel')}
                      </Button>
                      <div className="flex gap-2">
                        <Button variant="default" loading={test.isPending} onClick={() => test.mutate()}>
                          {t('org:new.testConnection')}
                        </Button>
                        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
                          {t('org:new.createProject')}
                        </Button>
                      </div>
                    </div>
                  </Card>
                </form>
              )}
            </div>
          )}
        </PageContainer>
      </div>
      <EnvImportDialog open={importing} onOpenChange={setImporting} onImport={(v) => setConn((c) => ({ ...c, ...v }))} />
    </AppShell>
  )
}
