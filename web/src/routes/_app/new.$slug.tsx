import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
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
import { organizationsQuery, uiConfigQuery } from '@/lib/api/queries'
import { cn } from '@/lib/utils'

import { NotFound } from '../__root'

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
      toast.success(`Registered ${project.name}`)
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
    <AppShell title="New project">
      <div className="overflow-y-auto py-12">
        <PageContainer size="medium">
          {!allowed ? (
            <Alert variant="warning" title="You need additional permissions to add projects">
              Only Owners and Administrators of {org.name} can register projects.
            </Alert>
          ) : (
            <div className="flex flex-col gap-6">
              {provisioning && (
                <div role="radiogroup" aria-label="New project" className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ['create', 'Create a new stack', 'Supermixer starts a new Supabase stack on its Docker host.'],
                      ['connect', 'Connect an existing stack', 'Register a self-hosted Supabase stack that is already running.'],
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
                        <h3 className="font-sans text-base font-normal text-foreground">Register a project</h3>
                        <p className="mt-1 text-sm text-foreground-lighter">
                          Connect a self-hosted Supabase stack that is already running. Supermixer manages it; the stack
                          itself is not changed.
                        </p>
                      </div>
                      <Button variant="default" icon={<ArticleIcon />} onClick={() => setImporting(true)}>
                        Fill from Supabase .env
                      </Button>
                    </div>
                    <div className="grid gap-4 border-b px-card py-6 md:grid-cols-12 md:gap-x-6">
                      <div className="md:col-span-4">
                        <h4 className="font-sans text-sm font-normal text-foreground">Project</h4>
                      </div>
                      <div className="flex flex-col gap-4 md:col-span-8">
                        <FormField label="Organization">
                          <Input value={org.name} readOnly />
                        </FormField>
                        <FormField label="Project name" htmlFor="project-name">
                          <Input
                            id="project-name"
                            required
                            maxLength={64}
                            autoFocus
                            placeholder="Production"
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
                              Connection test <HealthBadge status={test.data.status} />
                            </div>
                            <HealthChecks report={test.data} />
                          </>
                        )}
                        {error && <Alert variant="destructive" title={error.message} />}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 border-t px-card py-4">
                      <Button variant="default" onClick={cancel}>
                        Cancel
                      </Button>
                      <div className="flex gap-2">
                        <Button variant="default" loading={test.isPending} onClick={() => test.mutate()}>
                          Test connection
                        </Button>
                        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
                          Create project
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
