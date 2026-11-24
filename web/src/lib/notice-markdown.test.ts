import { describe, expect, it } from 'vitest'

import { noticePlainText, parseNotice, safeNoticeHref } from './notice-markdown'

describe('notice Markdown', () => {
  it('reads bold and links, leaving the rest as typed', () => {
    expect(parseNotice('Down **tonight**, see [status](https://status.example.com).')).toEqual([
      { kind: 'text', text: 'Down ' },
      { kind: 'bold', children: [{ kind: 'text', text: 'tonight' }] },
      { kind: 'text', text: ', see ' },
      {
        kind: 'link',
        href: 'https://status.example.com',
        external: true,
        children: [{ kind: 'text', text: 'status' }],
      },
      { kind: 'text', text: '.' },
    ])
    expect(parseNotice('a * b ** c _d_ `e`')).toEqual([
      { kind: 'text', text: 'a * b ** c _d_ `e`' },
    ])
    expect(parseNotice('** not bold **')).toEqual([{ kind: 'text', text: '** not bold **' }])
  })

  it('nests bold and links one way or the other', () => {
    expect(parseNotice('**read [this](/account/security)**')).toEqual([
      {
        kind: 'bold',
        children: [
          { kind: 'text', text: 'read ' },
          {
            kind: 'link',
            href: '/account/security',
            external: false,
            children: [{ kind: 'text', text: 'this' }],
          },
        ],
      },
    ])
    expect(parseNotice('[**here**](mailto:ops@example.com)')).toEqual([
      {
        kind: 'link',
        href: 'mailto:ops@example.com',
        external: true,
        children: [{ kind: 'bold', children: [{ kind: 'text', text: 'here' }] }],
      },
    ])
  })

  it("doesn't link anywhere unsafe", () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example',
      '/\\evil.example',
      'vbscript:x',
      'https:',
    ]) {
      expect(safeNoticeHref(href).ok, href).toBe(false)
    }
    expect(parseNotice('[click](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[click](javascript:alert(1)' },
      { kind: 'text', text: ')' },
    ])
  })

  it('gives the words without the Markdown', () => {
    expect(noticePlainText(parseNotice('Down **tonight**, see [status](https://s.example).'))).toBe(
      'Down tonight, see status.'
    )
  })
})
