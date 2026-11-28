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
import { localized, t as tr, Trans, language } from '@/lib/i18n'

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
    <AccountLayout title={tr('account:accessTokens.accessTokens')}>
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
      toast.success(tr('account:accessTokens.revoked', { name: t.name }))
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey })
    },
    onError: (e) => toast.error(e.message),
  })
  const [now] = useState(() => Date.now())
  return (
    <SettingsSection
      title={tr('account:accessTokens.personalAccessTokens')}
      description={tr('account:accessTokens.forScriptsAndCiAToken')}
    >
      <div className="flex justify-end">
        <Button variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
          {tr('account:accessTokens.generateNewToken')}
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
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{tr('account:accessTokens.noTokensYet')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{tr('account:accessTokens.name')}</TableHead>
                <TableHead>{tr('account:accessTokens.lastUsed')}</TableHead>
                <TableHead>{tr('account:accessTokens.expires')}</TableHead>
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
                        <span className="text-foreground-lighter">{tr('account:accessTokens.never')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {expired ? <Badge variant="warning">{tr('account:accessTokens.expired')}</Badge> : new Date(t.expires_at).toLocaleDateString(language())}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="tiny" variant="default" onClick={() => setRevoking(t)}>
                        {expired ? tr('account:accessTokens.remove') : tr('account:accessTokens.revoke')}
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
        title={tr('account:accessTokens.revoke2', { name: revoking?.name })}
        description={tr('account:accessTokens.anythingUsingItStopsWorkingStraight')}
        confirmLabel={tr('account:accessTokens.revoke')}
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </SettingsSection>
  )
}

const EXPIRY = localized(() => [
  { days: 7, label: tr('account:accessTokens.n7Days') },
  { days: 30, label: tr('account:accessTokens.n30Days') },
  { days: 90, label: tr('account:accessTokens.n90Days') },
  { days: 365, label: tr('account:accessTokens.n1Year') },
])

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
              <DialogTitle>{tr('account:accessTokens.copyYourToken')}</DialogTitle>
              <DialogDescription>{tr('account:accessTokens.itIsnTShownAgainIf')}</DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              <CopyField value={token} />
              <CodeBlock code={`curl -H "Authorization: Bearer ${token}" ${window.location.origin}/v1/projects`} />
            </DialogSection>
            <DialogFooter>
              <Button variant="primary" onClick={onClose}>
                {tr('account:accessTokens.done')}
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
              <DialogTitle>{tr('account:accessTokens.generateANewToken')}</DialogTitle>
              <DialogDescription>{tr('account:accessTokens.giveEachScriptOrServiceIts')}</DialogDescription>
            </DialogHeader>
            <DialogSection className="flex flex-col gap-4 border-t">
              <FormField label={tr('account:accessTokens.name')} htmlFor="tok-name" description={tr('account:accessTokens.whatWillUseItLikeGithub')}>
                <Input id="tok-name" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label={tr('account:accessTokens.expiresAfter')} htmlFor="tok-expiry">
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger id="tok-expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY().map((e) => (
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
                {tr('account:accessTokens.cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
                {tr('account:accessTokens.generateToken')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

const V1_ENDPOINTS = localized((): [string, string, string][] => [
  ['GET', '/v1/organizations', tr('account:accessTokens.yourOrganizations')],
  ['GET', '/v1/organizations/{slug}', tr('account:accessTokens.anOrganization')],
  ['GET', '/v1/organizations/{slug}/members', tr('account:accessTokens.itsMembers')],
  ['GET', '/v1/projects', tr('account:accessTokens.projectsYouCanSee')],
  ['GET', '/v1/projects/{ref}', tr('account:accessTokens.aProject')],
  ['GET', '/v1/projects/{ref}/health', tr('account:accessTokens.itsServicesHealthServicesAuthDb')],
  ['GET', '/v1/projects/{ref}/api-keys', tr('account:accessTokens.itsApiKeysSecretOnesIf')],
  ['POST', '/v1/projects/{ref}/database/query', tr('account:accessTokens.runSqlQueryAnswersWithThe')],
  ['GET', '/v1/projects/{ref}/database/backups', tr('account:accessTokens.itsBackups')],
  ['GET', '/v1/projects/{ref}/functions', tr('account:accessTokens.itsEdgeFunctions')],
  ['GET', '/v1/projects/{ref}/functions/{slug}', tr('account:accessTokens.anEdgeFunction')],
  ['DELETE', '/v1/projects/{ref}/functions/{slug}', tr('account:accountAccessTokens.deleteAnEdgeFunction')],
  ['GET', '/v1/projects/{ref}/secrets', tr('account:accessTokens.edgeFunctionSecretsValuesAsSha')],
  ['POST', '/v1/projects/{ref}/secrets', tr('account:accessTokens.addOrReplaceSecretsNameValue')],
  ['DELETE', '/v1/projects/{ref}/secrets', tr('account:accessTokens.removeSecretsName')],
  ['POST', '/v1/projects/{ref}/pause', tr('account:accessTokens.pauseAStackSupermixerCreated')],
  ['POST', '/v1/projects/{ref}/restore', tr('account:accessTokens.startItAgain')],
])

function UsageSection() {
  const origin = window.location.origin
  return (
    <SettingsSection
      title={tr('account:accessTokens.usingTheApi')}
      description={tr('account:accessTokens.sendTheTokenAsAuthorizationBearer')}
    >
      <Card className="flex flex-col gap-4 p-5 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-foreground">{tr('account:accessTokens.supabaseStyleManagementApi')}</span>
          <span className="text-foreground-light">
            {tr('account:accessTokens.aSubsetOfSupabaseSManagement')}
          </span>
          <CopyField value={`${origin}/v1`} />
        </div>
        <ul className="flex flex-col divide-y rounded-md border">
          {V1_ENDPOINTS().map(([method, path, what]) => (
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
          <span className="text-foreground">{tr('account:accessTokens.supermixerSApi')}</span>
          <span className="text-foreground-light">
            {tr('account:accessTokens.everythingTheAppDoesSuchAs')}
          </span>
          <CopyField value={`${origin}/api/v1`} />
          <span className="text-foreground-light">
            <Trans i18nKey="account:accessTokens.describedInOpenapiJsonOpenapi3" components={{ a: <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="text-link" /> }} />
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
