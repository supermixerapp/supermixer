import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent, type ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { healthQuery, profileQuery, sessionsQuery, uiConfigQuery } from '@/lib/api/queries'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/account/me')({
  component: PreferencesPage,
})

function PreferencesPage() {
  return (
    <AppShell title="Account">
      <WithProductMenu
        menu={
          <ProductMenu
            title="Account settings"
            sections={[{ title: 'Account', links: [{ label: 'Preferences', to: '/account/me', active: true }] }]}
          />
        }
      >
        <PageHeader title="Preferences" size="small" />
        <PageContainer size="small" className="flex flex-col gap-10 pb-16">
          <ProfileSection />
          <PasswordSection />
          <AppearanceSection />
          <BrandSection />
          <SessionsSection />
          <SystemSection />
        </PageContainer>
      </WithProductMenu>
    </AppShell>
  )
}

/* Miniature app mock-ups for the theme picker, drawn with fixed colours because
   tokens resolve against the page's active theme. */
const PREVIEW = {
  dark: { bg: '#161616', panel: '#1f1f1f', line: '#2e2e2e', text: '#4d4d4d' },
  light: { bg: '#fcfcfc', panel: '#f3f3f3', line: '#dfdfdf', text: '#c7c7c7' },
}

function Mock({ mode, className }: { mode: 'dark' | 'light'; className?: string }) {
  const c = PREVIEW[mode]
  return (
    <svg viewBox="0 0 120 72" className={className} aria-hidden>
      <rect width="120" height="72" fill={c.bg} />
      <rect width="120" height="9" fill={c.panel} />
      <rect y="9" width="14" height="63" fill={c.panel} />
      <line x1="0" y1="9" x2="120" y2="9" stroke={c.line} />
      <line x1="14" y1="9" x2="14" y2="72" stroke={c.line} />
      <rect x="4" y="15" width="6" height="6" rx="1" fill="var(--primary-solid)" />
      <rect x="4" y="25" width="6" height="6" rx="1" fill={c.text} />
      <rect x="4" y="35" width="6" height="6" rx="1" fill={c.text} />
      <rect x="22" y="17" width="40" height="5" rx="1" fill={c.text} />
      <rect x="22" y="28" width="90" height="36" rx="2" fill={c.panel} stroke={c.line} />
    </svg>
  )
}

function AppearanceSection() {
  const { preference, setPreference } = useTheme()
  const options: { value: ThemePreference; label: string }[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ]
  return (
    <SettingsSection title="Appearance" description="Choose how Supermixer looks to you. Saved in this browser.">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={preference === o.value}
            onClick={() => setPreference(o.value)}
            className={cn(
              'group flex flex-col gap-2 rounded-panel text-left focus-ring',
              'text-sm text-foreground-light hover:text-foreground aria-checked:text-foreground'
            )}
          >
            <div
              className={cn(
                'overflow-hidden rounded-panel border-2 transition-colors',
                preference === o.value ? 'border-primary-bright' : 'border-transparent group-hover:border-strong'
              )}
            >
              {o.value === 'system' ? (
                <div className="relative">
                  <Mock mode="light" className="block w-full" />
                  <Mock mode="dark" className="absolute inset-0 block w-full [clip-path:polygon(50%_0,100%_0,100%_100%,50%_100%)]" />
                </div>
              ) : (
                <Mock mode={o.value} className="block w-full" />
              )}
            </div>
            {o.label}
          </button>
        ))}
      </div>
    </SettingsSection>
  )
}

function Swatch({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn('h-10 rounded-md border', className)} />
      <span className="font-mono text-[11px] text-foreground-lighter">{label}</span>
    </div>
  )
}

function BrandSection() {
  const { data } = useQuery(uiConfigQuery)
  return (
    <SettingsSection
      title="Brand colour"
      description={
        <>
          Set by <code className="font-mono text-xs">appearance.brand_color</code> in the server&apos;s .env.toml. Restart
          Supermixer to apply a change; every shade below is derived from it.
        </>
      }
    >
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-primary-solid" />
          <div className="flex flex-col">
            <span className="text-sm text-foreground">
              {data?.brand_color === '#0019a8' ? 'Piccadilly blue' : 'Custom brand colour'}
            </span>
            <span className="font-mono text-xs text-foreground-lighter">{data?.brand_color ?? '…'}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          <Swatch label="primary-solid" className="bg-primary-solid" />
          <Swatch label="primary" className="bg-primary" />
          <Swatch label="primary-bright" className="bg-primary-bright" />
          <Swatch label="brand-600" className="bg-brand-600" />
          <Swatch label="brand-500" className="bg-brand-500" />
          <Swatch label="brand-400" className="bg-brand-400" />
        </div>
      </Card>
    </SettingsSection>
  )
}

