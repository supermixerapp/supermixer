import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent, type ReactNode } from 'react'

import { AccountLayout } from '@/components/layout/account-layout'
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
import { healthQuery, profileQuery, sessionsQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/account/me')({
  component: PreferencesPage,
})

function PreferencesPage() {
  return (
    <AccountLayout title="Preferences">
      <ProfileSection />
      <PasswordSection />
      <SessionsSection />
      <SystemSection />
    </AccountLayout>
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
              <FormField label="New password" htmlFor="pw-new" layout="horizontal" description="At least 8 characters, and not a common password or your username">
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
