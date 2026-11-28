/*
 * Queues integration: pgmq message queues. Each queue is a table
 * pgmq.q_<name>, with archived messages in pgmq.a_<name>.
 */
import { literal, qualified } from './sql'
import { t } from '@/lib/i18n'

export interface QueueRow {
  name: string
  created_at: string
  is_partitioned: boolean
  is_unlogged: boolean
  length: number
  newest_age: number | null
  oldest_age: number | null
  total: number
}

export const QUEUES_SQL = `
select q.queue_name as name, q.created_at, q.is_partitioned, q.is_unlogged,
  coalesce(m.queue_length, 0)::float8 as length, m.newest_msg_age_sec::float8 as newest_age,
  m.oldest_msg_age_sec::float8 as oldest_age, coalesce(m.total_messages, 0)::float8 as total
from pgmq.list_queues() q
left join pgmq.metrics_all() m on m.queue_name = q.queue_name
order by q.queue_name`

export interface QueueMessage {
  id: number
  read_count: number
  enqueued_at: string
  visible_at: string
  message: unknown
}

/** Messages in a queue, oldest first, without reading (so without hiding) them. */
export function queueMessagesSql(queue: string, archive = false): string {
  return `select msg_id::float8 as id, read_ct::int as read_count, enqueued_at, vt as visible_at, message
from ${qualified('pgmq', `${archive ? 'a' : 'q'}_${queue}`)} order by msg_id limit 100`
}

export type QueueType = 'basic' | 'unlogged'

/** pgmq's own rule: lowercase letters, digits and underscores, at most 47 characters. */
export function queueNameProblem(name: string): string | null {
  if (!name) return t('integrations:queues.enterAName')
  if (!/^[a-z0-9_]+$/.test(name)) return t('integrations:queues.useLowercaseLettersDigitsAndUnderscores')
  if (name.length > 47) return t('integrations:queues.atMost47Characters')
  return null
}

export function createQueue(name: string, type: QueueType): string {
  return `select pgmq.${type === 'unlogged' ? 'create_unlogged' : 'create'}(${literal(name)});`
}

export function dropQueue(name: string): string {
  return `select pgmq.drop_queue(${literal(name)});`
}

export function purgeQueue(name: string): string {
  return `select pgmq.purge_queue(${literal(name)});`
}

export function sendMessage(queue: string, json: string, delaySeconds: number): string {
  return `select pgmq.send(${literal(queue)}, ${literal(json)}::jsonb, ${Math.max(0, Math.trunc(delaySeconds))});`
}

export function deleteMessage(queue: string, id: number): string {
  return `select pgmq.delete(${literal(queue)}, ${Math.trunc(id)}::bigint);`
}

export function archiveMessage(queue: string, id: number): string {
  return `select pgmq.archive(${literal(queue)}, ${Math.trunc(id)}::bigint);`
}
