import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('admits and reads back a gate through authenticated MCP while an executor read is pending', async () => {
  const f = await fixture({ cloud: { github: 8, circleci: 0 },
    unitInventory: { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] },
    integrationInventory: { files: ['apps/api/test/site.integration.test.ts'], durations: {} },
    supersession: { branch: () => 'feature', isAncestor: () => true },
  })
  const entered = deferred()
  const release = deferred()
  let timeout: NodeJS.Timeout | undefined
  let readPending = false
  let schedule: ReturnType<typeof vi.spyOn> | undefined
  try {
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commit: 'a'.repeat(40) }))
    await f.waitFor(f.operator, old.ticketId, output => output.run.state === 'running')
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      if (input.operation === 'read') {
        readPending = true
        entered.resolve()
        await release.promise
        readPending = false
      }
      return request(computer, input)
    }
    const dispatch = f.ci.dispatch()
    await entered.promise
    await dispatch
    // Keep the admitted gate queued while comparing its MCP and database snapshots.
    schedule = vi.spyOn(f.ci, 'dispatch').mockResolvedValue(undefined)
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'b'.repeat(40),
      commandId: 'pending-dispatch-gate' }
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await Promise.race([
      f.value(f.operator, 'ci_run', input),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Gate admission waited for the executor read')), 3000)
      }),
    ]))
    expect(readPending).toBe(true)
    const result = await f.operator.callTool({ name: 'ci_get', arguments: {
      workspaceId: f.workspaceId, ticketId: admitted.ticketId,
    } })
    expect(result.isError).not.toBe(true)
    const read = CiGetOutputSchema.parse(decodeMcpToolResult(result))
    expect(read.run).toMatchObject({ gate: true, noSupersede: true, state: 'queued', commit: input.commit })
    expect((await f.pool.query('select record from ci_runs where group_id=$1', [read.run.groupId])).rows
      .map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(admitted)
    release.resolve()
    await dispatch
  } finally {
    clearTimeout(timeout)
    release.resolve()
    schedule?.mockRestore()
    await f.close()
  }
})

it('returns replacement tickets before executor cancellation and retains cleanup for dispatch', async () => {
  const f = await fixture({ supersession: { branch: () => 'feature', isAncestor: () => true } })
  f.computers.splice(1)
  const entered = deferred()
  const release = deferred()
  let timeout: NodeJS.Timeout | undefined
  try {
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), commandId: 'cleanup-old',
    }))
    await f.waitFor(f.operator, old.ticketId, output => output.run.state === 'running')
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      if (input.operation === 'cancel') {
        entered.resolve()
        await release.promise
      }
      return request(computer, input)
    }
    const next = CiRunOutputSchema.parse(await Promise.race([
      f.value(f.operator, 'ci_run', { suite: 'install', commit: 'b'.repeat(40), commandId: 'cleanup-next' }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('CI admission waited for executor cancellation')), 3000)
      }),
    ]))
    await entered.promise
    const stored = (await f.pool.query('select record,host_key from ci_runs where id=$1', [old.ticketId])).rows[0]!
    expect(stored.record).toMatchObject({ state: 'running', supersededBy: next.ticketId })
    expect(stored.host_key).not.toBeNull()
    expect(f.started).toHaveLength(1)
    release.resolve()
    await f.ci.dispatch()
    // Cancellation can settle in a later dispatch pass; wait for its persisted state through MCP.
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: old.ticketId, waitUntil: 'group-terminal', waitSeconds: 5,
    }))
    expect(read.wait?.status).toBe('settled')
    expect(read.run).toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
    const replacement = await f.waitFor(f.operator, next.ticketId, output => output.run.state === 'running')
    expect(replacement.run.state).toBe('running')
  } finally {
    clearTimeout(timeout)
    release.resolve()
    await f.close()
  }
})
