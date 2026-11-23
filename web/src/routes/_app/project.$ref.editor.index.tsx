import { createFileRoute } from '@tanstack/react-router'

import { TableEditorIcon } from '@/components/icons'

export const Route = createFileRoute('/_app/project/$ref/editor/')({
  component: () => (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <TableEditorIcon size={28} className="text-foreground-lighter" />
      <p className="text-sm text-foreground">Select a table to view and edit its rows</p>
      <p className="text-xs text-foreground-lighter">Or create one with New table.</p>
    </div>
  ),
})
