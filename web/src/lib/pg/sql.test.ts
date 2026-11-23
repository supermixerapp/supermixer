import { describe, expect, it } from 'vitest'

import { ident, literal, qualified, splitStatements } from './sql'

describe('quoting', () => {
  it('quotes identifiers', () => {
    expect(ident('users')).toBe('"users"')
    expect(ident('my "odd" name')).toBe('"my ""odd"" name"')
    expect(qualified('public', 'User')).toBe('"public"."User"')
  })
  it('quotes literals', () => {
    expect(literal("it's")).toBe("'it''s'")
    expect(literal('C:\\path')).toBe("E'C:\\\\path'")
    expect(literal(null)).toBe('null')
  })
})

describe('splitStatements', () => {
  it('splits on semicolons outside quotes, comments and dollar quotes', () => {
    const sql = `select ';' as a; -- not; here
create function f() returns int as $body$ begin return 1; end $body$ language plpgsql;
/* skip; this */ select "a;b" from t`
    expect(splitStatements(sql)).toEqual([
      "select ';' as a;",
      '-- not; here\ncreate function f() returns int as $body$ begin return 1; end $body$ language plpgsql;',
      '/* skip; this */ select "a;b" from t',
    ])
  })
  it('drops empty statements', () => {
    expect(splitStatements('select 1;;  ;')).toEqual(['select 1;'])
  })
})
