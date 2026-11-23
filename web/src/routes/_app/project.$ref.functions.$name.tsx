import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DatabasePage } from '@/components/database/catalog-page'
import {
  ENTRYPOINTS,
  NEW_FUNCTION_FILES,
  formatBytes,
  functionNameProblem,
  functionQuery,
  functionsQuery,
  type FunctionFile,
} from '@/components/functions/api'
import { FunctionCodeEditor } from '@/components/functions/code-editor'
import { FunctionInvoker } from '@/components/functions/invoker'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { api, isApiError, unwrap } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'

export const Route = createFileRoute('/_app/project/$ref/functions/$name')({
  validateSearch: (search: Record<string, unknown>): { new?: boolean } =>
    search.new === true || search.new === 'true' ? { new: true } : {},
  component: FunctionPage,
})

const sameFiles = (a: FunctionFile[], b: FunctionFile[]) =>
  a.length === b.length && a.every((f) => b.some((g) => g.path === f.path && g.content === f.content))

function FunctionPage() {
  const { ref, name } = Route.useParams()
  const { new: creating } = Route.useSearch()
  const project = useSelectedProject()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canDeploy = can(project, 'project:functions:deploy')
  const fn = useQuery({ ...functionQuery(ref, name), enabled: !!project?.stack })
  const missing = isApiError(fn.error, 404)
  const isNew = !!creating && missing

  // What's deployed (or the example, for a new function), and the edits.
  const saved = useMemo(() => (fn.data ? fn.data.files : isNew ? NEW_FUNCTION_FILES : null), [fn.data, isNew])
  // Edits count only while they're based on what's saved now; a deploy (or
  // reload) that changes it starts again from the new version.
  const [edits, setEdits] = useState<{ base: FunctionFile[] | null; files: FunctionFile[] | null }>({ base: null, files: null })
  const files = edits.base === saved ? edits.files : saved
  const setFiles = (next: FunctionFile[] | null) => setEdits({ base: saved, files: next })
  const dirty = !!files && !!saved && (isNew || !sameFiles(files, saved))
  const missingEntry = !!files && !files.some((f) => ENTRYPOINTS.includes(f.path)) && !(fn.data?.other_files ?? []).some((p) => ENTRYPOINTS.includes(p))

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: functionsQuery(ref).queryKey })
    void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'stack'] })
  }
  const deploy = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/projects/{ref}/functions/{name}', {
          params: { path: { ref, name } },
          body: { files: files ?? [], keep: fn.data?.other_files ?? [] },
        })
      ),
    onSuccess: async (res) => {
      toast.success(res.restarted ? `Deployed ${name}` : `Saved ${name}; it takes effect when the stack starts`)
      refresh()
      await queryClient.invalidateQueries({ queryKey: functionQuery(ref, name).queryKey })
      if (creating) void navigate({ to: '/project/$ref/functions/$name', params: { ref, name }, search: {}, replace: true })
    },
    onError: () => {
      // The files may be saved even if the restart failed.
      void queryClient.invalidateQueries({ queryKey: functionQuery(ref, name).queryKey })
      refresh()
    },
  })
  const [deleting, setDeleting] = useState(false)
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/projects/{ref}/functions/{name}', { params: { path: { ref, name } } })),
    onSuccess: () => {
      toast.success(`Deleted ${name}`)
      queryClient.removeQueries({ queryKey: functionQuery(ref, name).queryKey })
      refresh()
      void navigate({ to: '/project/$ref/functions', params: { ref } })
    },
  })

  if (!project) return null
  if (!project.stack) {
    return (
      <DatabasePage title={name}>
        <Alert title="Supermixer connects to this stack, so it can't see its functions folder" />
      </DatabasePage>
    )
  }
  if (isNew && functionNameProblem(name)) {
    return (
      <DatabasePage title={name}>
        <Alert variant="destructive" title={functionNameProblem(name)!} />
      </DatabasePage>
    )
  }
  if (fn.error && !isNew) {
    return (
      <DatabasePage title={name}>
        <Alert variant="destructive" title={missing ? `There's no function called ${name}` : fn.error.message} />
      </DatabasePage>
    )
  }

  const url = fn.data?.function.url ?? `${project.api_url.replace(/\/$/, '')}/functions/v1/${name}`
  return (
    <DatabasePage
      title={name}
      description={<span className="font-mono text-xs">{url}</span>}
      actions={
        <>
          {dirty && !isNew && (
            <Button variant="default" disabled={deploy.isPending} onClick={() => setFiles(saved)}>
              Discard changes
            </Button>
          )}
          <PermissionButton
            allowed={canDeploy}
            action="deploy functions"
            variant="primary"
            loading={deploy.isPending}
            disabled={!files || !dirty || missingEntry}
            onClick={() => deploy.mutate()}
          >
            {isNew ? 'Deploy function' : 'Deploy changes'}
          </PermissionButton>
        </>
      }
    >
      {deploy.error && <Alert variant="destructive" title={deploy.error.message} />}
      {project.stack.status !== 'running' && (
        <Alert title="The stack isn't running">Deployed changes take effect when it starts.</Alert>
      )}
      <Tabs defaultValue="code">
        <TabsList>
          <TabsTrigger value="code">Code{dirty ? ' •' : ''}</TabsTrigger>
          <TabsTrigger value="test" disabled={isNew}>
            Test
          </TabsTrigger>
          <TabsTrigger value="details" disabled={isNew}>
            Details
          </TabsTrigger>
        </TabsList>
        <TabsContent value="code" className="flex flex-col gap-3">
          {!files ? (
            <Skeleton className="h-[34rem]" />
          ) : (
            <FunctionCodeEditor
              files={files}
              onChange={setFiles}
              // Locked while deploying: edits made meanwhile would be replaced
              // by the deployed version when it reloads.
              readOnly={!canDeploy || deploy.isPending}
              modelPrefix={`file:///${ref}/${name}`}
            />
          )}
          {missingEntry && (
            <Alert variant="warning" title="A function needs an index.ts (or index.js) at its top level" />
          )}
          {(fn.data?.other_files.length ?? 0) > 0 && (
            <p className="text-xs text-foreground-lighter">
              Kept as they are, since they can’t be edited here: {fn.data!.other_files.join(', ')}
            </p>
          )}
          <p className="text-xs text-foreground-lighter">
            Deploying replaces the function’s files and restarts the stack’s functions service (a few seconds, for every
            function). Secrets are in Edge Functions › Secrets. Function code can read the project’s keys, so deploying
            needs the same access as revealing them.
          </p>
        </TabsContent>
        <TabsContent value="test">
          <FunctionInvoker projectRef={ref} initialName={name} />
        </TabsContent>
        <TabsContent value="details" className="flex flex-col gap-8">
          {fn.data && (
            <Card className="flex flex-col divide-y text-sm">
              <Row label="URL">
                <CopyField value={url} />
              </Row>
              <Row label="Entrypoint">
                <span className="font-mono text-xs">{fn.data.function.entrypoint ?? '—'}</span>
              </Row>
              <Row label="Files">
                {fn.data.function.files} · {formatBytes(fn.data.function.size)}
              </Row>
              <Row label="Updated">{relativeTime(fn.data.function.updated_at)}</Row>
              <Row label="Folder">
                <span className="font-mono text-xs text-foreground-light">volumes/functions/{name}</span>
              </Row>
            </Card>
          )}
          <SettingsSection title="Danger zone">
            <Alert
              variant="destructive"
              title="Delete this function"
              actions={
                <PermissionButton allowed={canDeploy} action="delete functions" variant="danger" onClick={() => setDeleting(true)}>
                  Delete function
                </PermissionButton>
              }
            >
              Its folder is removed and its URL stops answering. This can’t be undone.
            </Alert>
          </SettingsSection>
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${name}?`}
        description="Its files are deleted and the stack's functions service restarts."
        confirmLabel="Delete function"
        confirmText={name}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        {remove.error && <Alert variant="destructive" title={remove.error.message} />}
      </ConfirmDialog>
    </DatabasePage>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
      <span className="text-foreground-lighter">{label}</span>
      <span className="col-span-2">{children}</span>
    </div>
  )
}
