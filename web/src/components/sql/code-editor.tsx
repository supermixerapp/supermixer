import Editor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useImperativeHandle, useRef } from 'react'

import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/lib/theme'

import { applyEditorTheme, monaco } from './monaco'

export interface Runnable {
  sql: string
  /** Offset of sql within the whole script, for error positions. */
  base: number
}

export interface CodeEditorHandle {
  /** The selected text, or the whole script when nothing is selected. */
  runnable(): Runnable
  focus(): void
}

/**
 * Monaco configured like Studio's SQL editor. ⌘/Ctrl+Enter runs the
 * selection (or everything); an error position gets a squiggle.
 */
export function CodeEditor({
  value,
  onChange,
  onRun,
  errorAt,
  readOnly,
  handleRef,
  autoFocus = false,
  language = 'pgsql',
}: {
  value: string
  onChange: (v: string) => void
  onRun?: (r: Runnable) => void
  /** 1-based character offset of a Postgres error in the run text. */
  errorAt?: { offset: number; message: string; base: number } | null
  readOnly?: boolean
  handleRef?: React.Ref<CodeEditorHandle>
  autoFocus?: boolean
  /** 'pgsql' (with schema completion) or 'graphql'. */
  language?: 'pgsql' | 'graphql'
}) {
  const { resolved } = useTheme()
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onRunRef = useRef(onRun)
  useEffect(() => {
    onRunRef.current = onRun
  })

  useEffect(() => applyEditorTheme(resolved), [resolved])

  const runnable = (): Runnable => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model) return { sql: value, base: 0 }
    const sel = ed.getSelection()
    if (sel && !sel.isEmpty()) {
      return { sql: model.getValueInRange(sel), base: model.getOffsetAt(sel.getStartPosition()) }
    }
    return { sql: model.getValue(), base: 0 }
  }

  useImperativeHandle(handleRef, () => ({ runnable, focus: () => editorRef.current?.focus() }))

  // Squiggle under a Postgres error position.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    if (!errorAt) {
      monaco.editor.setModelMarkers(model, 'postgres', [])
      return
    }
    const start = model.getPositionAt(errorAt.base + errorAt.offset - 1)
    const word = model.getWordAtPosition(start)
    monaco.editor.setModelMarkers(model, 'postgres', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: errorAt.message,
        startLineNumber: start.lineNumber,
        startColumn: word?.startColumn ?? start.column,
        endLineNumber: start.lineNumber,
        endColumn: word?.endColumn ?? start.column + 1,
      },
    ])
  }, [errorAt])

  const onMount: OnMount = (ed) => {
    editorRef.current = ed
    applyEditorTheme(resolved)
    ed.addAction({
      id: 'supermixer.run',
      label: 'Run query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunRef.current?.(runnable()),
    })
    if (autoFocus) ed.focus()
  }

  return (
    <Editor
      language={language}
      theme="supermixer"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      loading={<Spinner />}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontFamily: "'Source Code Pro Variable', 'Source Code Pro', monospace",
        fontSize: 13,
        lineHeight: 20,
        padding: { top: 12, bottom: 12 },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        tabSize: 2,
        wordWrap: 'on',
        automaticLayout: true,
        fixedOverflowWidgets: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggest: { showWords: false },
      }}
    />
  )
}
