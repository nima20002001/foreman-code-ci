import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('persists measured unit gate parts through MCP and dispatches the same learned timings', async () => {
  const files = Array.from({ length: 9 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 90_000]))
  const integrationFiles = Array.from({ length: 48 }, (_, index) =>
    `apps/api/test/feature-${index}.integration.test.ts`)
  const f = await fixture({ unitInventory: { files, durations: {}, heavy: [] },
    integrationInventory: { files: integrationFiles,
      durations: Object.fromEntries(integrationFiles.map(file => [file, 120_000])) },
    cloud: { github: 24, circleci: 0 } })
  try {
    for (const file of files) {
      await f.pool.query('insert into ci_file_durations(repository,file,duration_ms) values($1,$2,$3)',
        ['octo/site', file, durations[file]])
    }
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40) }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const admitted = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: admitted.ticketId }))
    const unit = read.partitions!.filter(run => run.part === 'unit-api')
    expect(unit).toHaveLength(9)
    expect(unit.every(run => run.expectedDurationMs === 180_000)).toBe(true)
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)
    for (const run of unit) {
      expect(stored).toEqual(expect.arrayContaining([expect.objectContaining({
        id: run.id, partition: run.partition, expectedDurationMs: 180_000,
      })]))
    }
    await f.ci.dispatch()
    const started = f.started.filter(item => item.request.operation === 'start' && item.request.part === 'unit-api')
    expect(started).toHaveLength(9)
    for (const item of started) expect(item.request).toMatchObject({ durations })
  } finally { await f.close() }
})
