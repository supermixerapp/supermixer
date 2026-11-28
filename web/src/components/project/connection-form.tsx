import { useState, type ReactNode } from 'react'

import { CheckIcon, ErrorIcon } from '@/components/icons'
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
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Schemas } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { t, Trans } from '@/lib/i18n'

export interface ConnectionValue {
  api_url: string
  studio_url: string
  host: string
  port: string
  name: string
  user: string
  password: string
  sslmode: Schemas['DatabaseConnection']['sslmode']
  anon: string
  service_role: string
  publishable: string
  secret: string
  jwt_secret: string
}

export const emptyConnection: ConnectionValue = {
  api_url: '',
  studio_url: '',
  host: 'localhost',
  port: '5432',
  name: 'postgres',
  user: '',
  password: '',
  sslmode: 'prefer',
  anon: '',
  service_role: '',
  publishable: '',
  secret: '',
  jwt_secret: '',
}

/** Starting values for editing an existing project (secrets left blank = unchanged). */
export function connectionFromProject(p: Schemas['Project']): ConnectionValue {
  return {
    ...emptyConnection,
    api_url: p.api_url,
    studio_url: p.studio_url,
    host: p.database.host,
    port: String(p.database.port),
    name: p.database.name,
    user: p.database.user,
    sslmode: p.database.sslmode as ConnectionValue['sslmode'],
  }
}

export function toConnectionPayload(v: ConnectionValue): Schemas['ProjectConnection'] {
  const opt = (s: string) => (s.trim() ? s.trim() : undefined)
  return {
    api_url: v.api_url.trim(),
    studio_url: opt(v.studio_url),
    database: {
      host: v.host.trim(),
      port: Number(v.port),
      name: v.name.trim(),
      user: v.user.trim(),
      password: v.password || undefined,
      sslmode: v.sslmode,
    },
    keys: {
      anon: opt(v.anon),
      service_role: opt(v.service_role),
      publishable: opt(v.publishable),
      secret: opt(v.secret),
      jwt_secret: opt(v.jwt_secret),
    },
  }
}

/**
 * Reads the variables of a self-hosted Supabase .env (docker/.env). Parsing
 * happens in the browser; nothing is sent until the form is submitted.
 */
export function parseSupabaseEnv(text: string): Partial<ConnectionValue> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[m[1]] = value
  }
  const out: Partial<ConnectionValue> = {}
  const set = <K extends keyof ConnectionValue>(k: K, v: string | undefined) => {
    if (v) out[k] = v as ConnectionValue[K]
  }
  set('api_url', env.SUPABASE_PUBLIC_URL)
  set('studio_url', env.SUPABASE_PUBLIC_URL)
  set('anon', env.ANON_KEY)
  set('service_role', env.SERVICE_ROLE_KEY)
  set('publishable', env.SUPABASE_PUBLISHABLE_KEY)
  set('secret', env.SUPABASE_SECRET_KEY)
  set('jwt_secret', env.JWT_SECRET)
  set('password', env.POSTGRES_PASSWORD)
  set('name', env.POSTGRES_DB)
  // Postgres is published through Supavisor, whose user names the tenant.
  set('port', env.POSTGRES_PORT)
  if (env.POOLER_TENANT_ID) out.user = `postgres.${env.POOLER_TENANT_ID}`
  if (env.SUPABASE_PUBLIC_URL) {
    try {
      out.host = new URL(env.SUPABASE_PUBLIC_URL).hostname
    } catch {
      // leave host alone
    }
  }
  return out
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-4 border-b px-card py-6 last:border-b-0 md:grid-cols-12 md:gap-x-6">
      <div className="md:col-span-4">
        <h4 className="font-sans text-sm font-normal text-foreground">{title}</h4>
        {description && <p className="mt-1 text-xs text-foreground-lighter">{description}</p>}
      </div>
      <div className="flex flex-col gap-4 md:col-span-8">{children}</div>
    </div>
  )
}

