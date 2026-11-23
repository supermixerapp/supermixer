import Editor from '@monaco-editor/react'
import { useEffect, useRef, useState } from 'react'

import { applyEditorTheme, type monaco } from '@/components/sql/monaco'
import { AddIcon, CloseIcon, FileIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

import { filePathProblem, type FunctionFile } from './api'

function language(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript'
  // Highlighting only, so JSON reads fine as JavaScript.
  if (['js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc'].includes(ext)) return 'javascript'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  return 'plaintext'
}

/**
 * A function's files: a list beside a Monaco editor. Each file gets its own
 * model (by path), so undo history stays with the file.
 */
export function FunctionCodeEditor({
  files,
  onChange,
  readOnly,
  modelPrefix,
}: {
  files: FunctionFile[]
  onChange: (files: FunctionFile[]) => void
  readOnly?: boolean
  /** Keeps models of different functions (and projects) apart. */
  modelPrefix: string
}) {
  const { resolved } = useTheme()
  useEffect(() => applyEditorTheme(resolved), [resolved])
  const [active, setActive] = useState(() => files.find((f) => f.path === 'index.ts')?.path ?? files[0]?.path ?? '')
  const [adding, setAdding] = useState<string | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = files.find((f) => f.path === active) ?? files[0]
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const addProblem = adding === null ? null : (filePathProblem(adding.trim()) ?? (files.some((f) => f.path === adding.trim()) ? 'That file exists' : null))

  const add = () => {
    const path = adding?.trim() ?? ''
    if (addProblem) return
    onChange([...files, { path, content: '' }])
    setActive(path)
    setAdding(null)
    // Straight into the new file, once the editor has switched to it.
    requestAnimationFrame(() => editorRef.current?.focus())
  }
  const remove = (path: string) => {
    const next = files.filter((f) => f.path !== path)
    onChange(next)
    if (active === path) setActive(next[0]?.path ?? '')
  }

  return (
    <div className="grid h-[34rem] grid-cols-[14rem_1fr] overflow-hidden rounded-md border">
      <div className="flex flex-col overflow-y-auto border-r bg-surface-75">
        <ul className="flex flex-col py-1" aria-label="Files">
          {sorted.map((f) => (
            <li key={f.path} className="group flex items-center">
              <button
                type="button"
                onClick={() => setActive(f.path)}
                aria-current={f.path === current?.path}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left font-mono text-xs focus-inset',
                  f.path === current?.path ? 'bg-surface-200 text-foreground' : 'text-foreground-light hover:bg-surface-100'
                )}
                title={f.path}
              >
                <FileIcon className="size-3.5 shrink-0 text-foreground-lighter" />
                <span className="truncate">{f.path}</span>
              </button>
              {!readOnly && files.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${f.path}`}
                  onClick={() => remove(f.path)}
                  className="mr-1 rounded p-1 text-foreground-lighter opacity-0 group-hover:opacity-100 hover:text-foreground focus:opacity-100 focus-ring"
                >
                  <CloseIcon className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {!readOnly &&
          (adding === null ? (
            <Button variant="text" size="tiny" className="mx-2 mb-2 self-start" icon={<AddIcon />} onClick={() => setAdding('')}>
              Add file
            </Button>
          ) : (
            <form
              className="flex flex-col gap-1 px-2 pb-2"
              onSubmit={(e) => {
                e.preventDefault()
                add()
              }}
            >
              <Input
                autoFocus
                aria-label="New file path"
                className="h-7 font-mono text-xs"
                placeholder="lib/db.ts"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
                onBlur={() => !adding.trim() && setAdding(null)}
              />
              {addProblem && adding.trim() && <span className="text-[11px] text-destructive">{addProblem}</span>}
            </form>
          ))}
      </div>
      {current ? (
        <Editor
          path={`${modelPrefix}/${current.path}`}
          language={language(current.path)}
          theme="supermixer"
          value={current.content}
          onChange={(v) => onChange(files.map((f) => (f.path === current.path ? { ...f, content: v ?? '' } : f)))}
          loading={<Spinner />}
          onMount={(ed) => {
            editorRef.current = ed
          }}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontFamily: "'Source Code Pro Variable', 'Source Code Pro', monospace",
            fontSize: 13,
            lineHeight: 20,
            padding: { top: 12, bottom: 12 },
            scrollBeyondLastLine: false,
            tabSize: 2,
            automaticLayout: true,
            fixedOverflowWidgets: true,
          }}
        />
      ) : (
        <div className="flex items-center justify-center text-sm text-foreground-lighter">No files</div>
      )}
    </div>
  )
}
