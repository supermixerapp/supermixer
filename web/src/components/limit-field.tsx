/*
 * A resource limit: a switch between "Unlimited" and a number, as on
 * Instance › Resource Limits and an organization's General settings.
 */
import { useState, type ReactNode } from 'react'

import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

/** "1 project", "3 projects". */
export const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The largest limit the server accepts. */
export const MAX_LIMIT = 100000

/** An edited limit: on or off, and the number as typed. */
export function useLimitDraft(saved: number | null | undefined, max = MAX_LIMIT) {
  const [on, setOn] = useState(saved != null)
  const [text, setText] = useState(saved != null ? String(saved) : '')
  const n = Number(text)
  const valid = !on || (text.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= max)
  const value = on ? n : null
  const dirty = on !== (saved != null) || (on && n !== saved)
  const reset = () => {
    setOn(saved != null)
    setText(saved != null ? String(saved) : '')
  }
  return { on, setOn, text, setText, value, valid, dirty, reset, max }
}

export type LimitDraft = ReturnType<typeof useLimitDraft>

export function LimitField({
  id,
  label,
  description,
  unit,
  draft,
  disabled,
  suggested,
  notice,
}: {
  id: string
  label: string
  description: ReactNode
  /** What's counted, plural ("projects"). */
  unit: string
  draft: LimitDraft
  disabled?: boolean
  /** The number to start from when the limit is turned on. */
  suggested: number
  /** Shown under the field: a warning about what the limit means now. */
  notice?: ReactNode
}) {
  const error = !draft.valid
    ? `Enter a whole number from 1 to ${draft.max.toLocaleString()}`
    : undefined
  return (
    <FormField
      label={label}
      htmlFor={id}
      layout="horizontal"
      description={error ? undefined : description}
      error={error}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <Switch
          aria-label={`Limit ${label.toLowerCase()}`}
          checked={draft.on}
          disabled={disabled}
          onCheckedChange={(on) => {
            draft.setOn(on)
            if (on && draft.text === '') draft.setText(String(suggested))
          }}
        />
        {draft.on ? (
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={draft.max}
              step={1}
              className="w-28"
              aria-invalid={!draft.valid || undefined}
              disabled={disabled}
              value={draft.text}
              onChange={(e) => draft.setText(e.target.value)}
            />
            <span className="text-sm text-foreground-light">{unit}</span>
          </div>
        ) : (
          <span id={id} className="text-sm text-foreground-light">
            Unlimited
          </span>
        )}
      </div>
      {notice}
    </FormField>
  )
}
