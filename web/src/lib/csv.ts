/** A CSV cell: quoted when it holds a comma, quote or line break. */
function cell(v: unknown, guard: boolean): string {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  // Text a spreadsheet would run as a formula (=, +, -, @, or a tab or
  // return first) is kept as text; numbers aren't touched.
  if (guard && typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * A CSV file's text, header first. With `guard`, for reports that will be
 * opened in a spreadsheet, names people chose can't become formulas.
 */
export function toCsv(header: string[], rows: unknown[][], { guard = false } = {}): string {
  return [header, ...rows].map((r) => r.map((v) => cell(v, guard)).join(',')).join('\n')
}

/** Saves text as a file in the browser's downloads. */
export function downloadText(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
