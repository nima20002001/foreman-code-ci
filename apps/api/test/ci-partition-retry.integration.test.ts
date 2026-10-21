import { CiGetOutputSchema, CiRunOutputSchema, integrationPartition, type CiHostRequest } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

type Start = Extract<CiHostRequest, { operation: 'start' }>

it('preserves full integration file membership after a cloud setup failure and retry', async () => {
  const files = Array.from({ length: 12 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map((file, index) => [file, 60_000 + index * 9_000]))
  const f = await fixture({ integrationInventory: { files, durations }, cloud: { github: 2, circleci: 0 } })
  try {
    const input = { suite: 'integration', scope: 'full', partitions: 4,
      commit: 'a'.repeat(40), commandId: 'partition-retry' }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const initial = await f.waitFor(f.operator, admitted.ticketId,
      output => output.partitions?.length === 4 && output.partitions.every(run => run.state === 'running'))
    const failed = initial.partitions!.find(run => run.computer?.hostRef.kind === 'cloud')!
    expect(failed).toBeDefined()
    const originals = f.started.map(item => item.request).filter((request): request is Start =>
      request.operation === 'start' && request.suite === 'integration')
    expect(originals).toHaveLength(4)
    const original = originals.find(request => request.runId === failed.id)!
    const slice = (request: Start) => integrationPartition(files, request.durations ?? {}, request.partition!)
    expect(originals.flatMap(slice).sort()).toEqual([...files].sort())

    const endpoint = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, request) => {
      const reply = await endpoint(computer, request)
      if (reply.operation === 'read' && request.operation === 'read'
        && request.runId === failed.id && reply.run.state === 'failed') {
        return { ...reply, run: { ...reply.run, testsStarted: false } }
      }
      return reply
    }
    f.finish(failed.id, 1, 'Install failed before tests started.\n')
    const completed = initial.partitions!.find(run => run.computer?.hostRef.kind !== 'cloud')!
    f.finish(completed.id, 0, 'Completed original partition.\n')
    await f.ci.dispatch()
    await f.ci.drain()
    const retried = await f.waitFor(f.operator, failed.id,
      output => output.run.state === 'running' && output.run.setupRetry !== undefined)
    const retry = f.started.map(item => item.request).find((request): request is Start =>
      request.operation === 'start' && request.runId === retried.run.setupRetry!.runId)!
    expect(retry).toBeDefined()
    expect(retry.durations).toEqual(original.durations)
    expect(retry.partition).toEqual(original.partition)
    expect(slice(retry)).toEqual(slice(original))
    const executed = originals.flatMap(request => slice(request.runId === failed.id ? retry : request))
    expect(executed.sort()).toEqual([...files].sort())
    expect(new Set(executed).size).toBe(files.length)
    const persisted = (await f.pool.query<{ durations: unknown }>('select durations from ci_runs where id=$1',
      [failed.id])).rows[0]!
    expect(persisted.durations).toEqual(original.durations)
    expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: failed.id })).run)
      .toMatchObject({ scope: 'full', setupRetry: retried.run.setupRetry })
  } finally { await f.close() }
})
