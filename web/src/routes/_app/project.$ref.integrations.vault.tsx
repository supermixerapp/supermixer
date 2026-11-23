import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, useCanChange } from '@/components/database/catalog-page'
import { AddIcon, VisibilityIcon } from '@/components/icons'
import { IntegrationPage, useExtension } from '@/components/integrations/integration-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet } from '@/components/table-editor/sheets'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { pgQuery, rowsOf, runSql } from '@/lib/pg/run'
import {
  CREATE_SECRET_SQL,
  DELETE_SECRET_SQL,
  REVEAL_SQL,
  SECRETS_SQL,
  secretNameProblem,
  UPDATE_SECRET_SQL,
  type VaultSecret,
} from '@/lib/pg/vault'

export const Route = createFileRoute('/_app/project/$ref/integrations/vault')({
  component: VaultPage,
})

const secretsKey = (ref: string) => ['projects', ref, 'pg', 'vault-secrets']

function VaultPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const ext = useExtension(ref, 'supabase_vault')
  const secrets = useQuery({ ...pgQuery<VaultSecret>(ref, ['vault-secrets'], SECRETS_SQL), enabled: !!ext.state?.installed_version })
  const canChange = useCanChange()
  const canReveal = can(project, 'project:secrets:read')
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<VaultSecret | 'new' | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})

  const reveal = useMutation<string, Error, string>({
    mutationFn: async (id) => rowsOf<{ value: string | null }>(await runSql(ref, REVEAL_SQL, { params: [id] }))[0]?.value ?? '',
    onSuccess: (value, id) => setRevealed((r) => ({ ...r, [id]: value })),
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation<unknown, Error, VaultSecret>({
    mutationFn: (s) => runSql(ref, DELETE_SECRET_SQL, { params: [s.id] }),
    onSuccess: async (_, s) => {
      toast.success(`Deleted ${s.name ?? 'the secret'}`)
      await queryClient.invalidateQueries({ queryKey: secretsKey(ref) })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <IntegrationPage
      projectRef={ref}
      title="Vault"
      description="Secrets stored encrypted in the database. Read them in SQL from vault.decrypted_secrets, for example in cron jobs or webhooks."
      extension={{ name: 'supabase_vault', schema: 'vault' }}
      about="Creates the vault schema. Secrets are encrypted with a key Postgres keeps outside the database."
      actions={
        <PermissionButton allowed={canChange} action="add secrets" variant="primary" icon={<AddIcon />} onClick={() => setEditing('new')}>
          Add secret
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={secrets.data}
        loading={secrets.isPending}
        error={secrets.error}
        rowKey={(s) => s.name ?? s.id}
        empty="No secrets yet"
        columns={[
          {
            header: 'Name',
            cell: (s) => (
              <span className="flex flex-col">
                <span className="font-mono text-xs text-foreground">{s.name ?? '—'}</span>
                {s.description && <span className="text-xs text-foreground-lighter">{s.description}</span>}
              </span>
            ),
          },
          {
            header: 'Value',
            className: 'w-96',
            cell: (s) =>
              revealed[s.id] !== undefined ? (
                <CopyField
                  value={revealed[s.id]!}
                  actions={
                    <Button variant="text" size="tiny" onClick={() => setRevealed(({ [s.id]: _, ...rest }) => rest)}>
                      Hide
                    </Button>
                  }
                />
              ) : (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground-lighter">••••••••••••</span>
                  {canReveal && (
                    <Button
                      variant="text"
                      size="tiny"
                      icon={<VisibilityIcon />}
                      loading={reveal.isPending && reveal.variables === s.id}
                      onClick={() => reveal.mutate(s.id)}
                    >
                      Reveal
                    </Button>
                  )}
                </span>
              ),
          },
          { header: 'Updated', cell: (s) => <span className="whitespace-nowrap text-foreground-light">{relativeTime(s.updated_at)}</span> },
        ]}
        actions={[
          { label: 'Edit secret', hidden: () => !canChange, onSelect: (s) => setEditing(s) },
          {
            label: 'Delete secret',
            hidden: () => !canChange,
            confirm: (s) => ({
              title: `Delete ${s.name ?? 'this secret'}?`,
              description: 'Anything that reads it from vault.decrypted_secrets stops finding it. This can’t be undone.',
            }),
            onSelect: (s) => remove.mutate(s),
          },
        ]}
      />
      {editing && (
        <SecretSheet
          projectRef={ref}
          secret={editing === 'new' ? null : editing}
          taken={(secrets.data ?? []).filter((s) => editing === 'new' || s.id !== editing.id).flatMap((s) => (s.name ? [s.name] : []))}
          onClose={() => setEditing(null)}
          onSaved={(id) => setRevealed(({ [id]: _, ...rest }) => rest)}
        />
      )}
    </IntegrationPage>
  )
}

function SecretSheet({
  projectRef,
  secret,
  taken,
  onClose,
  onSaved,
}: {
  projectRef: string
  secret: VaultSecret | null
  taken: string[]
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(secret?.name ?? '')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState(secret?.description ?? '')
  const problem = secretNameProblem(name, taken)
  const save = useMutation<unknown, Error>({
    // The value is a bound parameter: it never appears in the statement text.
    mutationFn: () =>
      secret
        ? runSql(projectRef, UPDATE_SECRET_SQL, { params: [secret.id, value === '' ? null : value, name.trim(), description] })
        : runSql(projectRef, CREATE_SECRET_SQL, { params: [value, name.trim(), description] }),
    onSuccess: async () => {
      toast.success(secret ? `Saved ${name.trim()}` : `Added ${name.trim()}`)
      if (secret) onSaved(secret.id)
      await queryClient.invalidateQueries({ queryKey: secretsKey(projectRef) })
      onClose()
    },
  })
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={secret ? `Edit ${secret.name ?? 'secret'}` : 'Add a secret'}
      description="Stored encrypted. Anyone who can read vault.decrypted_secrets can read it."
      error={save.error}
      submitLabel={secret ? 'Save secret' : 'Add secret'}
      submitting={save.isPending}
      disabled={!!problem || (!secret && value === '')}
      onSubmit={() => save.mutate()}
    >
      <FormField label="Name" htmlFor="secret-name" description={problem && name ? <span className="text-destructive">{problem}</span> : 'How SQL finds it, e.g. stripe_api_key.'}>
        <Input id="secret-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label="Value" htmlFor="secret-value" description={secret ? 'Leave empty to keep the current value.' : undefined}>
        <Textarea
          id="secret-value"
          rows={3}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </FormField>
      <FormField label="Description" htmlFor="secret-description">
        <Input id="secret-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
    </EditorSheet>
  )
}
