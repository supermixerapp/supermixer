import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api/client'
import { t } from '@/lib/i18n'

export function NewOrganizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/organizations', { body: { name } })),
    onSuccess: async (org) => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      onOpenChange(false)
      setName('')
      void navigate({ to: '/org/$slug', params: { slug: org.slug } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="small">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('org:newOrganizationDialog.createANewOrganization')}</DialogTitle>
            <DialogDescription>{t('org:newOrganizationDialog.organizationsGroupProjectsAndThePeople')}</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            <FormField label={t('org:newOrganizationDialog.name')} htmlFor="org-name" description={t('org:newOrganizationDialog.yourCompanyOrTeamNameYou')}>
              <Input id="org-name" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            {create.error && <Alert variant="destructive" title={create.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={() => onOpenChange(false)}>
              {t('org:newOrganizationDialog.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
              {t('org:newOrganizationDialog.createOrganization')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
