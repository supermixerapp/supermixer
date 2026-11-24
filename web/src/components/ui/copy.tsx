import { useState, type ReactNode } from 'react'

import { CheckIcon, CopyIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

import { Button } from './button'
import { toast } from './toaster'

export async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    toast.error('Could not copy to the clipboard')
    return false
  }
}

export function CopyButton({
  value,
  label = 'Copy',
  className,
  iconOnly = false,
}: {
  value: string
  label?: string
  className?: string
  /** Just the icon, with label for screen readers and as a tooltip. */
  iconOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant={iconOnly ? 'text' : 'default'}
      size={iconOnly ? 'tiny' : undefined}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? (copied ? 'Copied' : label) : undefined}
      className={className}
      icon={copied ? <CheckIcon /> : <CopyIcon />}
      onClick={async () => {
        if (await writeClipboard(value)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
      }}
    >
      {iconOnly ? null : copied ? 'Copied' : label}
    </Button>
  )
}

/** Read-only monospace value with a copy button (Studio's API settings rows). */
export function CopyField({
  value,
  masked,
  className,
  actions,
}: {
  value: string
  masked?: boolean
  className?: string
  actions?: ReactNode
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <code
        className={cn(
          'flex h-[34px] min-w-0 flex-1 items-center truncate rounded-md border border-control bg-field px-3 font-mono text-xs',
          masked ? 'text-foreground-lighter' : 'text-foreground'
        )}
      >
        {masked ? '•'.repeat(40) : value}
      </code>
      {actions}
      {!masked && <CopyButton value={value} />}
    </div>
  )
}
