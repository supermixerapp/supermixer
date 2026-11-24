/** Units for entering a size in bytes, largest first. */
export const BYTE_UNITS = [
  { value: 'GB', bytes: 1 << 30 },
  { value: 'MB', bytes: 1 << 20 },
  { value: 'KB', bytes: 1 << 10 },
  { value: 'bytes', bytes: 1 },
] as const
export type ByteUnit = (typeof BYTE_UNITS)[number]['value']

/** A byte count, exactly, in the largest unit that keeps it whole. */
export function splitBytes(bytes: number): { amount: string; unit: ByteUnit } {
  const u = BYTE_UNITS.find((u) => bytes % u.bytes === 0)!
  return { amount: String(bytes / u.bytes), unit: u.value }
}

/** An amount typed in a unit, as bytes; NaN if it isn't a number. */
export function joinBytes(amount: string, unit: ByteUnit): number {
  if (amount.trim() === '') return NaN
  return Math.round(Number(amount) * BYTE_UNITS.find((u) => u.value === unit)!.bytes)
}
