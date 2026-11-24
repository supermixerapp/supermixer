/*
 * A function's kept versions: the last deploys, with their hashes, to
 * inspect or put back (Edge Functions › <function> › Versions).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { formatBytes, functionQuery, functionsQuery } from '@/components/functions/api'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyButton } from '@/components/ui/copy'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { relativeTime } from '@/lib/auth-users'

type Version = Schemas['FunctionVersion']

const KIND: Record<Version['kind'], { label: string; hint: string }> = {
  deployed: { label: 'Deployed', hint: 'Deployed from Supermixer.' },
  restored: { label: 'Restored', hint: 'An earlier version, deployed again.' },
  found: {
    label: 'Found',
    hint: 'The function as Supermixer found it before changing it: deployed before versions were kept, or changed outside Supermixer.',
  },
}

export const functionVersionsQuery = (ref: string, name: string) => ({
  queryKey: ['projects', ref, 'functions', name, 'versions'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/functions/{name}/versions', { params: { path: { ref, name } } })),
})

export function FunctionVersions({
  projectRef: ref,
  name,
  canDeploy,
  current,
}: {
  projectRef: string
  name: string
  canDeploy: boolean
  /** The deployed function's hash, if it exists, to mark its version. */
  current?: string
}) {
  const queryClient = useQueryClient()
  const versions = useQuery(functionVersionsQuery(ref, name))
  const [viewing, setViewing] = useState<Version | null>(null)
  const [restoring, setRestoring] = useState<Version | null>(null)
  const restore = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/projects/{ref}/functions/{name}/versions/{id}/restore', { params: { path: { ref, name, id } } })
      ),
    onSuccess: (res) => {
      toast.success(res.restarted ? `Restored ${name}` : `Restored ${name}; it takes effect when the stack starts`)
      setRestoring(null)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: functionQuery(ref, name).queryKey })
      void queryClient.invalidateQueries({ queryKey: functionsQuery(ref).queryKey })
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] })
    },
  })

  if (versions.error) return <Alert variant="destructive" title={versions.error.message} />
  if (!versions.data) return <Skeleton className="h-40" />
  const list = versions.data
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>SHA-256</TableHead>
              <TableHead className="text-right">Files</TableHead>
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-8 text-center text-foreground-lighter">
                  No versions kept yet; the next deploy is the first.
                </TableCell>
              </TableRow>
            ) : (
              list.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <span className="flex flex-col">
                      <span className="whitespace-nowrap text-foreground">{new Date(v.created_at).toLocaleString()}</span>
                      <span className="text-xs text-foreground-lighter">
                        {relativeTime(v.created_at)}
                        {v.created_by && <> · by {v.created_by}</>}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1" title={KIND[v.kind].hint}>
                      <Badge variant={v.kind === 'found' ? 'warning' : 'default'}>{KIND[v.kind].label}</Badge>
                      {current === v.sha256 && <Badge variant="success">Current</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1 font-mono text-xs whitespace-nowrap text-foreground-light">
                      {v.sha256.slice(0, 12)}…
                      <CopyButton value={v.sha256} label="Copy the full hash" iconOnly />
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap text-foreground-light">
                    {v.files.length} · {formatBytes(v.size)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex justify-end gap-2">
                      <Button size="tiny" variant="default" onClick={() => setViewing(v)}>
                        View
                      </Button>
                      <PermissionButton
                        allowed={canDeploy}
                        action="deploy functions"
                        size="tiny"
                        variant="default"
                        disabled={current === v.sha256}
                        onClick={() => setRestoring(v)}
                      >
                        Restore
                      </PermissionButton>
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs text-foreground-lighter">
        The last 10 versions are kept, also after the function is deleted. The audit log records each deploy with these
        hashes, so you can check what ran.
      </p>

      <VersionSheet projectRef={ref} name={name} version={viewing} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        variant="warning"
        title={`Restore this version of ${name}?`}
        description={
          restoring && (
            <>
              The function’s files are replaced with the version of {new Date(restoring.created_at).toLocaleString()}, and
              the stack’s functions service restarts. The current files are kept as a version first.
            </>
          )
        }
        confirmLabel="Restore"
        loading={restore.isPending}
        onConfirm={() => restoring && restore.mutate(restoring.id)}
      >
        {restore.error && <Alert variant="destructive" title={restore.error.message} />}
      </ConfirmDialog>
    </div>
  )
}

function VersionSheet({
  projectRef: ref,
  name,
  version,
  onClose,
}: {
  projectRef: string
  name: string
  version: Version | null
  onClose: () => void
}) {
  const id = version?.id ?? ''
  const detail = useQuery({
    queryKey: ['projects', ref, 'functions', name, 'versions', id],
    queryFn: () =>
      unwrap(api.GET('/projects/{ref}/functions/{name}/versions/{id}', { params: { path: { ref, name, id } } })),
    enabled: !!version,
    staleTime: Infinity,
  })
  return (
    <Sheet open={!!version} onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg" className="flex flex-col">
        {version && (
          <>
            <SheetHeader>
              <SheetTitle>
                {name}, {new Date(version.created_at).toLocaleString()}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs break-all">{version.sha256}</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto">
              <SheetSection className="flex flex-col gap-2">
                <h3 className="text-xs text-foreground-lighter">Files</h3>
                <ul className="flex flex-col divide-y rounded-md border text-xs">
                  {version.files.map((f) => (
                    <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="font-mono text-foreground">
                        {f.path}
                        {f.link && <span className="text-foreground-lighter"> → {f.link}</span>}
                        {f.unreadable && <span className="text-warning-600"> (couldn’t be read, so not kept)</span>}
                      </span>
                      {!f.unreadable && (
                        <span className="font-mono text-foreground-lighter" title={f.sha256}>
                          {f.sha256.slice(0, 12)}… · {formatBytes(f.size)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </SheetSection>
              {detail.error && (
                <SheetSection>
                  <Alert variant="destructive" title={detail.error.message} />
                </SheetSection>
              )}
              {!detail.data && !detail.error ? (
                <SheetSection>
                  <Skeleton className="h-40" />
                </SheetSection>
              ) : (
                detail.data?.files.map((f) => (
                  <SheetSection key={f.path} className="flex flex-col gap-2 border-t">
                    <h3 className="font-mono text-xs text-foreground-light">{f.path}</h3>
                    <pre className="max-h-96 overflow-auto rounded-md border bg-surface-100 p-3 font-mono text-xs text-foreground">
                      {f.content}
                    </pre>
                  </SheetSection>
                ))
              )}
              {(detail.data?.other_files.length ?? 0) > 0 && (
                <SheetSection className="border-t text-xs text-foreground-lighter">
                  Not shown, since they aren’t text: {detail.data!.other_files.join(', ')}
                </SheetSection>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
