import type { ReactNode } from 'react'

/** A titled block of settings, as on Studio's settings pages. */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="heading-subSection">{title}</h3>
        {description && <p className="text-sm text-foreground-light">{description}</p>}
      </div>
      {children}
    </section>
  )
}