export function ConnectionFields({
  value,
  onChange,
  editing = false,
  keysPresent,
}: {
  value: ConnectionValue
  onChange: (v: ConnectionValue) => void
  /** Editing an existing project: blank secrets keep their stored values. */
  editing?: boolean
  keysPresent?: Schemas['Project']['keys_present']
}) {
  const [keyMode, setKeyMode] = useState<'legacy' | 'new'>(
    keysPresent && !keysPresent.anon && keysPresent.publishable ? 'new' : 'legacy'
  )
  const set =
    (k: keyof ConnectionValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...value, [k]: e.target.value })
  const secretPlaceholder = (present?: boolean) => (editing && present ? t('project:connectionForm.unchanged') : '')

  return (
    <>
      <Section
        title={t('project:connectionForm.api')}
        description={t('project:connectionForm.theStackSApiGatewaySupabase')}
      >
        <FormField label={t('project:connectionForm.apiUrl')} htmlFor="api_url">
          <Input id="api_url" placeholder="http://localhost:8000" required value={value.api_url} onChange={set('api_url')} />
        </FormField>
        <FormField label={t('project:connectionForm.studioUrlOptional')} htmlFor="studio_url" description={t('project:connectionForm.linkedFromTheProjectOverview')}>
          <Input id="studio_url" placeholder="http://localhost:8000" value={value.studio_url} onChange={set('studio_url')} />
        </FormField>
      </Section>
      <Section
        title={t('project:connectionForm.apiKeys')}
        description={t('project:connectionForm.supabaseStacksUseLegacyJwtKeys')}
      >
        <Tabs value={keyMode} onValueChange={(v) => setKeyMode(v as 'legacy' | 'new')}>
          <TabsList>
            <TabsTrigger value="legacy">{t('project:connectionForm.legacyJwtKeys')}</TabsTrigger>
            <TabsTrigger value="new">{t('project:connectionForm.publishableAndSecretKeys')}</TabsTrigger>
          </TabsList>
        </Tabs>
        {keyMode === 'legacy' ? (
          <>
            <FormField label={t('project:connectionForm.anonKey')} htmlFor="anon" description={t('project:connectionForm.anonKey2')}>
              <Input id="anon" className="font-mono" placeholder={secretPlaceholder(keysPresent?.anon)} value={value.anon} onChange={set('anon')} />
            </FormField>
            <FormField label={t('project:connectionForm.serviceRoleKey')} htmlFor="service_role" description={t('project:connectionForm.serviceRoleKey2')}>
              <Input
                id="service_role"
                type="password"
                autoComplete="off"
                className="font-mono"
                placeholder={secretPlaceholder(keysPresent?.service_role)}
                value={value.service_role}
                onChange={set('service_role')}
              />
            </FormField>
            <FormField label={t('project:connectionForm.jwtSecretOptional')} htmlFor="jwt_secret" description={t('project:connectionForm.jwtSecret')}>
              <Input
                id="jwt_secret"
                type="password"
                autoComplete="off"
                className="font-mono"
                placeholder={secretPlaceholder(keysPresent?.jwt_secret)}
                value={value.jwt_secret}
                onChange={set('jwt_secret')}
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField label={t('project:connectionForm.publishableKey')} htmlFor="publishable" description={t('project:connectionForm.supabasePublishableKeySbPublishable')}>
              <Input id="publishable" className="font-mono" placeholder={secretPlaceholder(keysPresent?.publishable)} value={value.publishable} onChange={set('publishable')} />
            </FormField>
            <FormField label={t('project:connectionForm.secretKey')} htmlFor="secret" description={t('project:connectionForm.supabaseSecretKeySbSecret')}>
              <Input
                id="secret"
                type="password"
                autoComplete="off"
                className="font-mono"
                placeholder={secretPlaceholder(keysPresent?.secret)}
                value={value.secret}
                onChange={set('secret')}
              />
            </FormField>
          </>
        )}
      </Section>
      <Section
        title={t('project:connectionForm.database')}
        description={
          <>
            <Trans i18nKey="project:connectionForm.selfHostedStacksPublishPostgresThrough" values={{ user: 'postgres.<POOLER_TENANT_ID>' }} components={{ code: <code className="font-mono" /> }} />
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={t('project:connectionForm.host')} htmlFor="db-host" className="sm:col-span-2">
            <Input id="db-host" required value={value.host} onChange={set('host')} />
          </FormField>
          <FormField label={t('project:connectionForm.port')} htmlFor="db-port" description={t('project:connectionForm.postgresPort')}>
            <Input id="db-port" type="number" min={1} max={65535} required value={value.port} onChange={set('port')} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('project:connectionForm.database')} htmlFor="db-name" description={t('project:connectionForm.postgresDb')}>
            <Input id="db-name" required value={value.name} onChange={set('name')} />
          </FormField>
          <FormField label={t('project:connectionForm.user')} htmlFor="db-user">
            <Input id="db-user" required placeholder="postgres.your-tenant-id" value={value.user} onChange={set('user')} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('project:connectionForm.password')} htmlFor="db-password" description={t('project:connectionForm.postgresPassword')}>
            <Input
              id="db-password"
              type="password"
              autoComplete="off"
              required={!editing}
              placeholder={editing ? t('project:connectionForm.unchanged') : ''}
              value={value.password}
              onChange={set('password')}
            />
          </FormField>
          <FormField label={t('project:connectionForm.sslMode')} htmlFor="db-sslmode">
            <Select value={value.sslmode} onValueChange={(v) => onChange({ ...value, sslmode: v as ConnectionValue['sslmode'] })}>
              <SelectTrigger id="db-sslmode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const).map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      </Section>
    </>
  )
}

