import { t } from '@/lib/i18n'

/*
 * Vault integration: secrets stored encrypted by supabase_vault. Secret
 * values only ever travel as bound parameters, never inside the SQL text,
 * so they stay out of query statistics and statement logs.
 */

export interface VaultSecret {
  id: string
  name: string | null
  description: string
  created_at: string
  updated_at: string
}

export const SECRETS_SQL = `
select id::text, name, description, created_at, updated_at from vault.secrets order by name nulls last, created_at`

/** $1 the secret's id. */
export const REVEAL_SQL = `select decrypted_secret as value from vault.decrypted_secrets where id = $1::uuid`

/** $1 value, $2 name, $3 description. */
export const CREATE_SECRET_SQL = `select vault.create_secret($1, nullif($2, ''), $3)::text as id`

/** $1 id, $2 new value (null keeps it), $3 name, $4 description. */
export const UPDATE_SECRET_SQL = `select vault.update_secret($1::uuid, $2, nullif($3, ''), $4)`

/** $1 id. */
export const DELETE_SECRET_SQL = `delete from vault.secrets where id = $1::uuid`

/** Postgres's limit on a secret name is the column's; keep names readable. */
export function secretNameProblem(name: string, taken: string[]): string | null {
  if (!name.trim()) return t('integrations:vault.enterAName')
  if (taken.includes(name.trim())) return t('integrations:vault.anotherSecretHasThisName')
  return null
}
