import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { DatabasePage, SearchBox, useCanChange, useDdl } from '@/components/database/catalog-page'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { SCHEMAS_SQL, type SchemaRow } from '@/lib/pg/catalog'
import { disableExtension, enableExtension, EXTENSIONS_SQL, type ExtensionRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/database/extensions')({
  component: ExtensionsPage,
})

function ExtensionsPage() {
  const { ref } = Route.useParams()
  const [search, setSearch] = useState('')
  const [enabling, setEnabling] = useState<ExtensionRow | null>(null)
  const [disabling, setDisabling] = useState<ExtensionRow | null>(null)
  const [schema, setSchema] = useState('extensions')
  const extensions = usePg<ExtensionRow>(ref, ['extensions'], EXTENSIONS_SQL)
  const schemas = usePg<SchemaRow>(ref, ['schemas'], SCHEMAS_SQL)
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const q = search.toLowerCase()
  const rows = (extensions.data ?? [])
    .filter((e) => e.name.includes(q) || (e.comment ?? '').toLowerCase().includes(q))
    .sort((a, b) => Number(!!b.installed_version) - Number(!!a.installed_version) || a.name.localeCompare(b.name))

  return (
    <DatabasePage
      title="Extensions"
      description="Postgres extensions available on this stack. Enabled ones are listed first."
      toolbar={<SearchBox value={search} onChange={setSearch} placeholder="Search for an extension" />}
    >
      {extensions.error ? (
        <Alert variant="destructive" title={extensions.error.message} />
      ) : extensions.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((e) => (
            <Card key={e.name} className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-sm text-foreground">{e.name}</span>
                <Switch
                  aria-label={`${e.installed_version ? 'Disable' : 'Enable'} ${e.name}`}
                  checked={!!e.installed_version}
                  disabled={!canChange || ddl.isPending}
                  onCheckedChange={(on) => (on ? setEnabling(e) : setDisabling(e))}
                />
              </div>
              <p className="line-clamp-2 text-xs text-foreground-light">{e.comment}</p>
              <p className="mt-auto text-[11px] text-foreground-lighter">
                {e.installed_version ? `v${e.installed_version} in ${e.schema}` : `v${e.default_version} available`}
              </p>
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!enabling}
        onOpenChange={(o) => !o && setEnabling(null)}
        variant="warning"
        title={`Enable ${enabling?.name}?`}
        description={
          enabling?.required_schema ? (
            <span>
              It installs into the <code className="font-mono">{enabling.required_schema}</code> schema, which it requires.
            </span>
          ) : (
          <span className="flex flex-col gap-3">
            <span>Choose the schema its objects go in. Supabase keeps extensions in &quot;extensions&quot;.</span>
            <Select value={schema} onValueChange={setSchema}>
              <SelectTrigger aria-label="Schema">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(schemas.data ?? [{ name: 'extensions' }]).map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
          )
        }
        confirmLabel="Enable extension"
        loading={ddl.isPending}
        onConfirm={() =>
          enabling &&
          ddl.mutate(
            // A schema fixed by the control file must not be overridden.
            { sql: enableExtension(enabling.name, enabling.required_schema ? null : schema), done: `Enabled ${enabling.name}` },
            { onSettled: () => setEnabling(null) }
          )
        }
      />
      <ConfirmDialog
        open={!!disabling}
        onOpenChange={(o) => !o && setDisabling(null)}
        title={`Disable ${disabling?.name}?`}
        description="Its functions and types are dropped. Objects that depend on them make this fail."
        confirmLabel="Disable extension"
        loading={ddl.isPending}
        onConfirm={() =>
          disabling && ddl.mutate({ sql: disableExtension(disabling.name), done: `Disabled ${disabling.name}` }, { onSettled: () => setDisabling(null) })
        }
      />
    </DatabasePage>
  )
}