export function EnvImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onImport: (v: Partial<ConnectionValue>) => void
}) {
  const [text, setText] = useState('')
  const parsed = parseSupabaseEnv(text)
  const found = Object.keys(parsed).length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>{t('project:connectionForm.fillFromASupabaseEnvFile')}</DialogTitle>
          <DialogDescription>
            <Trans i18nKey="project:connectionForm.pasteTheSelfHostedSupabaseStack" components={{ code: <code className="font-mono" />, code2: <code className="font-mono" />, code3: <code className="font-mono" />, code4: <code className="font-mono" /> }} />
          </DialogDescription>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-2 border-t">
          <Textarea
            aria-label={t('project:connectionForm.supabaseEnvContents')}
            className="min-h-60 font-mono text-xs"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'SUPABASE_PUBLIC_URL=http://localhost:8000\nANON_KEY=…\nSERVICE_ROLE_KEY=…'}
          />
          <p className="text-xs text-foreground-lighter">{found > 0 ? t('project:connectionForm.foundValues', { found }) : t('project:connectionForm.noValuesFoundYet')}</p>
        </DialogSection>
        <DialogFooter>
          <Button variant="default" onClick={() => onOpenChange(false)}>
            {t('project:connectionForm.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={found === 0}
            onClick={() => {
              onImport(parsed)
              setText('')
              onOpenChange(false)
            }}
          >
            {t('project:connectionForm.fillInForm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Results of a connection test or health check, one row per service. */
export function HealthChecks({ report }: { report: Schemas['HealthReport'] }) {
  const examples = report.example_secrets ?? []
  return (
    <div className="flex flex-col gap-3">
      {examples.length > 0 && (
        <Alert variant="destructive" title={t('project:connectionForm.thisStackUsesSupabaseSExample')}>
          {t('project:connectionForm.exampleSecrets', { count: examples.length, names: examples.join(', ') })}
        </Alert>
      )}
      <HealthList report={report} />
    </div>
  )
}

function HealthList({ report }: { report: Schemas['HealthReport'] }) {
  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {report.services.map((s) => (
        <li key={s.service} className="flex items-start gap-3 px-3 py-2.5 text-sm">
          <span
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
              s.status === 'ok' ? 'bg-brand-500 text-brand-600' : 'bg-destructive-400 text-destructive-600'
            )}
          >
            {s.status === 'ok' ? <CheckIcon size={12} /> : <ErrorIcon size={12} />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-foreground">{s.label}</span>
            {s.detail && <span className="text-xs break-words text-foreground-lighter">{s.detail}</span>}
          </div>
          <span className="font-mono text-xs text-foreground-lighter">{t('project:connectionForm.ms', { latencyMs: s.latency_ms })}</span>
        </li>
      ))}
    </ul>
  )
}
