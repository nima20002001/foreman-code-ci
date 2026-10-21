import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { genericCiRepository } from './helpers/genericCiRepository.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'
import { deferred } from './helpers/deferred.js'

it.each([
  ['pnpm-lock.yaml', 'corepack pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'corepack yarn'],
  [undefined, 'npm'],
])('runs another repository with %s as single jobs through authenticated MCP', async (lockfile, pm) => {
  const repository = await genericCiRepository(lockfile ? { lockfile } : {})
  const f = await fixture({ repositoryRunner: repository })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', { suite: 'build', commandId: 'denied-generic' })).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    for (const suite of ['build', 'lint', 'unit'] as const) {
      const input = { suite, commandId: `generic-${suite}` }
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(started.partitions).toBeUndefined()
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
      const read = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), started.ticketId, 'passed')
      expect(read.run).toMatchObject({ suite, part: null, partition: null, scope: 'full', files: [],
        state: 'passed', exitCode: 0, commit: repository.commit, computer: { hostRef: { kind: 'main' } } })
      expect(read.partitions).toBeUndefined()
      expect(read.logTail).toContain(`${pm} install`)
      expect(read.logTail).toContain(`${pm} run ${suite}`)
      expect(read.logTail).toContain(`fixture ${suite} passed`)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
        [read.run.groupId])).rows
      expect(stored.map(row => row.record)).toEqual([read.run])
    }
  } finally {
    await f.close()
    await repository.close()
  }
})

it('settles the real MCP job after preempting a warmup whose native unit never starts', async () => {
  const entered = deferred()
  const release = deferred()
  let firstLaunch = true
  const repository = await genericCiRepository({ lockfile: 'pnpm-lock.yaml', beforeLaunch: async () => {
    if (!firstLaunch) return
    firstLaunch = false
    entered.resolve()
    await release.promise
    throw new Error('Warmup launch interrupted before service creation')
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const computer = (await repository.endpoint.computers())[0]!
    const warmupId = randomUUID()
    await repository.endpoint.request(computer, { operation: 'start', warmup: true, runId: warmupId,
      repository: 'octo/site', commit: repository.commit, suite: 'install', scope: 'full' })
    await entered.promise
    const ticket = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build' }))
    await vi.waitFor(async () => {
      const pending = await repository.endpoint.request(computer, {
        operation: 'read', runId: warmupId, afterOffset: 0, maxBytes: 1024,
      })
      expect(pending).toMatchObject({ operation: 'read', run: { state: 'starting',
        message: expect.stringContaining('Cancellation requested') } })
    })
    release.resolve()
    const saved = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), ticket.ticketId, 'passed')
    expect(saved.run).toMatchObject({ suite: 'build', state: 'passed', computer: { hostRef: computer.hostRef } })
    expect(saved.logTail).toContain('fixture build passed')
    expect(saved.run.id).not.toBe(warmupId)
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [saved.run.groupId])).rows.map(row => row.record)).toEqual([saved.run])
  } finally {
    release.resolve()
    await f.close()
    await repository.close()
  }
})

it.each([0, 1250])(
  'runs generic integration once on a build computer when no cloud mirror is configured after a %i ms launch delay',
  async launchDelayMs => {
  const repository = await genericCiRepository({ integration: true, cloud: true, beforeLaunch: async () => {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
      { suite: 'integration', partitions: 4, commandId: 'generic-integration' }))
    expect(started.partitions).toBeUndefined()
    await f.value(f.operator, 'ci_computers_list', {})
    await f.ci.dispatch()
    expect((await repository.waitForCompletion(started.ticketId)).code).toBe(0)
    await f.ci.dispatch()
    const read = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), started.ticketId, 'passed')
    expect(read.run).toMatchObject({ part: null, partition: null, state: 'passed',
      computer: { hostRef: { kind: 'main' } } })
    expect(read.logTail).toContain('npm run integration')
    expect(read.logTail?.split('\n').filter(line => line === 'npm run integration')).toHaveLength(1)
    expect(read.logTail).toContain('fixture integration passed')
    expect(repository.cloudAttempts).toEqual([])
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)).toEqual([read.run])
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each([
  ['unit', 0], ['unit', 1250], ['lint', 0], ['lint', 1250],
] as const)(
  'rejects empty affected selection, then runs explicit full generic %s with HTTP and MCP readback after a %i ms launch delay',
  async (suite, launchDelayMs) => {
  const repository = await genericCiRepository({ cloud: true, beforeLaunch: async () => {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const input = { suite, scope: 'affected', files: [], commit: repository.commit, commandId: 'generic-affected' }
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const reader = await f.credential(CI_GET_ACTIONS)
    const denied = await f.app.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${reader.token}` }, payload: input })
    expect(denied.statusCode).toBe(403)
    const rejected = await f.app.inject({ method: 'POST', url, headers, payload: input })
    const selectionError = { error: { code: 'CI_SELECTION_UNSUPPORTED',
      message: 'This repository has no affected test selection. Request scope full and omit files.' } }
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject(selectionError)
    const mcpRejected = await f.call(f.operator, 'ci_run', { ...input, commandId: 'generic-affected-mcp' })
    expect(mcpRejected.isError).toBe(true)
    expect(decodeMcpToolResult(mcpRejected)).toMatchObject(selectionError)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    expect(repository.cloudAttempts).toEqual([])

    const fullInput = { suite, scope: 'full', commit: repository.commit, commandId: 'generic-full' }
    const response = await f.app.inject({ method: 'POST', url, headers, payload: fullInput })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    await f.value(f.operator, 'ci_computers_list', {})
    await f.ci.dispatch()
    expect((await repository.waitForCompletion(started.ticketId)).code).toBe(0)
    await f.ci.dispatch()
    await ciRunReadback(input => f.value(f.operator, 'ci_get', input), started.ticketId, 'passed')
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    expect(read.statusCode).toBe(200)
    const result = CiGetOutputSchema.parse(read.json())
    expect(result.run).toMatchObject({ state: 'passed', part: null, partition: null, scope: 'full', files: [],
      computer: { hostRef: { kind: 'main' } } })
    expect(result.logTail).toContain(`fixture ${suite} passed`)
    expect(repository.cloudAttempts).toEqual([])
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId })).run)
      .toEqual(result.run)
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(result.run)
  } finally {
    await f.close()
    await repository.close()
  }
})
