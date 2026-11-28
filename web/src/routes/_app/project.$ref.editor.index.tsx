import { createFileRoute } from '@tanstack/react-router'

import { TableEditorIcon } from '@/components/icons'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/editor/')({
  component: () => (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <TableEditorIcon size={28} className="text-foreground-lighter" />
      <p className="text-sm text-foreground">{t('database:editor.selectATableToViewAnd')}</p>
      <p className="text-xs text-foreground-lighter">{t('database:editor.orCreateOneWithNewTable')}</p>
    </div>
  ),
})
