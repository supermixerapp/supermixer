import { CopyButton } from '@/components/ui/copy'
import { cn } from '@/lib/utils'

/** A copyable snippet of code. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <pre className="overflow-x-auto rounded-md border bg-surface-100 p-4 pr-20 font-mono text-xs leading-5 text-foreground">{code}</pre>
      <CopyButton value={code} className="absolute top-2 right-2" />
    </div>
  )
}
