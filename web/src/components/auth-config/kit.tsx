/*
 * Auth settings of stacks Supermixer created (Stage 4.3): one kit for every
 * Authentication › Configuration page. Each section edits a few settings and
 * saves only the ones that changed; Auth restarts after a save.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { DatabasePage } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { api, isApiError, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { cn } from '@/lib/utils'

export type AuthConfig = Schemas['AuthConfig']
type Value = boolean | number | string | null

export const authConfigQuery = (ref: string) => ({
  queryKey: ['projects', ref, 'auth-config'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/auth-config', { params: { path: { ref } } })),
})

/** A setting on a page. Values are as the API has them; `scale` shows a number
 * in bigger units (3600: seconds shown as hours). */
export type Field =
  | { name: string; label: string; description?: ReactNode; type: 'bool'; default?: boolean; invert?: boolean }
  | { name: string; label: string; description?: ReactNode; type: 'number'; default?: number; unit?: string; scale?: number; step?: number }
  | { name: string; label: string; description?: ReactNode; type: 'text' | 'url' | 'email'; default?: string; placeholder?: string }
  | { name: string; label: string; description?: ReactNode; type: 'secret' }
  | {
      name: string
      label: string
      description?: ReactNode
      type: 'select'
      options: { value: string; label: string }[]
      default?: string
      /** No default: a choice must be made. */
      required?: boolean
    }

/**
 * A page of Auth settings: explains connected stacks, waits for the settings,
 * and hands them to its sections.
 */
export function AuthConfigPage({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: (ctx: AuthCtx) => ReactNode
}) {
  const project = useSelectedProject()
  const config = useQuery({ ...authConfigQuery(project?.ref ?? ''), enabled: !!project?.stack })
  if (!project) return null
  return (
    <DatabasePage title={title} description={description}>
      {!project.stack ? (
        <Alert title="Supermixer connects to this stack, so its Auth settings are set where it runs">
          Self-hosted Auth reads its settings from environment variables in the stack’s .env and compose file. Projects
          created with “Create a new stack” are configured here.
        </Alert>
      ) : config.error ? (
        <Alert variant="destructive" title={config.error.message} />
      ) : !config.data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {!can(project, 'project:update') && (
            <Alert title="Only Owners and Administrators can change Auth settings" />
          )}
          {project.stack.status !== 'running' && (
            <Alert title="The stack isn't running">Saved settings take effect when it starts.</Alert>
          )}
          {children({ projectRef: project.ref, config: config.data, canChange: can(project, 'project:update') })}
        </>
      )}
    </DatabasePage>
  )
}

export interface AuthCtx {
  projectRef: string
  config: AuthConfig
  canChange: boolean
}

/** Saves changed settings; Auth restarts. */
export function useSaveAuthConfig(ref: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (changes: Record<string, Value>) =>
      unwrap(api.PATCH('/projects/{ref}/auth-config', { params: { path: { ref } }, body: changes })),
    onSuccess: (data) => {
      queryClient.setQueryData(authConfigQuery(ref).queryKey, data)
      toast.success(data.restarted ? 'Saved; Auth restarted' : 'Saved; it takes effect when the stack starts')
    },
    // A failed restart (502) still saved the change: show what's saved now.
    onError: () => void queryClient.invalidateQueries({ queryKey: authConfigQuery(ref).queryKey }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] }),
  })
}

export const valueOf = (config: AuthConfig, name: string): Value => (config.values[name] ?? null) as Value

/**
 * A card of settings with its own Save. A field's draft is undefined until
 * edited; null means "back to the default", and for secrets "remove".
 */
export function AuthSection({
  ctx,
  title,
  description,
  fields,
  footer,
  bare,
  children,
}: {
  ctx: AuthCtx
  title?: string
  description?: ReactNode
  /** The fields, or a function of the draft when some depend on others. */
  fields: Field[] | ((draft: DraftApi) => Field[])
  footer?: ReactNode
  /** No card or heading: for settings inside an expanded row. */
  bare?: boolean
  children?: (draft: DraftApi) => ReactNode
}) {
  const save = useSaveAuthConfig(ctx.projectRef)
  const [draft, setDraft] = useState<Record<string, Value>>({})
  const dirty = Object.keys(draft).length > 0
  const api: DraftApi = {
    get: (name) => (name in draft ? draft[name]! : valueOf(ctx.config, name)),
    set: (name, v) => setDraft((d) => ({ ...d, [name]: v })),
    edited: (name) => name in draft,
  }
  const list = typeof fields === 'function' ? fields(api) : fields
  const Wrapper = bare ? 'div' : Card
  return (
    <Wrapper className={cn('flex flex-col', bare && 'rounded-md border bg-background')}>
      {title && (
        <div className="flex flex-col gap-1 border-b px-5 py-4">
          <span className="text-sm text-foreground">{title}</span>
          {description && <span className="text-xs text-foreground-lighter">{description}</span>}
        </div>
      )}
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty && ctx.canChange)
            save.mutate(draft, {
              onSuccess: () => setDraft({}),
              // Saved but Auth didn't restart: the edits are no longer pending.
              onError: (e) => isApiError(e, 502) && setDraft({}),
            })
        }}
      >
        <div className="flex flex-col gap-5 px-5 py-5">
          {list.map((f) => (
            <FieldInput key={f.name} field={f} ctx={ctx} draft={api} disabled={!ctx.canChange || save.isPending} />
          ))}
          {children?.(api)}
          {save.error && <Alert variant="destructive" title={save.error.message} />}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <span className="text-xs text-foreground-lighter">{footer}</span>
          <div className="flex gap-2">
            {dirty && (
              <Button type="button" variant="default" disabled={save.isPending} onClick={() => setDraft({})}>
                Cancel
              </Button>
            )}
            <PermissionButton allowed={ctx.canChange} action="change Auth settings" type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              Save
            </PermissionButton>
          </div>
        </div>
      </form>
    </Wrapper>
  )
}

