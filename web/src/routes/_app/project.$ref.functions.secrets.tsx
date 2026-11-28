import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DatabasePage } from '@/components/database/catalog-page'
import { functionSecretsQuery, functionSettingsQuery } from '@/components/functions/api'
import { parseEnv } from '@/components/functions/env'
import { AddIcon, DeleteIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/functions/secrets')({
  component: SecretsPage,
})

/** Variables the stack gives every function itself. */
const BUILT_IN = [
  'SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEYS',
  'SUPABASE_SECRET_KEYS',
  'SUPABASE_DB_URL',
]

function nameProblem(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)) return t('functions:functionsSecrets.lettersDigitsAndNotStartingWith')
  const upper = name.toUpperCase()
  if (upper.startsWith('SUPABASE_') || upper.startsWith('SB_')) return t('functions:functionsSecrets.supabaseAndSbNamesAreReserved')
  if (upper === 'JWT_SECRET' || upper === 'VERIFY_JWT') return t('functions:functionsSecrets.setByTheStack')
  return null
}

interface Row {
  name: string
  value: string
}

function SecretsPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  if (!project) return null
  const description =
    t('functions:functionsSecrets.environmentVariablesEveryFunctionOfThis')
  if (!project.stack) {
    return (
      <DatabasePage title={t('functions:functionsSecrets.edgeFunctionSecrets')} description={description}>
        <Alert title={t('functions:functionsSecrets.supermixerConnectsToThisStackSo')}>
          {t('functions:functionsSecrets.setSecretsWhereTheStackRuns')}
        </Alert>
      </DatabasePage>
    )
  }
  if (!can(project, 'project:secrets:read')) {
    return (
      <DatabasePage title={t('functions:functionsSecrets.edgeFunctionSecrets')} description={description}>
        <Alert title={t('functions:functionsSecrets.youNeedAdditionalPermissionsToView')} />
      </DatabasePage>
    )
  }
  return (
    <DatabasePage title={t('functions:functionsSecrets.edgeFunctionSecrets')} description={description}>
      <AdminAccess projectRef={ref} canChange={can(project, 'project:update')} />
      <DatabaseAccess projectRef={ref} canChange={can(project, 'project:update')} />
      <Secrets
        projectRef={ref}
        running={project.stack.status === 'running'}
        canChange={can(project, 'project:functions:deploy')}
      />
    </DatabasePage>
  )
}

