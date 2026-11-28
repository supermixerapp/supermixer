/*
 * What Instance › Overview, Organizations and Projects share: figures at a
 * glance, and the filters and export above a report's table.
 */
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { SearchBox } from '@/components/database/catalog-page'
import { DownloadIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { downloadText, toCsv } from '@/lib/csv'
import { t } from '@/lib/i18n'

/** A figure at a glance; with `to`, it links to the list it counts. */
export function Stat({ label, value, detail, to }: { label: string; value: ReactNode; detail?: string; to?: string }) {
  const body = (
    <>
      <span className="text-xs text-foreground-lighter">{label}</span>
      <span className="text-2xl text-foreground tabular-nums">{value}</span>
      {detail && <span className="text-xs text-foreground-lighter">{detail}</span>}
    </>
  )
  if (!to) return <Card className="flex flex-col gap-1 px-5 py-4">{body}</Card>
  return (
    <Link
      to={to}
      className="focus-ring flex flex-col gap-1 rounded-lg border bg-surface-100 px-5 py-4 transition-colors hover:border-strong hover:bg-surface-200"
    >
      {body}
    </Link>
  )
}

export interface Choice {
  value: string
  label: string
}

/** A select above a report's table, labelled inside its trigger. */
export function FilterSelect({
  label,
  value,
  onChange,
  choices,
  className = 'w-56',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  choices: Choice[]
  className?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="tiny" className={className} aria-label={label}>
        <span className="text-foreground-lighter">{label.toLowerCase()}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The row above a report's table: search, filters, how many rows match, and
 * a CSV of the rows shown.
 */
/**
 * "5 projects", or "3 of 5 projects" while filtering: whole sentences, so
 * each language orders and inflects them its own way.
 */
function count(noun: 'projects' | 'organizations', shown: number | null, total: number) {
  if (noun === 'projects') {
    return shown === null ? t('admin:reportParts.projects', { count: total }) : t('admin:reportParts.projectsOf', { shown, count: total })
  }
  return shown === null ? t('admin:reportParts.organizations', { count: total }) : t('admin:reportParts.organizationsOf', { shown, count: total })
}

export function ReportToolbar({
  search,
  onSearch,
  placeholder,
  filters,
  shown,
  total,
  noun,
  filtering,
  onClear,
  csv,
}: {
  search: string
  onSearch: (v: string) => void
  placeholder: string
  filters: ReactNode
  shown: number
  total: number
  /** What the rows are, for the count beside the filters. */
  noun: 'projects' | 'organizations'
  filtering: boolean
  onClear: () => void
  csv: { name: string; header: string[]; rows: () => unknown[][] }
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchBox value={search} onChange={onSearch} placeholder={placeholder} />
      {filters}
      <span className="text-xs text-foreground-lighter tabular-nums">
        {count(noun, filtering ? shown : null, total)}
      </span>
      {filtering && (
        <Button variant="text" size="tiny" onClick={onClear}>
          {t('admin:reportParts.clearFilters')}
        </Button>
      )}
      <Button
        className="ml-auto"
        variant="default"
        size="tiny"
        icon={<DownloadIcon />}
        disabled={shown === 0}
        // With a byte order mark, so Excel reads it as UTF-8.
        onClick={() =>
          downloadText(csv.name, '\uFEFF' + toCsv(csv.header, csv.rows(), { guard: true }), 'text/csv;charset=utf-8')
        }
      >
        {t('admin:reportParts.exportCsv')}
      </Button>
    </div>
  )
}

/** Today's date, to name an export by. */
export const today = () => new Date().toISOString().slice(0, 10)
