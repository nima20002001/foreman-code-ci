import { CiLogsOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { genericCiRepository } from './helpers/genericCiRepository.js'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it.each([
  ['typecheck', 0, 'checkout'], ['typecheck', 1250, 'checkout'],
  ['integration', 0, 'checkout'], ['integration', 1250, 'checkout'],
  ['typecheck', 0, 'launch'], ['typecheck', 1250, 'launch'],
  ['integration', 0, 'launch'], ['integration', 1250, 'launch'],
] as const)(
  'reports a missing generic %s script through MCP and persisted readback after a %i ms %s delay',
  async (suite, delayMs, stage) => {
  const delay = async () => {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  const repository = await genericCiRepository(stage === 'checkout'
    ? { beforeCheckout: delay }
    : { beforeLaunch: delay })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const input = { suite, commandId: `missing-${suite}` }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const read = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), started.ticketId, 'failed')
    expect(read.run).toMatchObject({ state: 'failed', part: null, partition: null,
      message: `The repository has no "${suite}" script for the ${suite} suite.` })
    if (suite === 'integration') expect(read.run.collection).toBe('unsupported')
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(read.run)
  } finally {
    await f.close()
    await repository.close()
  }
})

it('runs another repository’s named parts through its own suite hook', async () => {
  const repository = await genericCiRepository({ suiteHook: true })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'custom-hook' }))
    expect(started.partitions).toHaveLength(2)
    const read = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), started.ticketId, 'passed')
    expect(read.partitions!.map(run => run.part).sort()).toEqual(['build-api', 'build-other'])
    for (const run of read.partitions!) {
      expect(run.state).toBe('passed')
      const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: run.id }))
      expect(logs.text).toContain(`fixture hook ${run.part} passed`)
    }
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each([0, 1250])(
  'runs generic install without an install script and persists a package-script failure after a %i ms launch delay',
  async launchDelayMs => {
  const repository = await genericCiRepository({ suiteExit: 7, beforeLaunch: async () => {
    // A subprocess launch can take longer than the default matcher polling deadline.
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const install = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'generic-install' }))
    const installed = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), install.ticketId, 'passed')
    expect(installed.run).toMatchObject({ part: null, partition: null, step: 'install', exitCode: 0 })
    expect(installed.logTail).toContain('npm install')
    expect(installed.logTail).not.toContain('npm run install')
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [install.ticketId])).rows[0]!.record).toEqual(installed.run)
    const build = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'generic-failure' }))
    const failed = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), build.ticketId, 'failed')
    expect(failed.run).toMatchObject({ part: null, partition: null, step: 'build', state: 'failed', exitCode: 7 })
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [build.ticketId])).rows[0]!.record).toEqual(failed.run)
  } finally {
    await f.close()
    await repository.close()
  }
})
