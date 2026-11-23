import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { useTheme } from '@/lib/theme'

/** Toasts styled like Studio's (sonner with the overlay surface). */
export function Toaster(props: ToasterProps) {
  const { resolved } = useTheme()
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group !bg-overlay !text-foreground !border-0 floating-surface-shadow-md !rounded-md !font-sans !text-sm',
          description: '!text-foreground-light',
          actionButton: '!bg-primary-solid !text-primary-solid-foreground',
          cancelButton: '!bg-muted !text-foreground-light',
        },
      }}
      {...props}
    />
  )
}

export { toast } from 'sonner'
