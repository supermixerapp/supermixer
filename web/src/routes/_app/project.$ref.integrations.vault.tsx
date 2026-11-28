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
import { t } from '@/lib/i18n'

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
      toast.success(t('integrations:integrationsVault.deleted', { name: s.name ?? t('integrations:integrationsVault.theSecret') }))
      await queryClient.invalidateQueries({ queryKey: secretsKey(ref) })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <IntegrationPage
      projectRef={ref}
      title={t('integrations:integrationsVault.vault')}
      description={t('integrations:integrationsVault.secretsStoredEncryptedInTheDatabase')}
      extension={{ name: 'supabase_vault', schema: 'vault' }}
      about={t('integrations:integrationsVault.createsTheVaultSchemaSecretsAre')}
      actions={
        <PermissionButton allowed={canChange} action={t('integrations:integrationsVault.addSecrets')} variant="primary" icon={<AddIcon />} onClick={() => setEditing('new')}>
          {t('integrations:integrationsVault.addSecret')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={secrets.data}
        loading={secrets.isPending}
        error={secrets.error}
        rowKey={(s) => s.name ?? s.id}
        empty={t('integrations:integrationsVault.noSecretsYet')}
        columns={[
          {
            header: t('integrations:integrationsVault.name'),
            cell: (s) => (
              <span className="flex flex-col">
                <span className="font-mono text-xs text-foreground">{s.name ?? '—'}</span>
                {s.description && <span className="text-xs text-foreground-lighter">{s.description}</span>}
              </span>
            ),
          },
          {
            header: t('integrations:integrationsVault.value'),
            className: 'w-96',
            cell: (s) =>
              revealed[s.id] !== undefined ? (
                <CopyField
                  value={revealed[s.id]!}
                  actions={
                    <Button variant="text" size="tiny" onClick={() => setRevealed(({ [s.id]: _, ...rest }) => rest)}>
                      {t('integrations:integrationsVault.hide')}
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
                      {t('integrations:integrationsVault.reveal')}
                    </Button>
                  )}
                </span>
              ),
          },
          { header: t('integrations:integrationsVault.updated'), cell: (s) => <span className="whitespace-nowrap text-foreground-light">{relativeTime(s.updated_at)}</span> },
        ]}
        actions={[
          { label: t('integrations:integrationsVault.editSecret'), hidden: () => !canChange, onSelect: (s) => setEditing(s) },
          {
            label: t('integrations:integrationsVault.deleteSecret'),
            hidden: () => !canChange,
            confirm: (s) => ({
              title: t('integrations:integrationsVault.delete', { name: s.name ?? t('integrations:integrationsVault.thisSecret') }),
              description: t('integrations:integrationsVault.anythingThatReadsItFromVault'),
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
      toast.success(secret ? t('integrations:integrationsVault.saved', { trim: name.trim() }) : t('integrations:integrationsVault.added', { trim: name.trim() }))
      if (secret) onSaved(secret.id)
      await queryClient.invalidateQueries({ queryKey: secretsKey(projectRef) })
      onClose()
    },
  })
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={secret ? t('integrations:integrationsVault.edit', { name: secret.name ?? t('integrations:integrationsVault.secret') }) : t('integrations:integrationsVault.addASecret')}
      description={t('integrations:integrationsVault.storedEncryptedAnyoneWhoCanRead')}
      error={save.error}
      submitLabel={secret ? t('integrations:integrationsVault.saveSecret') : t('integrations:integrationsVault.addSecret')}
      submitting={save.isPending}
      disabled={!!problem || (!secret && value === '')}
      onSubmit={() => save.mutate()}
    >
      <FormField label={t('integrations:integrationsVault.name')} htmlFor="secret-name" description={problem && name ? <span className="text-destructive">{problem}</span> : t('integrations:integrationsVault.howSqlFindsItEG')}>
        <Input id="secret-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label={t('integrations:integrationsVault.value')} htmlFor="secret-value" description={secret ? t('integrations:integrationsVault.leaveEmptyToKeepTheCurrent') : undefined}>
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
      <FormField label={t('integrations:integrationsVault.description')} htmlFor="secret-description">
        <Input id="secret-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
    </EditorSheet>
  )
}
