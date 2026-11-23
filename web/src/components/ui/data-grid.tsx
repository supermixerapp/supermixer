import { DataGrid, type DataGridProps } from 'react-data-grid'

import { cn } from '@/lib/utils'

import './data-grid.css'

/** react-data-grid with Supermixer's look. */
export function Grid<R, SR = unknown, K extends React.Key = React.Key>({ className, ...props }: DataGridProps<R, SR, K>) {
  return <DataGrid<R, SR, K> rowHeight={30} headerRowHeight={32} {...props} className={cn('sm-grid', className)} />
}

/** How a database value reads in a grid cell. */
export function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-foreground-muted">NULL</span>
  if (typeof value === 'boolean') return <span>{value ? 'true' : 'false'}</span>
  if (typeof value === 'object') return <span className="text-foreground-light">{JSON.stringify(value)}</span>
  if (value === '') return <span className="text-foreground-muted">EMPTY</span>
  return <span>{String(value)}</span>
}
