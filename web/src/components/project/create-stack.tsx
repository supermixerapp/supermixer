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
import { t, Trans } from '@/lib/i18n'

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
      toast.success(t('project:createStack.creating', { name: project.name }))
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
          <h3 className="font-sans text-base font-normal text-foreground">{t('project:createStack.createANewStack')}</h3>
          <p className="mt-1 text-sm text-foreground-lighter">
            {t('project:createStack.supermixerStartsANewSelfHosted')}
          </p>
        </div>
        <div className="grid gap-4 border-b px-card py-6 md:grid-cols-12 md:gap-x-6">
          <div className="md:col-span-4">
            <h4 className="font-sans text-sm font-normal text-foreground">{t('project:createStack.project')}</h4>
          </div>
          <div className="flex flex-col gap-4 md:col-span-8">
            <FormField label={t('project:createStack.organization')}>
              <Input value={org.name} readOnly />
            </FormField>
            <FormField label={t('project:createStack.projectName')} htmlFor="stack-name">
              <Input
                id="stack-name"
                required
                maxLength={64}
                autoFocus
                placeholder={t('project:createStack.production')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
          </div>
        </div>
        <div className="grid gap-4 px-card py-6 md:grid-cols-12 md:gap-x-6">
          <div className="md:col-span-4">
            <h4 className="font-sans text-sm font-normal text-foreground">{t('project:createStack.whatHappens')}</h4>
          </div>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-foreground-light md:col-span-8">
            <li>
              {t('project:createStack.everySecretIsGeneratedForThis')}
            </li>
            <li>
              {t('project:createStack.itGetsItsOwnPortsFor')}
            </li>
            <li>
              <Trans i18nKey="project:createStack.itRunsSupabaseSOfficialDocker" values={{ slice: template.slice(0, 7) }} components={{ span: <span className="font-mono text-xs" title={template} /> }} />
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
            {t('project:createStack.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!name.trim()}
          >
            {t('project:createStack.createStack')}
          </Button>
        </div>
      </Card>
    </form>
  )
}
