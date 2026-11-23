import { describe, expect, it } from 'vitest'

import { archiveMessage, createQueue, deleteMessage, dropQueue, queueMessagesSql, queueNameProblem, sendMessage } from './queues'

describe('queues', () => {
  it('checks names the way pgmq does', () => {
    expect(queueNameProblem('emails')).toBeNull()
    expect(queueNameProblem('Emails')).toMatch(/lowercase/)
    expect(queueNameProblem('a-b')).toMatch(/lowercase/)
    expect(queueNameProblem('a'.repeat(48))).toMatch(/47/)
  })

  it('builds queue SQL', () => {
    expect(createQueue('emails', 'basic')).toBe("select pgmq.create('emails');")
    expect(createQueue('emails', 'unlogged')).toBe("select pgmq.create_unlogged('emails');")
    expect(dropQueue('emails')).toBe("select pgmq.drop_queue('emails');")
    expect(sendMessage('emails', `{"to":"o'neil"}`, 5)).toBe(`select pgmq.send('emails', '{"to":"o''neil"}'::jsonb, 5);`)
    expect(deleteMessage('emails', 3)).toBe("select pgmq.delete('emails', 3::bigint);")
    expect(archiveMessage('emails', 3)).toBe("select pgmq.archive('emails', 3::bigint);")
    expect(queueMessagesSql('emails')).toContain('from "pgmq"."q_emails"')
    expect(queueMessagesSql('emails', true)).toContain('from "pgmq"."a_emails"')
  })
})
