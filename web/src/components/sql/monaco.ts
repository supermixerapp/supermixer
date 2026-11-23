/*
 * Monaco, bundled locally (no CDN): the core editor, its standard features,
 * the PostgreSQL grammar, and one web worker. Themes are built from the
 * page's design tokens so the editor follows light/dark and the brand colour.
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/pgsql/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

export { monaco }

/**
 * Resolve a design token to #rrggbb. Tokens use relative colour syntax and
 * some are translucent, so the browser resolves the value on an element and
 * a canvas composites it over `over` (the editor background).
 */
function tokenHex(name: string, fallback: string, over = '#000000'): string {
  const probe = document.createElement('div')
  probe.style.backgroundColor = `var(${name})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).backgroundColor
  probe.remove()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !resolved || resolved === 'rgba(0, 0, 0, 0)') return fallback
  ctx.fillStyle = over
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = resolved
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/** (Re)define the "supermixer" theme for the current light/dark mode. */
export function applyEditorTheme(mode: 'light' | 'dark') {
  const dark = mode === 'dark'
  const bg = tokenHex('--background-dash-sidebar', dark ? '#1c1c1c' : '#fcfcfc')
  const t = (name: string, fallback: string) => tokenHex(name, fallback, bg)
  const c = (name: string, fallback: string) => t(name, fallback).slice(1)
  const fg = c('--foreground-default', dark ? '#fafafa' : '#171717')
  const muted = c('--foreground-lighter', dark ? '#898989' : '#707070')
  const brand = c('--brand-600', dark ? '#b0caff' : '#4666ab')
  monaco.editor.defineTheme('supermixer', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: fg },
      { token: 'keyword', foreground: dark ? 'bda4ff' : '6b35dc' },
      { token: 'operator', foreground: dark ? 'ffffff' : '404040' },
      { token: 'string', foreground: dark ? 'ffcda1' : 'a14e00' },
      { token: 'number', foreground: dark ? '9ce2c4' : '0f7b51' },
      { token: 'comment', foreground: muted, fontStyle: 'italic' },
      { token: 'predefined', foreground: brand },
      { token: 'identifier.quote', foreground: fg },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': `#${fg}`,
      'editorLineNumber.foreground': `#${muted}`,
      'editorLineNumber.activeForeground': `#${fg}`,
      'editor.lineHighlightBackground': t('--background-surface-200', dark ? '#232323' : '#f1f1f1'),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': t('--background-selection', dark ? '#2f3a8f' : '#c9d0ff'),
      'editorCursor.foreground': `#${brand}`,
      'editorWidget.background': t('--background-overlay-default', dark ? '#232323' : '#ffffff'),
      'editorWidget.border': t('--border-overlay', dark ? '#363636' : '#dfdfdf'),
      'editorSuggestWidget.selectedBackground': t('--background-surface-300', dark ? '#2e2e2e' : '#e6e6e6'),
      'scrollbarSlider.background': '#80808033',
    },
  })
  monaco.editor.setTheme('supermixer')
}

// ------------------------------------------------------------ autocomplete

export interface SchemaCatalog {
  schemas: string[]
  tables: { schema: string; name: string; kind: string }[]
  columns: { schema: string; table: string; name: string; type: string }[]
  functions: { schema: string; name: string; args: string }[]
}

const KEYWORDS = `select from where and or not insert into values update set delete returning create table view
materialized index unique primary key foreign references alter add drop column constraint default null
join left right inner outer full cross on using group by order asc desc limit offset having distinct as
case when then else end in exists between like ilike is true false union all intersect except with recursive
begin commit rollback grant revoke to function returns language plpgsql trigger before after each row
execute procedure policy enable row level security schema extension sequence type enum cascade restrict
if replace security definer invoker coalesce count sum avg min max now jsonb json text integer bigint uuid
boolean timestamptz timestamp date numeric serial bigserial varchar`.split(/\s+/)

let catalog: SchemaCatalog | null = null
let registered = false

/** Give the completion provider the current project's schema. */
export function setCatalog(next: SchemaCatalog | null) {
  catalog = next
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('pgsql', {
    triggerCharacters: ['.', ' ', '"'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn))
      const K = monaco.languages.CompletionItemKind
      const qualifier = /"?([A-Za-z_][\w$]*)"?\.$/.exec(before)?.[1]
      const cat = catalog
      if (!cat) return { suggestions: [] }

      if (qualifier) {
        // schema.<table|function> or table.<column>
        const inSchema = cat.tables.filter((t) => t.schema === qualifier)
        if (inSchema.length || cat.schemas.includes(qualifier)) {
          return {
            suggestions: [
              ...inSchema.map((t) => ({ label: t.name, kind: t.kind === 'v' ? K.Interface : K.Struct, detail: t.kind === 'v' ? 'view' : 'table', insertText: t.name, range })),
              ...cat.functions
                .filter((f) => f.schema === qualifier)
                .map((f) => ({ label: f.name, kind: K.Function, detail: `(${f.args})`, insertText: f.name, range })),
            ],
          }
        }
        return {
          suggestions: cat.columns
            .filter((c) => c.table === qualifier)
            .map((c) => ({ label: c.name, kind: K.Field, detail: c.type, insertText: c.name, range })),
        }
      }

      // Columns of tables mentioned in the query come first.
      const text = model.getValue()
      const words = new Set(text.match(/[\p{L}\p{N}_$]+/gu) ?? [])
      const mentioned = new Set(
        cat.tables.filter((t) => words.has(t.name) || text.includes(`"${t.name}"`)).map((t) => `${t.schema}.${t.name}`)
      )
      return {
        suggestions: [
          ...cat.columns
            .filter((c) => mentioned.has(`${c.schema}.${c.table}`))
            .map((c) => ({ label: c.name, kind: K.Field, detail: `${c.table}.${c.name} ${c.type}`, insertText: c.name, range, sortText: `0${c.name}` })),
          ...cat.tables.map((t) => ({
            label: t.schema === 'public' ? t.name : `${t.schema}.${t.name}`,
            kind: t.kind === 'v' ? K.Interface : K.Struct,
            detail: t.kind === 'v' ? 'view' : 'table',
            insertText: t.schema === 'public' ? t.name : `${t.schema}.${t.name}`,
            range,
            sortText: `${t.schema === 'public' ? 1 : 2}${t.name}`,
          })),
          ...cat.schemas.map((s) => ({ label: s, kind: K.Module, detail: 'schema', insertText: s, range, sortText: `3${s}` })),
          ...KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: `4${k}` })),
        ],
      }
    },
  })
}

/** Catalog query for autocomplete (user schemas only). */
export const CATALOG_SQL = `
with s as (
  select nspname from pg_namespace
  where nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%'
)
select json_build_object(
  'schemas', (select coalesce(json_agg(nspname order by nspname), '[]') from s),
  'tables', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind)), '[]')
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname in (select nspname from s) and c.relkind in ('r', 'p', 'v', 'm', 'f')),
  'columns', (select coalesce(json_agg(json_build_object('schema', table_schema, 'table', table_name, 'name', column_name, 'type', data_type)), '[]')
              from information_schema.columns where table_schema in (select nspname from s)),
  'functions', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid))), '[]')
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'auth', 'storage', 'extensions'))
) as catalog`
