/*
 * A flag for each of the app's languages, drawn here rather than with emoji
 * flags, which Windows shows as two letters. English uses the United
 * Kingdom's flag. Spain's is shown without its coat of arms, as at this size
 * it would be a smudge.
 */
import { useId, type ReactNode } from 'react'

import type { Language } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * The flag for lng, 4:3, with a hairline edge so white flags show. One svg,
 * none nested, so a parent's [&_svg] sizes it as a whole.
 */
export function LanguageFlag({ lng, className }: { lng: Language; className?: string }) {
  return (
    <svg viewBox="0 0 40 30" aria-hidden className={cn('h-3 w-4 shrink-0 rounded-[2px]', className)}>
      {lng === 'en' ? <UnitedKingdom /> : FLAGS[lng]}
      <rect
        x="0.5"
        y="0.5"
        width="39"
        height="29"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

const FLAGS: Record<Exclude<Language, 'en'>, ReactNode> = {
  ja: (
    <>
      <rect width="40" height="30" fill="#fff" />
      <circle cx="20" cy="15" r="9" fill="#bc002d" />
    </>
  ),
  fr: (
    <>
      <rect width="40" height="30" fill="#fff" />
      <rect width="13.34" height="30" fill="#0055a4" />
      <rect x="26.66" width="13.34" height="30" fill="#ef4135" />
    </>
  ),
  es: (
    <>
      <rect width="40" height="30" fill="#aa151b" />
      <rect y="7.5" width="40" height="15" fill="#f1bf00" />
    </>
  ),
  de: (
    <>
      <rect width="40" height="10" fill="#000" />
      <rect y="10" width="40" height="10" fill="#dd0000" />
      <rect y="20" width="40" height="10" fill="#ffce00" />
    </>
  ),
}

/** The Union Flag (2:1), cut to 4:3 around its centre. */
function UnitedKingdom() {
  // The red diagonals sit off-centre, so they're clipped to alternate halves.
  const id = `uk${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <g transform="translate(-10 0)">
      <clipPath id={id}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
      </clipPath>
      <rect width="60" height="30" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" clipPath={`url(#${id})`} stroke="#c8102e" strokeWidth="4" />
      <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#c8102e" strokeWidth="6" />
    </g>
  )
}
