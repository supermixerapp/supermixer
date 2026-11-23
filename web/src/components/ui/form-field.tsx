import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { Label } from './label'

/**
 * A labelled control, like Studio's FormItemLayout. "horizontal" puts the
 * label in a left column (settings pages); "vertical" stacks it (dialogs).
 */
export function FormField({
  label,
  htmlFor,
  description,
  error,
  layout = 'vertical',
  className,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  description?: ReactNode
  error?: string
  layout?: 'vertical' | 'horizontal'
  className?: string
  children: ReactNode
}) {
  const help = (error || description) && (
    <p className={cn('text-xs', error ? 'text-destructive' : 'text-foreground-lighter')}>{error ?? description}</p>
  )
  if (layout === 'horizontal') {
    return (
      <div className={cn('grid gap-2 md:grid-cols-12 md:gap-x-6', className)}>
        <Label htmlFor={htmlFor} className="pt-2 md:col-span-4">
          {label}
        </Label>
        <div className="flex flex-col gap-1.5 md:col-span-8">
          {children}
          {help}
        </div>
      </div>
    )
  }
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help}
    </div>
  )
}