function Secrets({ projectRef: ref, running, canChange }: { projectRef: string; running: boolean; canChange: boolean }) {
  const queryClient = useQueryClient()
  const secrets = useQuery(functionSecretsQuery(ref))
  const [rows, setRows] = useState<Row[]>([{ name: '', value: '' }])
  const [removing, setRemoving] = useState<string | null>(null)

  const done = (restarted: boolean, what: string) => {
    toast.success(restarted ? what : t('functions:functionsSecrets.theyTakeEffectWhenTheStack', { what }))
    void queryClient.invalidateQueries({ queryKey: functionSecretsQuery(ref).queryKey })
    void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] })
  }
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/projects/{ref}/function-secrets', {
          params: { path: { ref } },
          body: { secrets: rows.map((r) => ({ name: r.name.trim(), value: r.value })) },
        })
      ),
    onSuccess: (res) => {
      done(res.restarted, rows.length === 1 ? t('functions:functionsSecrets.saved', { trim: rows[0]!.name.trim() }) : t('functions:functionsSecrets.savedSecrets', { length: rows.length }))
      setRows([{ name: '', value: '' }])
    },
  })
  const remove = useMutation({
    mutationFn: (name: string) =>
      unwrap(api.DELETE('/projects/{ref}/function-secrets', { params: { path: { ref } }, body: { names: [name] } })),
    onSuccess: (res, name) => {
      done(res.restarted, t('functions:functionsSecrets.removed', { name }))
      setRemoving(null)
    },
  })

  const problems = rows.map((r) => (r.name.trim() ? nameProblem(r.name.trim()) : null))
  const names = rows.map((r) => r.name.trim())
  const duplicate = names.find((n, i) => n && names.indexOf(n) !== i)
  const ready = rows.every((r) => r.name.trim()) && problems.every((p) => !p) && !duplicate
  const existing = new Set((secrets.data ?? []).map((s) => s.name))
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <>
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-foreground">{t('functions:functionsSecrets.addOrReplaceSecrets')}</span>
          <span className="text-xs text-foreground-lighter">
            {t('functions:functionsSecrets.pasteTheLinesOfAEnv')}
          </span>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && canChange) save.mutate()
          }}
        >
          {rows.map((r, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_1.5fr_auto] items-center gap-2">
                <Input
                  aria-label={t('functions:functionsSecrets.name')}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder={t('functions:functionsSecrets.stripeSecretKey')}
                  value={r.name}
                  disabled={!canChange || save.isPending}
                  onChange={(e) => update(i, { name: e.target.value })}
                  onPaste={(e) => {
                    const parsed = parseEnv(e.clipboardData.getData('text'))
                    if (parsed.length === 0) return
                    e.preventDefault()
                    const kept = rows.filter((row, j) => j !== i && (row.name || row.value))
                    setRows([...kept, ...parsed])
                  }}
                />
                <Input
                  aria-label={t('functions:functionsSecrets.value')}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder={t('functions:functionsSecrets.value')}
                  value={r.value}
                  disabled={!canChange || save.isPending}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
                <Button
                  type="button"
                  variant="text"
                  size="tiny"
                  aria-label={t('functions:functionsSecrets.removeThisRow')}
                  icon={<DeleteIcon />}
                  disabled={rows.length === 1 || save.isPending}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                />
              </div>
              {problems[i] && <span className="text-xs text-destructive">{problems[i]}</span>}
              {!problems[i] && existing.has(r.name.trim()) && (
                <span className="text-xs text-foreground-lighter">{t('functions:functionsSecrets.replacesTheCurrentValue')}</span>
              )}
            </div>
          ))}
          {duplicate && <span className="text-xs text-destructive">{t('functions:functionsSecrets.isListedTwice', { duplicate })}</span>}
          {save.error && <Alert variant="destructive" title={save.error.message} />}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="default"
              size="tiny"
              icon={<AddIcon />}
              disabled={!canChange || save.isPending}
              onClick={() => setRows([...rows, { name: '', value: '' }])}
            >
              {t('functions:functionsSecrets.addAnother')}
            </Button>
            <PermissionButton allowed={canChange} action={t('functions:functionsSecrets.changeFunctionSecrets')} type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
              {t('functions:functionsSecrets.save')}
            </PermissionButton>
          </div>
        </form>
      </Card>
      {!running && <Alert title={t('functions:functionsSecrets.theStackIsnTRunning')}>{t('functions:functionsSecrets.savedSecretsTakeEffectWhenIt')}</Alert>}

      {secrets.error ? (
        <Alert variant="destructive" title={secrets.error.message} />
      ) : !secrets.data ? (
        <Skeleton className="h-32" />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('functions:functionsSecrets.name')}</TableHead>
                <TableHead>{t('functions:functionsSecrets.digestSha256')}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.data.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="font-mono text-xs text-foreground">{s.name}</TableCell>
                  <TableCell className="font-mono text-xs text-foreground-lighter" title={s.digest}>
                    {s.digest.slice(0, 16)}…
                  </TableCell>
                  <TableCell>
                    <PermissionButton
                      allowed={canChange}
                      action={t('functions:functionsSecrets.changeFunctionSecrets')}
                      variant="text"
                      size="tiny"
                      aria-label={t('functions:functionsSecrets.remove', { name: s.name })}
                      icon={<DeleteIcon />}
                      onClick={() => setRemoving(s.name)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {BUILT_IN.map((name) => (
                <TableRow key={name} className="hover:bg-transparent">
                  <TableCell className="font-mono text-xs text-foreground-lighter">{name}</TableCell>
                  <TableCell className="text-xs text-foreground-lighter" colSpan={2}>
                    {t('functions:functionsSecrets.setByTheStack')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('functions:functionsSecrets.remove2', { removing })}
        description={t('functions:functionsSecrets.functionsStopSeeingItOnceThe')}
        confirmLabel={t('functions:functionsSecrets.removeSecret')}
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        {remove.error && <Alert variant="destructive" title={remove.error.message} />}
      </ConfirmDialog>
    </>
  )
}

const ADMIN = localized((): { value: boolean; title: string; text: string }[] => [
  {
    value: true,
    title: t('functions:functionsSecrets.adminAccessDefault'),
    text: t('functions:functionsSecrets.functionsGetSupabaseServiceRoleKey'),
  },
  {
    value: false,
    title: t('functions:functionsSecrets.callerSAccessOnly'),
    text: t('functions:functionsSecrets.functionsGetNoneOfThemThey'),
  },
])

/** Whether functions get the admin keys and the database URL. */
function AdminAccess({ projectRef: ref, canChange }: { projectRef: string; canChange: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery(functionSettingsQuery(ref))
  const [confirm, setConfirm] = useState(false)
  const set = useMutation({
    mutationFn: (on: boolean) =>
      unwrap(api.PUT('/projects/{ref}/function-settings', { params: { path: { ref } }, body: { admin_access: on } })),
    onSuccess: (res) => {
      toast.success(
        (res.admin_access ? t('functions:functionsSecrets.functionsHaveAdminAccessAgain') : t('functions:functionsSecrets.functionsNowActAsTheirCaller')) +
          (res.restarted ? '' : t('functions:functionsSecrets.thisTakesEffectWhenTheStack'))
      )
      setConfirm(false)
      void queryClient.invalidateQueries({ queryKey: functionSettingsQuery(ref).queryKey })
    },
  })
  const current = settings.data?.admin_access
  const choose = (on: boolean) => {
    if (on === current || set.isPending) return
    if (!on) setConfirm(true)
    else set.mutate(true)
  }
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-foreground">{t('functions:functionsSecrets.adminAccess')}</span>
        <span className="text-xs text-foreground-lighter">
          {t('functions:functionsSecrets.whetherDeployedCodeCanActWith')}
          {!canChange && t('functions:functionsSecrets.ownersAndAdministratorsCanChangeIt')}
        </span>
      </div>
      {settings.error ? (
        <Alert variant="destructive" title={settings.error.message} />
      ) : current === undefined ? (
        <Skeleton className="h-20" />
      ) : (
        <div role="radiogroup" aria-label={t('functions:functionsSecrets.adminAccess')} className="grid gap-3 sm:grid-cols-2">
          {ADMIN().map((a) => (
            <button
              key={String(a.value)}
              type="button"
              role="radio"
              aria-checked={current === a.value}
              disabled={!canChange || set.isPending}
              onClick={() => choose(a.value)}
              className={cn(
                'flex flex-col gap-1 rounded-panel border px-4 py-3 text-left focus-ring disabled:cursor-not-allowed',
                current === a.value ? 'border-primary-bright bg-surface-100' : 'enabled:hover:border-strong',
                !canChange && current !== a.value && 'opacity-60'
              )}
            >
              <span className="text-sm text-foreground">{a.title}</span>
              <span className="text-xs text-foreground-lighter">{a.text}</span>
            </button>
          ))}
        </div>
      )}
      {set.error && !confirm && <Alert variant="destructive" title={set.error.message} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        variant="warning"
        title={t('functions:functionsSecrets.turnOffTheFunctionsAdminAccess')}
        description={t('functions:functionsSecrets.functionsStopGettingSupabaseServiceRole')}
        confirmLabel={t('functions:functionsSecrets.turnOffAdminAccess')}
        loading={set.isPending}
        onConfirm={() => set.mutate(false)}
      >
        {set.error && <Alert variant="destructive" title={set.error.message} />}
      </ConfirmDialog>
    </Card>
  )
}

type Access = 'service_role' | 'postgres'

const ACCESS = localized((): { value: Access; title: string; text: string }[] => [
  {
    value: 'service_role',
    title: t('functions:functionsSecrets.serviceRoleRecommended'),
    text: t('functions:functionsSecrets.bypassesRowLevelSecurityLikeThe'),
  },
  {
    value: 'postgres',
    title: 'postgres',
    text: t('functions:functionsSecrets.administrativeAccessCanAlsoCreateRoles'),
  },
])

/** Which login SUPABASE_DB_URL gives functions. */
function DatabaseAccess({ projectRef: ref, canChange }: { projectRef: string; canChange: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery(functionSettingsQuery(ref))
  const [confirm, setConfirm] = useState(false)
  const set = useMutation({
    mutationFn: (access: Access) =>
      unwrap(api.PUT('/projects/{ref}/function-settings', { params: { path: { ref } }, body: { database_access: access } })),
    onSuccess: (res) => {
      toast.success(
        (res.database_access === 'postgres' ? t('functions:functionsSecrets.functionsNowReachAsPostgres') : t('functions:functionsSecrets.functionsNowReachAsServiceRole')) +
          (res.restarted ? '' : t('functions:functionsSecrets.thisTakesEffectWhenTheStack'))
      )
      setConfirm(false)
      void queryClient.invalidateQueries({ queryKey: functionSettingsQuery(ref).queryKey })
    },
  })
  const current = settings.data?.database_access
  const withheld = settings.data?.admin_access === false
  const choose = (access: Access) => {
    if (access === current || set.isPending) return
    if (access === 'postgres') setConfirm(true)
    else set.mutate(access)
  }
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-foreground">{t('functions:functionsSecrets.databaseAccess')}</span>
        <span className="text-xs text-foreground-lighter">
          {t('functions:functionsSecrets.theLoginInSupabaseDbUrl')}
          {withheld && t('functions:functionsSecrets.functionsDonTGetSupabaseDb')}
          {!canChange && t('functions:functionsSecrets.ownersAndAdministratorsCanChangeIt')}
        </span>
      </div>
      {settings.error ? (
        <Alert variant="destructive" title={settings.error.message} />
      ) : !current ? (
        <Skeleton className="h-20" />
      ) : (
        <div role="radiogroup" aria-label={t('functions:functionsSecrets.databaseAccess')} className="grid gap-3 sm:grid-cols-2">
          {ACCESS().map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={current === a.value}
              disabled={!canChange || set.isPending}
              onClick={() => choose(a.value)}
              className={cn(
                'flex flex-col gap-1 rounded-panel border px-4 py-3 text-left focus-ring disabled:cursor-not-allowed',
                current === a.value ? 'border-primary-bright bg-surface-100' : 'enabled:hover:border-strong',
                !canChange && current !== a.value && 'opacity-60'
              )}
            >
              <span className="text-sm text-foreground">{a.title}</span>
              <span className="text-xs text-foreground-lighter">{a.text}</span>
            </button>
          ))}
        </div>
      )}
      {set.error && !confirm && <Alert variant="destructive" title={set.error.message} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        variant="warning"
        title={t('functions:functionsSecrets.giveFunctionsThePostgresLogin')}
        description={t('functions:functionsSecrets.anyFunctionDeployedToThisProject')}
        confirmLabel={t('functions:functionsSecrets.usePostgres')}
        loading={set.isPending}
        onConfirm={() => set.mutate('postgres')}
      >
        {set.error && <Alert variant="destructive" title={set.error.message} />}
      </ConfirmDialog>
    </Card>
  )
}
