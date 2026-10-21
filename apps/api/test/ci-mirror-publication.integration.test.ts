import { randomUUID } from 'node:crypto'
import { CiGetOutputSchema, CiRunOutputSchema, type CiHostRun } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { fixture as mirrorFixture } from '../src/modules/ci-host/cloud.testSupport.js'
import type { HostCiComputer, HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('admits MCP requests and runs own-computer work while cloud publication is pending, then persists ready readback', async () => {
  const mirror = await mirrorFixture()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const original = mirror.git.git.bind(mirror.git)
  vi.spyOn(mirror.git, 'git').mockImplementation(async (args, options) => {
    if (args[0] === 'push' && args.includes('--force')) await blocked
    return original(args, options)
  })
  const local: HostCiComputer = { key: 'local-ci', label: 'Local CI', priority: 60,
    hostRef: { kind: 'main', mainId: 'main-1' } }
  let localRun: CiHostRun | undefined
  const cloud = mirror.cloud.computers().slice(0, 1)
  const endpoint: HostCiEndpoint = {
    computers: async () => [local, ...cloud],
    request: async (computer, request) => {
      if (computer.hostRef.kind === 'cloud') return mirror.cloud.handle(request)
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 8 * 2 ** 30, slotsTotal: 1,
        slotsUsed: localRun?.state === 'running' ? 1 : 0, runs: localRun ? [localRun] : [] }
      if (request.operation === 'start') {
        localRun = { runId: request.runId, state: 'running', step: 'lint', exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, message: null, logBytes: 0 }
        return { operation: 'start', run: localRun }
      }
      if (!localRun) throw new Error('Missing local run')
      if (request.operation === 'cancel') return { operation: 'cancel', run: localRun }
      return { operation: 'read', run: localRun, text: '', nextOffset: 0 }
    },
  }
  const f = await fixture({ repositoryRunner: { endpoint, commits: {
    resolve: async () => mirror.commit,
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: false }),
  } } })
  await f.pool.query(`update workspaces set record=record || $2::jsonb where id=$1`,
    [f.workspaceId, JSON.stringify({ ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } })])
  const input = { suite: 'lint', scope: 'full', commit: mirror.commit, noSupersede: true }
  const run = async () => CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
    ...input, commandId: randomUUID(),
  }))
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', { ...input, commandId: randomUUID() })).isError).toBe(true)
    await run()
    await f.ci.dispatch()
    await f.ci.drain()
    const cloudRun = await run()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([f.ci.dispatch().then(() => f.ci.drain()), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cloud publication blocked dispatch')), 2000)
      })])
    } finally {
      clearTimeout(timer)
    }
    const read = async () => CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: cloudRun.ticketId })).run
    expect(await read()).toMatchObject({ mirrorPublication: { state: 'pending' } })
    localRun = { ...localRun!, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() }
    const own = await run()
    await f.ci.dispatch()
    await f.ci.drain()
    expect(localRun.runId).toBe(own.ticketId)
    expect(mirror.dispatched).toHaveLength(0)
    release()
    await expect.poll(read, { timeout: 5000 }).toMatchObject({ mirrorPublication: { state: 'ready' } })
    await mirror.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    const persisted = (await f.pool.query('select record from ci_runs where id=$1', [cloudRun.ticketId])).rows[0].record
    expect(persisted.mirrorPublication.state).toBe('ready')
    expect(mirror.dispatched).toHaveLength(1)
  } finally {
    release()
    await mirror.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    await f.close()
  }
})
