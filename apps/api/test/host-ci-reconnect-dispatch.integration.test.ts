import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('dispatches a planned gate part when fresh Worker readiness is observed during an offline dispatch pass', async () => {
  const files = Array.from({ length: 64 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const f = await fixture({ cloud: { github: 8, circleci: 0 },
    unitInventory: { files: ['apps/api/src/feature.test.ts', 'apps/web/src/feature.test.tsx'],
      durations: {}, heavy: [] },
    integrationInventory: { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) } })
  const worker = f.computers[1]!
  const start = vi.spyOn(f.ci, 'start').mockImplementation(() => {
    // ignore: the readiness wake-up drives dispatch; no periodic timer runs in this regression.
  })
  const admissionDispatch = vi.spyOn(f.ci, 'dispatch').mockResolvedValue()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const observingOffline = new Promise<void>(resolve => { entered = resolve })
  let dispatch: Promise<void> | undefined
  let wake: Promise<void> | undefined
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40) }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const read = async () => {
      const result = await reader.callTool({ name: 'ci_get',
        arguments: { workspaceId: f.workspaceId, ticketId: admitted.ticketId } })
      expect(result.isError).not.toBe(true)
      return CiGetOutputSchema.parse(decodeMcpToolResult(result))
    }
    const parts = (await read()).partitions!
    const planned = parts.find(run => run.plannedHostKey === worker.key)!
    expect(planned).toMatchObject({ state: 'queued', suite: 'integration' })
    for (const part of parts.filter(run => run.id !== planned.id)) {
      await f.value(f.operator, 'ci_cancel', { ticketId: part.id })
    }
    admissionDispatch.mockRestore()

    let ready = false
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, input) => {
      const reply = await request(computer, input)
      if (reply.operation !== 'status') return reply
      return { ...reply, ready: ready && computer.key === worker.key,
        reasons: ready && computer.key === worker.key ? [] : ['Worker reconnecting'] }
    }
    await f.value(f.operator, 'ci_computers_list', {})
    let pause = true
    let discoveries = 0
    const computers = f.endpoint.computers.bind(f.endpoint)
    f.endpoint.computers = async () => {
      discoveries++
      const available = await computers()
      if (pause) {
        pause = false
        entered()
        await blocked
      }
      return available
    }
    dispatch = f.ci.dispatch()
    await observingOffline
    ready = true
    await f.value(f.operator, 'ci_computers_list', {})
    const beforeWake = discoveries
    wake = f.ci.dispatch()
    release()
    await Promise.all([dispatch, wake])
    expect(discoveries).toBeGreaterThan(beforeWake)
    await f.ci.close()

    const recovered = (await read()).partitions!.find(run => run.id === planned.id)!
    expect(recovered).toMatchObject({ state: 'running', plannedHostKey: worker.key,
      computer: { hostRef: worker.hostRef } })
    expect(f.started.filter(entry => entry.request.operation === 'start' && entry.request.runId === planned.id))
      .toHaveLength(1)
    const persisted = (await f.pool.query('select record from ci_runs where id=$1', [planned.id])).rows[0]!.record
    expect(persisted).toEqual(recovered)
  } finally {
    release()
    await Promise.allSettled([dispatch, wake])
    admissionDispatch.mockRestore()
    start.mockRestore()
    await f.close()
  }
})
