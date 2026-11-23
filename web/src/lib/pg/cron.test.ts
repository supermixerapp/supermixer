import { describe, expect, it } from 'vitest'

import { alterJob, describeSchedule, functionCommand, httpCommand, isJsonObject, saveJob, scheduleJob, scheduleProblem, unscheduleJob, type CronJob } from './cron'

const job = (over: Partial<CronJob> = {}): CronJob => ({
  id: 7,
  name: 'nightly',
  schedule: '0 0 * * *',
  command: 'select 1',
  active: true,
  username: 'postgres',
  database: 'postgres',
  last_status: null,
  last_start: null,
  last_end: null,
  last_message: null,
  ...over,
})

describe('cron SQL', () => {
  it('schedules, alters and unschedules', () => {
    expect(scheduleJob("it's", '* * * * *', "select 'x'")).toBe(`select cron.schedule('it''s', '* * * * *', 'select ''x''');`)
    expect(alterJob(7, { active: false })).toBe('select cron.alter_job(job_id := 7, active := false);')
    expect(alterJob(7, { schedule: '30 seconds', command: 'select 2' })).toBe(
      "select cron.alter_job(job_id := 7, schedule := '30 seconds', command := 'select 2');"
    )
    expect(unscheduleJob(7)).toBe('select cron.unschedule(7::bigint);')
  })

  it('saves new, edited and renamed jobs', () => {
    expect(saveJob(null, 'a', '* * * * *', 'select 1')).toBe("select cron.schedule('a', '* * * * *', 'select 1');")
    expect(saveJob(job(), 'nightly', '0 1 * * *', 'select 1')).toBe("select cron.alter_job(job_id := 7, schedule := '0 1 * * *', command := 'select 1');")
    const renamed = saveJob(job({ active: false }), 'daily', '0 0 * * *', 'select 1')
    expect(renamed.split('\n')).toEqual([
      'select cron.unschedule(7::bigint);',
      "select cron.schedule('daily', '0 0 * * *', 'select 1');",
      "select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'daily'), active := false);",
    ])
  })

  it('builds commands', () => {
    expect(functionCommand('public', 'clean up')).toBe('select "public"."clean up"()')
    expect(httpCommand({ method: 'GET', url: 'https://x.test/a', headers: '', body: '', timeoutMs: 5000 })).toBe(
      "select net.http_get(url := 'https://x.test/a', headers := '{}'::jsonb, timeout_milliseconds := 5000)"
    )
    expect(httpCommand({ method: 'POST', url: 'https://x.test', headers: '{"a":"b"}', body: '{"n":1}', timeoutMs: 1000 })).toBe(
      `select net.http_post(url := 'https://x.test', body := '{"n":1}'::jsonb, headers := '{"a":"b"}'::jsonb, timeout_milliseconds := 1000)`
    )
    expect(isJsonObject('{"a":1}')).toBe(true)
    expect(isJsonObject('[1]')).toBe(false)
    expect(isJsonObject('')).toBe(true)
    expect(isJsonObject('{')).toBe(false)
  })
})

describe('schedules', () => {
  it('checks the syntax', () => {
    expect(scheduleProblem('*/5 * * * *')).toBeNull()
    expect(scheduleProblem('30 seconds')).toBeNull()
    expect(scheduleProblem('90 seconds')).toMatch(/between 1 and 59/)
    expect(scheduleProblem('* * *')).toMatch(/five cron fields/)
    expect(scheduleProblem('')).toMatch(/Enter/)
  })

  it('describes common ones', () => {
    expect(describeSchedule('* * * * *')).toBe('Every minute')
    expect(describeSchedule('*/5 * * * *')).toBe('Every 5 minutes')
    expect(describeSchedule('0 * * * *')).toBe('Every hour')
    expect(describeSchedule('15 * * * *')).toBe('Every hour at minute 15')
    expect(describeSchedule('0 0 * * *')).toBe('Every day at 00:00')
    expect(describeSchedule('30 9 * * 1')).toBe('Every Monday at 09:30')
    expect(describeSchedule('0 0 1 * *')).toBe('On day 1 of every month at 00:00')
    expect(describeSchedule('30 seconds')).toBe('Every 30 seconds')
    expect(describeSchedule('0 0 * 1 *')).toBeNull()
  })
})
