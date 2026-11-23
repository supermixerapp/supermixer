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
            <DialogTitle>Create a new organization</DialogTitle>
            <DialogDescription>Organizations group projects and the people who work on them.</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            <FormField label="Name" htmlFor="org-name" description="Your company or team name. You can change it later.">
              <Input id="org-name" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            {create.error && <Alert variant="destructive" title={create.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
