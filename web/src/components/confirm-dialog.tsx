import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'

/**
 * Confirmation for destructive actions. With confirmText, the user must type
 * it (e.g. the project name) to enable the button, like Studio.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmText,
  variant = 'danger',
  loading,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  confirmText?: string
  variant?: 'danger' | 'primary' | 'warning'
  loading?: boolean
  onConfirm: () => void
  children?: ReactNode
}) {
  const [typed, setTyped] = useState('')
  const ready = !confirmText || typed === confirmText
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('')
        onOpenChange(o)
      }}
    >
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {(children || confirmText) && (
          <DialogSection className="flex flex-col gap-4 border-t">
            {children}
            {confirmText && (
              <FormField
                label={
                  <>
                    Type <span className="font-mono text-foreground">{confirmText}</span> to confirm
                  </>
                }
                htmlFor="confirm-text"
              >
                <Input id="confirm-text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </FormField>
            )}
          </DialogSection>
        )}
        <DialogFooter>
          <Button variant="default" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={variant}
            disabled={!ready}
            loading={loading}
            onClick={() => {
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
