import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { AddIcon, LockIcon, MoreIcon, PublicIcon, SearchIcon, SnippetIcon, StarIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { snippetsQuery } from '@/lib/api/queries'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/sql')({
  component: SqlLayout,
})

type Snippet = Schemas['Snippet']

function SqlLayout() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const snippets = useQuery({ ...snippetsQuery(ref), enabled: can(project, 'project:data:read') })
  const [search, setSearch] = useState('')
  const visible = (snippets.data ?? []).filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
  const sections: [string, Snippet[]][] = [
    [t('database:sql.favorites'), visible.filter((s) => s.favorite)],
    [t('database:sql.shared'), visible.filter((s) => s.visibility === 'project' && !s.favorite)],
    [t('database:sql.private'), visible.filter((s) => s.visibility === 'private' && !s.favorite)],
  ]

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label={t('database:sql.sqlSnippets')} className="hidden w-(--product-menu-width) shrink-0 flex-col border-r bg-dash-sidebar md:flex">
        <div className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b px-4">
          <h4 className="min-w-0 flex-1 truncate font-sans text-sm font-normal">{t('database:sql.sqlEditor')}</h4>
          <Button asChild variant="default" size="tiny" icon={<AddIcon />} aria-label={t('database:sql.newQuery')}>
            <Link to="/project/$ref/sql/$id" params={{ ref, id: 'new' }} />
          </Button>
        </div>
        <div className="border-b p-3">
          <div className="relative">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter" />
            <Input size="tiny" className="pl-7" placeholder={t('database:sql.searchQueries')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="grow overflow-y-auto py-2">
          {snippets.isPending ? (
            <div className="flex flex-col gap-2 px-4">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          ) : (
            sections.map(([title, items]) => (
              <div key={title} className="py-2">
                <p className="px-4 pb-1 text-xs text-foreground-lighter">
                  {title} <span className="text-foreground-muted">{items.length}</span>
                </p>
                <ul className="px-2">
                  {items.map((s) => (
                    <SnippetItem key={s.id} projectRef={ref} snippet={s} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  )
}

function SnippetItem({ projectRef, snippet }: { projectRef: string; snippet: Snippet }) {
  const { id } = useParams({ strict: false })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const project = useSelectedProject()
  const [deleting, setDeleting] = useState(false)
  const active = id === snippet.id
  const refresh = () => queryClient.invalidateQueries({ queryKey: snippetsQuery(projectRef).queryKey })

  const update = useMutation({
    mutationFn: (body: Schemas['SnippetUpdate']) =>
      unwrap(api.PATCH('/projects/{ref}/snippets/{snippet_id}', { params: { path: { ref: projectRef, snippet_id: snippet.id } }, body })),
    onSuccess: (s) => {
      queryClient.setQueryData(['projects', projectRef, 'snippets', s.id], s)
      void refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/projects/{ref}/snippets/{snippet_id}', { params: { path: { ref: projectRef, snippet_id: snippet.id } } })),
    onSuccess: async () => {
      setDeleting(false)
      await refresh()
      if (active) void navigate({ to: '/project/$ref/sql/$id', params: { ref: projectRef, id: 'new' } })
    },
    onError: (e) => toast.error(e.message),
  })

  const canDelete = snippet.can_edit || can(project, 'project:update')
  return (
    <li className="group relative">
      <Link
        to="/project/$ref/sql/$id"
        params={{ ref: projectRef, id: snippet.id }}
        className={cn(
          'flex items-center gap-2 rounded-md py-1 pr-8 pl-2 text-sm',
          active ? 'bg-sidebar-accent text-foreground' : 'text-foreground-light hover:bg-sidebar-accent/50 hover:text-foreground'
        )}
      >
        <SnippetIcon size={14} className="shrink-0 text-foreground-lighter" />
        <span className="truncate">{snippet.name}</span>
        {snippet.visibility === 'project' && !snippet.can_edit && (
          <span className="ml-auto shrink-0 text-[11px] text-foreground-muted">{snippet.owner_username}</span>
        )}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={t('database:sql.actionsFor', { name: snippet.name })}
            className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-foreground-lighter opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreIcon size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem onSelect={() => update.mutate({ favorite: !snippet.favorite })}>
            <StarIcon size={14} className="text-foreground-lighter" />
            {snippet.favorite ? t('database:sql.removeFromFavorites') : t('database:sql.addToFavorites')}
          </DropdownMenuItem>
          {snippet.can_edit && (
            <>
              <DropdownMenuItem onSelect={() => update.mutate({ visibility: snippet.visibility === 'project' ? 'private' : 'project' })}>
                {snippet.visibility === 'project' ? (
                  <LockIcon size={14} className="text-foreground-lighter" />
                ) : (
                  <PublicIcon size={14} className="text-foreground-lighter" />
                )}
                {snippet.visibility === 'project' ? t('database:sql.makePrivate') : t('database:sql.shareWithProject')}
              </DropdownMenuItem>
            </>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDeleting(true)}>{t('database:sql.deleteQuery')}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('database:sql.delete', { name: snippet.name })}
        description={snippet.visibility === 'project' ? t('database:sql.itIsSharedSoItDisappears') : t('database:sql.thisCannotBeUndone')}
        confirmLabel={t('database:sql.deleteQuery')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </li>
  )
}
