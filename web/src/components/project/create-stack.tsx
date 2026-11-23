/*
 * Create a new self-hosted Supabase stack (Stage 4): Supermixer generates its
 * secrets, picks its ports and starts it with docker compose.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'

export function CreateStackForm({
  org,
  template,
  onCancel,
}: {
  org: { slug: string; name: string }
  template: string
  onCancel: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/organizations/{slug}/projects/new-stack', {
          params: { path: { slug: org.slug } },
          body: { name: name.trim() },
        })
      ),
    onSuccess: async (project) => {
      toast.success(`Creating ${project.name}`)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      void navigate({ to: '/project/$ref', params: { ref: project.ref } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <form onSubmit={submit}>
      <Card>
        <div className="border-b px-card py-4">
          <h3 className="font-sans text-base font-normal text-foreground">Create a new stack</h3>
          <p className="mt-1 text-sm text-foreground-lighter">
            Supermixer starts a new self-hosted Supabase stack on this server&apos;s Docker, with
            its own database, keys and ports.
          </p>
        </div>
        <div className="grid gap-4 border-b px-card py-6 md:grid-cols-12 md:gap-x-6">
          <div className="md:col-span-4">
            <h4 className="font-sans text-sm font-normal text-foreground">Project</h4>
          </div>
          <div className="flex flex-col gap-4 md:col-span-8">
            <FormField label="Organization">
              <Input value={org.name} readOnly />
            </FormField>
            <FormField label="Project name" htmlFor="stack-name">
              <Input
                id="stack-name"
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
        <div className="grid gap-4 px-card py-6 md:grid-cols-12 md:gap-x-6">
          <div className="md:col-span-4">
            <h4 className="font-sans text-sm font-normal text-foreground">What happens</h4>
          </div>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-foreground-light md:col-span-8">
            <li>
              Every secret is generated for this stack: database password, JWT secret, API keys and
              encryption keys.
            </li>
            <li>
              It gets its own ports for the API and Postgres from the ranges this server is
              configured with.
            </li>
            <li>
              It runs Supabase&apos;s official Docker setup at{' '}
              <span className="font-mono text-xs" title={template}>
                {template.slice(0, 7)}
              </span>
              , with log analytics. The first stack can take several minutes while images download.
            </li>
          </ul>
        </div>
        {create.error && (
          <div className="border-t px-card py-4">
            <Alert variant="destructive" title={create.error.message} />
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t px-card py-4">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Create stack
          </Button>
        </div>
      </Card>
    </form>
  )
}
