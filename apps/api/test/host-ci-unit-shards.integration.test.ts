import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each(['http', 'mcp'] as const)('returns and replays every maximum unit shard through %s', async transport => {
  const files = ['apps/api/test', 'apps/web/src'].flatMap(directory => Array.from({ length: 32 }, (_, index) =>
    `${directory}/measured${index}.test.ts`))
  const durations = Object.fromEntries(files.map(file => [file, 150_000]))
  const f = await fixture({ unitInventory: { files, durations, heavy: [] }, cloud: { github: 32, circleci: 0 } })
  try {
    const input = { suite: 'unit', scope: 'full', commit: 'a'.repeat(40), commandId: `maximum-${transport}` }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const credential = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const run = async () => {
      if (transport === 'mcp') return CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      const response = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${f.workspaceId}/ci`,
        headers: { authorization: `Bearer ${credential.token}` }, payload: input })
      expect(response.statusCode, response.body).toBe(200)
      return CiRunOutputSchema.parse(response.json())
    }
    const result = await run()
    expect(result.partitions).toHaveLength(67)
    expect(await run()).toEqual(result)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: result.ticketId }))
    expect(read.partitions).toHaveLength(67)
    expect(new Set(read.partitions!.map(part => part.id))).toEqual(new Set(result.partitions!.map(part => part.ticketId)))
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(67)
  } finally { await f.close() }
})

it('sizes learned unit shards from eligible slots, busy ones included, and persists the same plan through authenticated MCP', async () => {
  const files = Array.from({ length: 12 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 10_000]))
  const f = await fixture({ unitInventory: { files, durations, heavy: [] }, cloud: { github: 4, circleci: 0 } })
  const request = f.endpoint.request
  f.endpoint.request = async (computer, input) => {
    const reply = await request(computer, input)
    if (reply.operation === 'status' && computer.hostRef.kind === 'cloud' && computer.hostRef.slot === 0) {
      return { ...reply, slotsUsed: 1 }
    }
    return reply
  }
  try {
    for (const file of files) {
      await f.pool.query(`insert into ci_file_durations(repository,file,duration_ms,updated_at)
        values($1,$2,$3,now())`, ['octo/site', file, 150_000])
    }
    const input = { suite: 'unit', scope: 'full', commit: 'a'.repeat(40), commandId: 'free-unit-slots' }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const result = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(result)
    const read = await f.waitFor(f.operator, result.ticketId, output => output.partitions!.some(run =>
      run.state === 'running') && output.partitions!.every(run =>
      run.state === 'queued' && run.message !== null || run.observation?.status === 'available'))
    const api = read.partitions!.filter(part => part.part === 'unit-api')
    expect(api).toHaveLength(6)
    expect(api.map(part => part.partition)).toEqual([0, 1, 2, 3, 4, 5].map(index => ({ index, count: 6 })))
    expect(read.partitions!.filter(part => part.part === 'unit-web-heavy')).toHaveLength(2)
    expect(read.partitions!.filter(part => part.part === 'unit-other')).toHaveLength(1)
    const stored = (await f.pool.query('select record from ci_runs where group_id=$1', [read.run.groupId])).rows
    expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
  } finally { await f.close() }
})

it('reads persisted unit shards in numeric order through authenticated HTTP and MCP', async () => {
  const files = Array.from({ length: 12 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 150_000]))
  const f = await fixture({ unitInventory: { files, durations, heavy: [] }, cloud: { github: 12, circleci: 0 } })
  try {
    const input = { suite: 'unit', scope: 'full', commit: 'a'.repeat(40), commandId: 'ordered-unit-shards' }
    const result = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    // Reverse row timestamps so shard ordering cannot accidentally follow insertion order or random ticket IDs.
    await f.pool.query(`update ci_runs set created_at=now() -
      (record->'partition'->>'index')::integer * interval '1 second'
      where id=any($1::uuid[]) and record->>'part'='unit-api'`,
    [result.partitions!.map(part => part.ticketId)])

    const denied = await f.connect(CI_RUN_ACTIONS)
    expect((await f.call(denied, 'ci_get', { ticketId: result.ticketId })).isError).toBe(true)
    const deniedCredential = await f.credential(CI_RUN_ACTIONS)
    const url = `/api/management/workspaces/${f.workspaceId}/ci/${result.ticketId}`
    const deniedResponse = await f.app.inject({ method: 'GET', url,
      headers: { authorization: `Bearer ${deniedCredential.token}` } })
    expect(deniedResponse.statusCode).toBe(403)

    const mcp = await f.waitFor(f.operator, result.ticketId, output => output.partitions!.some(run =>
      run.state === 'running') && output.partitions!.every(run =>
      run.state === 'queued' && run.message !== null || run.observation?.status === 'available'))
    const credential = await f.credential(CI_GET_ACTIONS)
    const response = await f.app.inject({ method: 'GET', url,
      headers: { authorization: `Bearer ${credential.token}` } })
    expect(response.statusCode, response.body).toBe(200)
    const http = CiGetOutputSchema.parse(response.json())
    const expected = Array.from({ length: 12 }, (_, index) => ({ index, count: 12 }))
    for (const read of [mcp, http]) {
      expect(read.partitions!.filter(part => part.part === 'unit-api').map(part => part.partition)).toEqual(expected)
      const stored = (await f.pool.query('select record from ci_runs where group_id=$1', [read.run.groupId])).rows
      expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
      expect(new Set(read.partitions!.map(part => part.id)))
        .toEqual(new Set(result.partitions!.map(part => part.ticketId)))
    }
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(result)
  } finally { await f.close() }
})
