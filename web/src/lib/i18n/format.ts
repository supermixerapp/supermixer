/*
 * Dates, numbers and lists in the app's language. Use these, or pass
 * language() to Intl and toLocale…(), never the browser's default: that's
 * the browser's language, not the one chosen in the app.
 */
import { language } from '.'

const date = (v: string | number | Date) => (v instanceof Date ? v : new Date(v))

/** "28 Nov 2026" as the language writes it. */
export function formatDate(v: string | number | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) {
  return date(v).toLocaleDateString(language(), opts)
}

/** Date and time, as the language writes them. */
export function formatDateTime(v: string | number | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
  return date(v).toLocaleString(language(), opts)
}

/** A time of day. */
export function formatTime(v: string | number | Date, opts: Intl.DateTimeFormatOptions = { timeStyle: 'short' }) {
  return date(v).toLocaleTimeString(language(), opts)
}

/** 1,234.5 / 1 234,5 / 1.234,5 … */
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions) {
  return n.toLocaleString(language(), opts)
}

/** "a, b and c" in the language. */
export function formatList(items: string[], type: Intl.ListFormatType = 'conjunction') {
  return new Intl.ListFormat(language(), { style: 'long', type }).format(items)
}

/** Compares strings as the language sorts them. */
export function compare(a: string, b: string) {
  return a.localeCompare(b, language())
}