function SystemSection() {
  const { data, isPending, error } = useQuery(healthQuery)
  return (
    <SettingsSection title="System" description="Status of this Supermixer server and its database.">
      <Card>
        {error && !data ? (
          <dl className="text-sm">
            <Row label="Server">
              <Badge variant="destructive">unreachable</Badge>
            </Row>
            <p className="px-5 pb-3 text-xs text-foreground-lighter">{error.message}</p>
          </dl>
        ) : isPending || !data ? (
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <dl className="divide-y text-sm">
            <Row label="Server">
              <Badge variant={data.status === 'healthy' ? 'success' : 'destructive'}>{data.status}</Badge>
            </Row>
            <Row label="Version">
              <span className="font-mono text-xs">{data.version}</span>
            </Row>
            <Row label="Database">
              <Badge variant={data.database.status === 'healthy' ? 'success' : 'destructive'}>
                {data.database.status}
              </Badge>
            </Row>
            {data.database.schema_version != null && (
              <Row label="Schema version">
                <span className="font-mono text-xs">{data.database.schema_version}</span>
              </Row>
            )}
            {data.database.installed_at && (
              <Row label="Installed">{new Date(data.database.installed_at).toLocaleString()}</Row>
            )}
          </dl>
        )}
      </Card>
    </SettingsSection>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <dt className="text-foreground-light">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}

function ProfileSection() {
  const { data: me } = useProfile()
  return me ? <ProfileForm key={`${me.display_name}|${me.email}`} me={me} /> : null
}

function ProfileForm({ me }: { me: Schemas['Profile'] }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(me.display_name)
  const [email, setEmail] = useState(me.email ?? '')
  const save = useMutation({
    mutationFn: () => unwrap(api.PATCH('/profile', { body: { display_name: displayName, email: email || null } })),
    onSuccess: (p) => {
      queryClient.setQueryData(profileQuery.queryKey, p)
      toast.success('Profile saved')
    },
  })
  const dirty = displayName !== me.display_name || email !== (me.email ?? '')
  return (
    <SettingsSection title="Profile">
      <Card>
        <CardContent className="flex flex-col gap-6">
          <FormField label="Username" layout="horizontal" description="Used to sign in. It does not change.">
            <Input value={me.username} readOnly />
          </FormField>
          <FormField label="Display name" htmlFor="display-name" layout="horizontal">
            <Input id="display-name" maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </FormField>
          <FormField label="Email" htmlFor="email" layout="horizontal">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          {save.error && <Alert variant="destructive" title={save.error.message} />}
        </CardContent>
        <CardFooter>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </CardFooter>
      </Card>
    </SettingsSection>
  )
}

function PasswordSection() {
  const { data: me } = useProfile()
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const change = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/password', { body: { current_password: current, new_password: next } })),
    onSuccess: async () => {
      setCurrent('')
      setNext('')
      setConfirm('')
      toast.success('Password changed; your other sessions were signed out')
      await queryClient.invalidateQueries({ queryKey: profileQuery.queryKey })
    },
  })
  const mismatch = confirm !== '' && next !== confirm
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) change.mutate()
  }
  return (
    <section id="password" className="scroll-mt-6">
      <SettingsSection title="Password">
        {me?.default_password && (
          <Alert variant="warning" title="You are still using the default password">
            Anyone who knows the default can sign in as you. Choose a new password now.
          </Alert>
        )}
        <form onSubmit={submit}>
          <Card>
            <CardContent className="flex flex-col gap-6">
              <input type="text" autoComplete="username" value={me?.username ?? ''} readOnly hidden />
              <FormField label="Current password" htmlFor="pw-current" layout="horizontal">
                <Input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
              </FormField>
              <FormField label="New password" htmlFor="pw-new" layout="horizontal" description="At least 8 characters">
                <Input id="pw-new" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
              </FormField>
              <FormField label="Confirm new password" htmlFor="pw-confirm" layout="horizontal" error={mismatch ? 'Passwords do not match' : undefined}>
                <Input
                  id="pw-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  aria-invalid={mismatch}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </FormField>
              {change.error && <Alert variant="destructive" title={change.error.message} />}
            </CardContent>
            <CardFooter>
              <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || !next || mismatch}>
                Change password
              </Button>
            </CardFooter>
          </Card>
        </form>
      </SettingsSection>
    </section>
  )
}

function SessionsSection() {
  const sessions = useQuery(sessionsQuery)
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/profile/sessions/{session_id}', { params: { path: { session_id: id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
    onError: (e) => toast.error(e.message),
  })
  return (
    <SettingsSection title="Sessions" description="Browsers signed in to your account.">
      <Card>
        {sessions.isPending ? (
          <div className="p-5">
            <Skeleton className="h-10" />
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 text-foreground">
                    {describeAgent(s.user_agent)}
                    {s.current && <Badge variant="success">This browser</Badge>}
                  </span>
                  <span className="truncate text-xs text-foreground-lighter">
                    {s.ip || 'unknown IP'} · last active {new Date(s.last_seen_at).toLocaleString()}
                  </span>
                </div>
                {!s.current && (
                  <Button variant="default" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </SettingsSection>
  )
}

function describeAgent(ua: string) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : ''
  return os ? `${browser} on ${os}` : browser
}
