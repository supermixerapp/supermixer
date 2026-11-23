import { describe, expect, it } from 'vitest'

import { createWebhook, decodeTriggerArgs, dropWebhook, parseWebhook, replaceWebhook, type WebhookDef } from './webhooks'

const hook: WebhookDef = {
  name: 'notify',
  schema: 'public',
  table: 'orders',
  events: ['INSERT', 'UPDATE'],
  method: 'POST',
  url: "https://example.test/o'k",
  headers: '{"Content-Type":"application/json"}',
  params: '{}',
  timeoutMs: 5000,
}

describe('webhooks', () => {
  it('creates and drops the trigger', () => {
    expect(createWebhook(hook)).toBe(
      `create trigger "notify" after INSERT or UPDATE on "public"."orders"
for each row execute function supabase_functions.http_request('https://example.test/o''k', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');`
    )
    expect(dropWebhook(hook)).toBe('drop trigger if exists "notify" on "public"."orders";')
    expect(replaceWebhook({ name: 'old', schema: 'public', table: 'orders' }, hook).split('\n')[0]).toBe('drop trigger if exists "old" on "public"."orders";')
  })

  it("decodes Postgres's escaped trigger arguments", () => {
    // As encode(tgargs, 'escape') prints them: NUL and UTF-8 bytes as octal, backslashes doubled.
    const escaped = 'https://x.test\\000POST\\000{"n":"caf\\303\\251 \\\\\\\\"}\\000{}\\0001000\\000'
    expect(decodeTriggerArgs(escaped)).toEqual(['https://x.test', 'POST', '{"n":"café \\\\"}', '{}', '1000'])
    expect(decodeTriggerArgs('')).toEqual([])
  })

  it('reads a webhook back', () => {
    const def = parseWebhook({
      name: 'notify',
      schema: 'public',
      table: 'orders',
      events: ['DELETE'],
      enabled: true,
      args_escaped: 'https://x.test\\000GET\\000null\\000{"a":"1"}\\0002500\\000',
    })
    expect(def).toMatchObject({ method: 'GET', url: 'https://x.test', headers: '{}', params: '{"a":"1"}', timeoutMs: 2500, events: ['DELETE'] })
  })
})