export interface DraftApi {
  get: (name: string) => Value
  set: (name: string, v: Value) => void
  edited: (name: string) => boolean
}

function FieldInput({ field: f, ctx, draft, disabled }: { field: Field; ctx: AuthCtx; draft: DraftApi; disabled: boolean }) {
  const id = `auth-${f.name}`
  const v = draft.get(f.name)
  switch (f.type) {
    case 'bool': {
      const on = (v === null ? (f.default ?? false) : v === true) !== !!f.invert
      return (
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-0.5">
            <label htmlFor={id} className="text-sm text-foreground">
              {f.label}
            </label>
            {f.description && <span className="text-xs text-foreground-lighter">{f.description}</span>}
          </div>
          <Switch id={id} checked={on} disabled={disabled} onCheckedChange={(c) => draft.set(f.name, c !== !!f.invert)} />
        </div>
      )
    }
    case 'number': {
      const scale = f.scale ?? 1
      const shown = typeof v === 'number' ? String(Number((v / scale).toFixed(4))) : ''
      const placeholder = f.default !== undefined ? `Default: ${Number((f.default / scale).toFixed(4))}` : 'Auth’s default'
      return (
        <FormField label={f.label} htmlFor={id} description={f.description} layout="horizontal">
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="number"
              min={0}
              step={f.step ?? 'any'}
              className="w-40"
              value={shown}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(e) => {
                const raw = e.target.value
                // Rounded when scaled: 1.1 hours is 3960 seconds, not 3960.0000000000005.
                draft.set(f.name, raw === '' ? null : scale === 1 ? Number(raw) : Math.round(Number(raw) * scale))
              }}
            />
            {f.unit && <span className="text-xs text-foreground-lighter">{f.unit}</span>}
          </div>
        </FormField>
      )
    }
    case 'text':
    case 'url':
    case 'email':
      return (
        <FormField label={f.label} htmlFor={id} description={f.description} layout="horizontal">
          <Input
            id={id}
            type={f.type === 'email' ? 'email' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={typeof v === 'string' ? v : ''}
            placeholder={f.placeholder ?? (f.default ? `Default: ${f.default}` : undefined)}
            disabled={disabled}
            onChange={(e) => draft.set(f.name, e.target.value === '' ? null : e.target.value)}
          />
        </FormField>
      )
    case 'secret':
      return <SecretInput id={id} field={f} ctx={ctx} draft={draft} disabled={disabled} />
    case 'select':
      return (
        <FormField label={f.label} htmlFor={id} description={f.description} layout="horizontal">
          <Select
            value={
              typeof v === 'string' ? v || '__none' : f.required ? '' : f.default !== undefined ? f.default || '__none' : '__default'
            }
            disabled={disabled}
            onValueChange={(x) => draft.set(f.name, x === '__default' ? null : x === '__none' ? '' : x)}
          >
            <SelectTrigger id={id} className="w-full">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {f.default === undefined && !f.required && <SelectItem value="__default">Auth’s default</SelectItem>}
              {f.options.map((o) => (
                <SelectItem key={o.value || '__none'} value={o.value || '__none'}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )
  }
}

function SecretInput({ id, field: f, ctx, draft, disabled }: { id: string; field: Field; ctx: AuthCtx; draft: DraftApi; disabled: boolean }) {
  const isSet = ctx.config.secrets_set.includes(f.name)
  const v = draft.get(f.name)
  const editing = draft.edited(f.name)
  return (
    <FormField label={f.label} htmlFor={id} description={f.description} layout="horizontal">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          className="font-mono"
          placeholder={isSet ? '•••••••• (set; type to replace)' : 'Not set'}
          value={editing && typeof v === 'string' ? v : ''}
          disabled={disabled}
          onChange={(e) => draft.set(f.name, e.target.value)}
        />
        {isSet && (
          <Button
            type="button"
            variant="default"
            size="tiny"
            disabled={disabled || (editing && v === null)}
            onClick={() => draft.set(f.name, null)}
          >
            {editing && v === null ? 'Will be removed' : 'Remove'}
          </Button>
        )}
      </div>
    </FormField>
  )
}

/** "Enabled" / "Disabled" for a provider or hook in a list. */
export function OnOffBadge({ on }: { on: boolean }) {
  return <Badge variant={on ? 'success' : 'default'}>{on ? 'Enabled' : 'Disabled'}</Badge>
}

/** A row that opens to show its settings (providers, hooks). */
export function Expandable({
  title,
  aside,
  open,
  onToggle,
  children,
}: {
  title: ReactNode
  aside?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={cn('flex flex-col', open && 'bg-surface-75')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex items-center justify-between gap-4 px-5 py-3 text-left text-sm text-foreground hover:bg-surface-100 focus-inset"
      >
        <span>{title}</span>
        {aside}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  )
}

export function MultilineInput(props: React.ComponentProps<typeof Textarea>) {
  return <Textarea {...props} className={cn('font-mono text-xs', props.className)} />
}
