import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { LockIcon, PlayIcon, PublicIcon, SaveIcon } from '@/components/icons'
import { CodeEditor, type CodeEditorHandle, type Runnable } from '@/components/sql/code-editor'
import { CATALOG_SQL, setCatalog, type SchemaCatalog } from '@/components/sql/monaco'
import { ResultsPanel } from '@/components/sql/results'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { snippetQuery, snippetsQuery } from '@/lib/api/queries'
import { runSql, SqlError, usePg, type QueryResponse } from '@/lib/pg/run'
import { SQL_TEMPLATES } from '@/lib/sql-templates'

export const Route = createFileRoute('/_app/project/$ref/sql/$id')({
  component: SqlEditorPage,
})

const draftKey = (ref: string) => `supermixer.sql-draft.${ref}`

function SqlEditorPage() {
  const { ref, id } = Route.useParams()
  const snippet = useQuery({ ...snippetQuery(ref, id), enabled: id !== 'new' })
  const catalog = usePg<{ catalog: SchemaCatalog }>(ref, ['catalog'], CATALOG_SQL)
  useEffect(() => {
    setCatalog(catalog.data?.[0]?.catalog ?? null)
  }, [catalog.data])

  if (id === 'new') return <SqlWorkspace key="new" projectRef={ref} />
  if (snippet.isPending) {
    return (
      <div className="p-6">
        <Skeleton className="h-40" />
      </div>
    )
  }
  if (!snippet.data) {
    return <p className="p-6 text-sm text-foreground-lighter">{snippet.error?.message ?? 'Query not found'}</p>
  }
  return <SqlWorkspace key={snippet.data.id} projectRef={ref} snippet={snippet.data} />
}

