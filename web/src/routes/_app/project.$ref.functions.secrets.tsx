import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DatabasePage } from '@/components/database/catalog-page'
import { functionSecretsQuery } from '@/components/functions/api'
import { parseEnv } from '@/components/functions/env'
import { AddIcon, DeleteIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'

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
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)) return 'Letters, digits and _, not starting with a digit'
  const upper = name.toUpperCase()
  if (upper.startsWith('SUPABASE_') || upper.startsWith('SB_')) return 'SUPABASE_ and SB_ names are reserved'
  if (upper === 'JWT_SECRET' || upper === 'VERIFY_JWT') return 'Set by the stack'
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
    'Environment variables every function of this stack can read with Deno.env.get(). Values are never shown again; each is listed by its SHA-256 digest.'
  if (!project.stack) {
    return (
      <DatabasePage title="Edge Function Secrets" description={description}>
        <Alert title="Supermixer connects to this stack, so it can't change its functions' environment">
          Set secrets where the stack runs. Stacks created with “Create a new stack” manage their secrets here.
        </Alert>
      </DatabasePage>
    )
  }
  if (!can(project, 'project:secrets:read')) {
    return (
      <DatabasePage title="Edge Function Secrets" description={description}>
        <Alert title="You need additional permissions to view function secrets" />
      </DatabasePage>
    )
  }
  return (
    <DatabasePage title="Edge Function Secrets" description={description}>
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
    toast.success(restarted ? what : `${what}; they take effect when the stack starts`)
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
      done(res.restarted, rows.length === 1 ? `Saved ${rows[0]!.name.trim()}` : `Saved ${rows.length} secrets`)
      setRows([{ name: '', value: '' }])
    },
  })
  const remove = useMutation({
    mutationFn: (name: string) =>
      unwrap(api.DELETE('/projects/{ref}/function-secrets', { params: { path: { ref } }, body: { names: [name] } })),
    onSuccess: (res, name) => {
      done(res.restarted, `Removed ${name}`)
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
          <span className="text-sm text-foreground">Add or replace secrets</span>
          <span className="text-xs text-foreground-lighter">
            Paste the lines of a .env file into a name field to fill in several at once. Saving restarts the stack’s
            functions service.
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
                  aria-label="Name"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="STRIPE_SECRET_KEY"
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
                  aria-label="Value"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="Value"
                  value={r.value}
                  disabled={!canChange || save.isPending}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
                <Button
                  type="button"
                  variant="text"
                  size="tiny"
                  aria-label="Remove this row"
                  icon={<DeleteIcon />}
                  disabled={rows.length === 1 || save.isPending}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                />
              </div>
              {problems[i] && <span className="text-xs text-destructive">{problems[i]}</span>}
              {!problems[i] && existing.has(r.name.trim()) && (
                <span className="text-xs text-foreground-lighter">Replaces the current value</span>
              )}
            </div>
          ))}
          {duplicate && <span className="text-xs text-destructive">{duplicate} is listed twice</span>}
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
              Add another
            </Button>
            <PermissionButton allowed={canChange} action="change function secrets" type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
              Save
            </PermissionButton>
          </div>
        </form>
      </Card>
      {!running && <Alert title="The stack isn't running">Saved secrets take effect when it starts.</Alert>}

      {secrets.error ? (
        <Alert variant="destructive" title={secrets.error.message} />
      ) : !secrets.data ? (
        <Skeleton className="h-32" />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Digest (SHA-256)</TableHead>
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
                      action="change function secrets"
                      variant="text"
                      size="tiny"
                      aria-label={`Remove ${s.name}`}
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
                    Set by the stack
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
        title={`Remove ${removing}?`}
        description="Functions stop seeing it once the functions service restarts."
        confirmLabel="Remove secret"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        {remove.error && <Alert variant="destructive" title={remove.error.message} />}
      </ConfirmDialog>
    </>
  )
}
