/*
 * Account › Access Tokens: personal access tokens for scripts and CI, and
 * how to use them with Supermixer's API and the Supabase-style /v1 API.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { AddIcon } from '@/components/icons'
import { AccountLayout } from '@/components/layout/account-layout'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyField } from '@/components/ui/copy'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { relativeTime } from '@/lib/auth-users'

export const Route = createFileRoute('/_app/account/access-tokens')({
  component: AccessTokensPage,
})

const tokensQuery = {
  queryKey: ['profile', 'access-tokens'],
  queryFn: () => unwrap(api.GET('/profile/access-tokens')),
}

type Token = Schemas['AccessToken']

function AccessTokensPage() {
  return (
    <AccountLayout title="Access Tokens">
      <TokensSection />
      <UsageSection />
    </AccountLayout>
  )
}

function TokensSection() {
  const tokens = useQuery(tokensQuery)
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<Token | null>(null)
  const revoke = useMutation({
    mutationFn: (t: Token) => unwrap(api.DELETE('/profile/access-tokens/{token_id}', { params: { path: { token_id: t.id } } })),
    onSuccess: (_, t) => {
      toast.success(`Revoked ${t.name}`)
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })
  const [now] = useState(() => Date.now())
  return (
    <SettingsSection
      title="Personal access tokens"
      description="For scripts and CI. A token can do what you can in Supermixer, except change your password, two-factor sign-in, sessions or tokens. Keep them secret like passwords. Changing your password or turning on two-factor sign-in revokes them all."
    >
      <div className="flex justify-end">
        <Button variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          Generate new token
        </Button>
      </div>
      <Card>
        {tokens.error ? (
          <Alert variant="destructive" title={tokens.error.message} />
        ) : !tokens.data ? (
          <div className="p-4">
            <Skeleton className="h-10" />
          </div>
        ) : tokens.data.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">No tokens yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data.map((t) => {
                const expired = new Date(t.expires_at).getTime() <= now
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground">{t.name}</span>
                        <span className="font-mono text-xs text-foreground-lighter">{t.prefix}…</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {t.last_used_at ? (
                        <span className="flex flex-col">
                          <span>{relativeTime(t.last_used_at)}</span>
                          {t.last_used_ip && <span className="font-mono text-xs text-foreground-lighter">{t.last_used_ip}</span>}
                        </span>
                      ) : (
                        <span className="text-foreground-lighter">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {expired ? <Badge variant="warning">Expired</Badge> : new Date(t.expires_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="tiny" variant="default" onClick={() => setRevoking(t)}>
                        {expired ? 'Remove' : 'Revoke'}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      {creating && <CreateTokenDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name}?`}
        description="Anything using it stops working straight away. This can't be undone."
        confirmLabel="Revoke"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </SettingsSection>
  )
}

const EXPIRY = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
]

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [days, setDays] = useState('30')
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/profile/access-tokens', { body: { name, expires_in_days: Number(days) } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  })
  const token = create.data?.token
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your token</DialogTitle>
              <DialogDescription>It isn&apos;t shown again. If you lose it, revoke it and make another.</DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              <CopyField value={token} />
              <CodeBlock code={`curl -H "Authorization: Bearer ${token}" ${window.location.origin}/v1/projects`} />
            </DialogSection>
            <DialogFooter>
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>Generate a new token</DialogTitle>
              <DialogDescription>Give each script or service its own, so you can revoke one without the others.</DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              <FormField label="Name" htmlFor="tok-name" description="What will use it, like “GitHub Actions deploys”.">
                <Input id="tok-name" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label="Expires after" htmlFor="tok-expiry">
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger id="tok-expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((e) => (
                      <SelectItem key={e.days} value={String(e.days)}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              {create.error && <Alert variant="destructive" title={create.error.message} />}
            </DialogSection>
            <DialogFooter>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
                Generate token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

const V1_ENDPOINTS: [string, string, string][] = [
  ['GET', '/v1/organizations', 'Your organizations'],
  ['GET', '/v1/organizations/{slug}', 'An organization'],
  ['GET', '/v1/organizations/{slug}/members', 'Its members'],
  ['GET', '/v1/projects', 'Projects you can see'],
  ['GET', '/v1/projects/{ref}', 'A project'],
  ['GET', '/v1/projects/{ref}/health', "Its services' health (?services=auth,db,rest,storage)"],
  ['GET', '/v1/projects/{ref}/api-keys', 'Its API keys (secret ones if you may see them)'],
  ['POST', '/v1/projects/{ref}/database/query', 'Run SQL: {"query": "..."}; answers with the rows'],
  ['GET', '/v1/projects/{ref}/database/backups', 'Its backups'],
  ['GET', '/v1/projects/{ref}/functions', 'Its Edge Functions'],
  ['GET', '/v1/projects/{ref}/functions/{slug}', 'An Edge Function'],
  ['DELETE', '/v1/projects/{ref}/functions/{slug}', 'Delete an Edge Function'],
  ['GET', '/v1/projects/{ref}/secrets', 'Edge Function secrets (values as SHA-256 digests)'],
  ['POST', '/v1/projects/{ref}/secrets', 'Add or replace secrets: [{"name": "...", "value": "..."}]'],
  ['DELETE', '/v1/projects/{ref}/secrets', 'Remove secrets: ["NAME", ...]'],
  ['POST', '/v1/projects/{ref}/pause', 'Pause a stack Supermixer created'],
  ['POST', '/v1/projects/{ref}/restore', 'Start it again'],
]

function UsageSection() {
  const origin = window.location.origin
  return (
    <SettingsSection
      title="Using the API"
      description="Send the token as Authorization: Bearer. Requests act as you, with your roles in each organization, and appear in the audit logs with the token's name."
    >
      <Card className="flex flex-col gap-4 p-5 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-foreground">Supabase-style Management API</span>
          <span className="text-foreground-light">
            A subset of Supabase&apos;s Management API (api.supabase.com/v1), with its paths and responses, for scripts
            written for it. Base URL:
          </span>
          <CopyField value={`${origin}/v1`} />
        </div>
        <ul className="flex flex-col divide-y rounded-md border">
          {V1_ENDPOINTS.map(([method, path, what]) => (
            <li key={method + path} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="flex min-w-0 items-baseline gap-2 font-mono text-xs sm:w-96 sm:shrink-0">
                <span className="w-12 shrink-0 text-foreground-lighter">{method}</span>
                <span className="break-all text-foreground">{path}</span>
              </span>
              <span className="text-xs text-foreground-light">{what}</span>
            </li>
          ))}
        </ul>
        <CodeBlock
          code={`curl -X POST ${origin}/v1/projects/<ref>/database/query \\
  -H "Authorization: Bearer $SUPERMIXER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "select count(*) from auth.users"}'`}
        />
        <div className="flex flex-col gap-1">
          <span className="text-foreground">Supermixer&apos;s API</span>
          <span className="text-foreground-light">
            Everything the app does, such as deploying Edge Functions, backups and Auth settings. Base URL:
          </span>
          <CopyField value={`${origin}/api/v1`} />
          <span className="text-foreground-light">
            Described in{' '}
            <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="text-link">
              openapi.json
            </a>{' '}
            (OpenAPI 3), for docs viewers and client generators.
          </span>
        </div>
        <CodeBlock
          code={`curl -X PUT ${origin}/api/v1/projects/<ref>/functions/hello \\
  -H "Authorization: Bearer $SUPERMIXER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"files": [{"path": "index.ts", "content": "Deno.serve(() => new Response(\\"hi\\"))"}]}'`}
        />
      </Card>
    </SettingsSection>
  )
}
