import { describe, expect, it } from 'vitest'

import { encodePath, formatBytes, fromBytes, joinPath, nameProblem, parseMimeTypes, publicUrl, toBytes } from './storage-api'

describe('storage paths', () => {
  it('escapes each segment but keeps folders', () => {
    expect(encodePath('my docs/a b#1.txt')).toBe('my%20docs/a%20b%231.txt')
    expect(joinPath('', 'a')).toBe('a')
    expect(joinPath('a/b/', 'c')).toBe('a/b/c')
    expect(publicUrl('http://x:8000/', 'avatars', 'u 1/p.png')).toBe('http://x:8000/storage/v1/object/public/avatars/u%201/p.png')
  })

  it('rejects names that would change the path', () => {
    expect(nameProblem('a/b', 'folder')).toMatch(/\//)
    expect(nameProblem('..', 'folder')).toMatch(/reserved/)
    expect(nameProblem('ok name', 'bucket')).toBeNull()
  })
})

describe('sizes', () => {
  it('converts limits the way Storage counts them', () => {
    expect(toBytes(5, 'MB')).toBe(5_000_000)
    expect(fromBytes(5_000_000)).toEqual({ value: 5, unit: 'MB' })
    expect(fromBytes(1500)).toEqual({ value: 1500, unit: 'bytes' })
    expect(formatBytes(5)).toBe('5 B')
    expect(formatBytes(52_428_800)).toBe('52 MB')
  })

  it('reads a MIME type list', () => {
    expect(parseMimeTypes('image/*, text/plain\napplication/pdf')).toEqual(['image/*', 'text/plain', 'application/pdf'])
  })
})
