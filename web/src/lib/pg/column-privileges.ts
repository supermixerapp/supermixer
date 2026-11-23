/*
 * Column privileges: which columns of a table a role may read or write.
 *
 * Postgres checks a table-level grant first, so a role that has UPDATE on the
 * whole table can update every column, whatever the column grants say. To
 * take one column away, the table grant has to become per-column grants on
 * all the other columns. REVOKE on the table also clears that privilege's
 * column grants.
 */
import { ident, literal, qualified } from './sql'

export const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const
export type ColumnPrivilege = (typeof COLUMN_PRIVILEGES)[number]

export interface PrivilegeRole {
  name: string
  superuser: boolean
}

/** Roles a grant can name: not Postgres's own pg_* roles. The API roles first. */
export const PRIVILEGE_ROLES_SQL = `
select rolname as name, rolsuper as superuser from pg_roles
where rolname !~ '^pg_'
order by rolname not in ('anon', 'authenticated', 'service_role'), rolname`

/** Tables, views and foreign tables in schema $1 that grants apply to. Partitions take the parent's. */
export const PRIVILEGE_TABLES_SQL = `
select c.relname as name, c.relkind as kind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
order by c.relname`

export interface TablePrivileges {
  kind: string
  owner: string
  /** Granted to the role on the whole table. */
  granted: string[]
  /** Granted to PUBLIC, so to every role. */
  public_granted: string[]
  /** Of those granted to the role, ones another role granted that this connection can't revoke. */
  locked: string[]
  /** Who made the locked grants. */
  locked_by: string[]
  columns: { name: string; type: string; granted: string[]; public_granted: string[]; locked: string[]; locked_by: string[] }[]
}

/*
 * REVOKE only removes grants made by the role it runs as (the object's owner
 * when the current user is a member of it), and just warns about the rest.
 * Grants made by a role the current user can't act for are reported as locked.
 */
const grants = (acl: string, who: string, where = '') =>
  `array(select distinct e.privilege_type from aclexplode(${acl}) e where e.grantee = ${who}${where} order by 1)`
const lockedBySql = (acl: string) =>
  `array(select distinct pg_get_userbyid(e.grantor) from aclexplode(${acl}) e where e.grantee = (select oid from r) and ${FOREIGN} order by 1)`
const FOREIGN = `not pg_has_role(current_user, e.grantor, 'MEMBER')`
const TABLE_ACL = `coalesce(c.relacl, acldefault('r', c.relowner))`

/**
 * Grants on table $2 in schema $1 for role $3, made directly to it or to
 * PUBLIC. A table with no ACL yet has the default one: everything for its owner.
 */
export const TABLE_PRIVILEGES_SQL = `
with r as (select oid from pg_roles where rolname = $3)
select c.relkind as kind, pg_get_userbyid(c.relowner) as owner,
  ${grants(TABLE_ACL, '(select oid from r)')} as granted,
  ${grants(TABLE_ACL, '0')} as public_granted,
  ${grants(TABLE_ACL, '(select oid from r)', ` and ${FOREIGN}`)} as locked,
  ${lockedBySql(TABLE_ACL)} as locked_by,
  coalesce((
    select json_agg(json_build_object(
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'granted', ${grants('a.attacl', '(select oid from r)')},
      'public_granted', ${grants('a.attacl', '0')},
      'locked', ${grants('a.attacl', '(select oid from r)', ` and ${FOREIGN}`)},
      'locked_by', ${lockedBySql('a.attacl')}
    ) order by a.attnum)
    from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  ), '[]') as columns
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relname = $2`

/** How a role holds a privilege on a column. 'locked' grants can't be revoked here. */
export type GrantSource = 'public' | 'locked' | 'table' | 'column' | 'none'

export function columnGrant(t: TablePrivileges, column: string, privilege: ColumnPrivilege): GrantSource {
  const col = t.columns.find((c) => c.name === column)
  if (t.public_granted.includes(privilege) || col?.public_granted.includes(privilege)) return 'public'
  if (t.locked.includes(privilege) || col?.locked.includes(privilege)) return 'locked'
  if (t.granted.includes(privilege)) return 'table'
  if (col?.granted.includes(privilege)) return 'column'
  return 'none'
}

/** The grant on the whole table, for the "All columns" row. */
export function tableGrant(t: TablePrivileges, privilege: ColumnPrivilege): GrantSource {
  if (t.public_granted.includes(privilege)) return 'public'
  if (t.locked.includes(privilege)) return 'locked'
  if (t.granted.includes(privilege)) return 'table'
  return 'none'
}

/** Roles whose grants of this privilege can't be revoked here. */
export function lockedBy(t: TablePrivileges, privilege: ColumnPrivilege, column?: string): string[] {
  const col = column === undefined ? undefined : t.columns.find((c) => c.name === column)
  const out = new Set<string>()
  if (t.locked.includes(privilege)) t.locked_by.forEach((r) => out.add(r))
  if (col?.locked.includes(privilege)) col.locked_by.forEach((r) => out.add(r))
  return [...out]
}

/** Postgres's warnings when a GRANT or REVOKE quietly did less than asked. */
export const PARTIAL_GRANT = /(no|not all) privileges (could be revoked|were granted)/

export interface Target {
  schema: string
  table: string
  role: string
}

/** Grant or revoke a privilege on the whole table. Revoking also clears its column grants. */
export function setTablePrivilege({ schema, table, role }: Target, privilege: ColumnPrivilege, on: boolean): string {
  const rel = qualified(schema, table)
  return on ? `grant ${privilege.toLowerCase()} on table ${rel} to ${ident(role)};` : `revoke ${privilege.toLowerCase()} on table ${rel} from ${ident(role)};`
}

/**
 * Grant or revoke a privilege on one column. Revoking from a role that holds
 * it on the whole table swaps the table grant for grants on the other columns.
 */
export function setColumnPrivilege(
  { schema, table, role }: Target,
  privilege: ColumnPrivilege,
  column: string,
  on: boolean,
  t: TablePrivileges
): string {
  const rel = qualified(schema, table)
  const p = privilege.toLowerCase()
  const r = ident(role)
  if (on) return `grant ${p} (${ident(column)}) on table ${rel} to ${r};`
  if (!t.granted.includes(privilege)) return `revoke ${p} (${ident(column)}) on table ${rel} from ${r};`
  const others = t.columns.filter((c) => c.name !== column).map((c) => ident(c.name))
  const lines = [
    `revoke ${p} on table ${rel} from ${r};`,
    // A grant from another role survives the REVOKE with only a warning; stop
    // before granting the other columns. The script runs as one transaction.
    `do $sm$ begin
  if exists (select 1 from pg_class c, aclexplode(c.relacl) e
             where c.oid = ${literal(rel)}::regclass and e.grantee = ${literal(ident(role))}::regrole and e.privilege_type = ${literal(privilege)}) then
    raise exception '%', ${literal(`${privilege} on ${schema}.${table} was granted to ${role} by another role, so it can't be revoked here`)};
  end if;
end $sm$;`,
  ]
  if (others.length) lines.push(`grant ${p} (${others.join(', ')}) on table ${rel} to ${r};`)
  return lines.join('\n')
}