function SqlWorkspace({ projectRef, snippet }: { projectRef: string; snippet?: Schemas['Snippet'] }) {
  const project = useSelectedProject()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const editor = useRef<CodeEditorHandle | null>(null)
  const readFromStorage = () => {
    try {
      return localStorage.getItem(draftKey(projectRef)) ?? ''
    } catch {
      return ''
    }
  }
  const [content, setContent] = useState(() => snippet?.content ?? readFromStorage())
  const [name, setName] = useState(snippet?.name ?? 'Untitled query')
  const [saved, setSaved] = useState({ content: snippet?.content ?? '', name: snippet?.name ?? '' })
  const [lastRun, setLastRun] = useState<Runnable | null>(null)
  const canWrite = can(project, 'project:data:write')
  const editable = !snippet || snippet.can_edit

  const run = useMutation<QueryResponse, Error, Runnable>({
    mutationFn: (r) => runSql(projectRef, r.sql),
    onMutate: (r) => setLastRun(r),
    onSuccess: () => {
      // DDL may have changed the schema; refresh autocomplete and catalog pages.
      void queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg'] })
    },
  })

  const refreshList = () => queryClient.invalidateQueries({ queryKey: snippetsQuery(projectRef).queryKey })
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/projects/{ref}/snippets', { params: { path: { ref: projectRef } }, body: { name, content } })),
    onSuccess: async (s) => {
      try {
        localStorage.removeItem(draftKey(projectRef))
      } catch {
        // storage unavailable
      }
      queryClient.setQueryData(snippetQuery(projectRef, s.id).queryKey, s)
      await refreshList()
      void navigate({ to: '/project/$ref/sql/$id', params: { ref: projectRef, id: s.id }, replace: true })
    },
    onError: (e) => toast.error(e.message),
  })
  const save = useMutation({
    mutationFn: (body: Schemas['SnippetUpdate']) =>
      unwrap(api.PATCH('/projects/{ref}/snippets/{snippet_id}', { params: { path: { ref: projectRef, snippet_id: snippet!.id } }, body })),
    onSuccess: (s) => {
      setSaved({ content: s.content ?? '', name: s.name })
      queryClient.setQueryData(snippetQuery(projectRef, s.id).queryKey, s)
      void refreshList()
    },
    onError: (e) => toast.error(`Could not save: ${e.message}`),
  })

  // Saved queries autosave like Studio's; a new one keeps a local draft.
  useEffect(() => {
    if (!snippet) {
      try {
        localStorage.setItem(draftKey(projectRef), content)
      } catch {
        // storage unavailable
      }
      return
    }
    if (!editable || (content === saved.content && name === saved.name) || !name.trim()) return
    const t = setTimeout(() => save.mutate({ content, name: name.trim() }), 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save is stable enough; re-running on it would loop
  }, [content, name, snippet, editable, saved])

  const dirty = snippet ? content !== saved.content || name !== saved.name : content.trim() !== ''
  const sqlError = run.error instanceof SqlError ? run.error : null
  const errorAt =
    sqlError?.position && lastRun ? { offset: sqlError.position, base: lastRun.base, message: sqlError.message } : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b px-3">
        <input
          aria-label="Query name"
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-sm text-foreground outline-none hover:bg-surface-200 focus:bg-surface-200 disabled:hover:bg-transparent"
          value={name}
          disabled={!editable}
          onChange={(e) => setName(e.target.value)}
        />
        {snippet && !editable && <Badge>Shared by {snippet.owner_username}</Badge>}
        {snippet && editable && (
          <span className="text-xs text-foreground-lighter">{save.isPending ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
        )}
        {!canWrite && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Badge variant="warning">Read-only</Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent>Your role can run one read-only statement at a time.</TooltipContent>
          </Tooltip>
        )}
        {snippet && editable && (
          <Button
            variant="text"
            size="tiny"
            icon={snippet.visibility === 'project' ? <PublicIcon /> : <LockIcon />}
            onClick={() => save.mutate({ visibility: snippet.visibility === 'project' ? 'private' : 'project' })}
          >
            {snippet.visibility === 'project' ? 'Shared' : 'Private'}
          </Button>
        )}
        {!snippet && (
          <Button variant="default" size="tiny" icon={<SaveIcon />} loading={create.isPending} disabled={!content.trim()} onClick={() => create.mutate()}>
            Save
          </Button>
        )}
        <Button
          variant="primary"
          size="tiny"
          icon={<PlayIcon />}
          loading={run.isPending}
          disabled={!content.trim()}
          onClick={() => editor.current && run.mutate(editor.current.runnable())}
        >
          Run <span className="ml-1 text-[11px] opacity-70">⌘↵</span>
        </Button>
      </div>
      <SplitPane
        top={
          <div className="relative h-full">
            <CodeEditor
              value={content}
              onChange={setContent}
              onRun={(r) => r.sql.trim() && run.mutate(r)}
              errorAt={errorAt}
              readOnly={!editable}
              handleRef={editor}
              autoFocus
            />
            {!snippet && !content.trim() && <Templates onPick={setContent} />}
          </div>
        }
        bottom={<ResultsPanel key={run.submittedAt} response={run.data} error={run.error} running={run.isPending} />}
      />
    </div>
  )
}

function Templates({ onPick }: { onPick: (sql: string) => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-6">
      <div className="pointer-events-auto w-full max-w-2xl rounded-lg border bg-surface-100 p-3 shadow-sm">
        <p className="mb-2 px-1 text-xs text-foreground-lighter">Start from a template</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {SQL_TEMPLATES.map((t) => (
            <button
              key={t.title}
              onClick={() => onPick(t.sql)}
              className="rounded-md px-2 py-1.5 text-left hover:bg-surface-200 focus-visible:bg-surface-200 focus-visible:outline-none"
            >
              <span className="block text-sm text-foreground">{t.title}</span>
              <span className="block text-xs text-foreground-lighter">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Editor above, results below, with a draggable divider. */
function SplitPane({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  const [ratio, setRatio] = useState(0.55)
  const container = useRef<HTMLDivElement>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    const el = container.current
    if (!el) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => setRatio(Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div ref={container} className="flex min-h-0 flex-1 flex-col">
      <div style={{ flexBasis: `${ratio * 100}%` }} className="min-h-0 shrink-0 grow-0">
        {top}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize results"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setRatio((r) => Math.max(0.15, r - 0.05))
          if (e.key === 'ArrowDown') setRatio((r) => Math.min(0.85, r + 0.05))
        }}
        className="h-1.5 shrink-0 cursor-row-resize border-y bg-surface-100 hover:bg-surface-300 focus-visible:bg-brand-500 focus-visible:outline-none"
      />
      <div className="min-h-0 flex-1 bg-dash-sidebar">{bottom}</div>
    </div>
  )
}
