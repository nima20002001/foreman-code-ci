import { randomUUID } from 'node:crypto'
import { CiCancelOutputSchema, CiGetOutputSchema, CiListOutputSchema, CiLogsOutputSchema,
  CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

const commit = 'c'.repeat(40)
const requesterActions = [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS]

async function tickets(f: Awaited<ReturnType<typeof fixture>>, workspaceId = f.workspaceId) {
  return (await f.pool.query<{ id: string; group_id: string; state: string }>(
    'select id,group_id,state from ci_runs where workspace_id=$1 order by id', [workspaceId])).rows
}

it('lets identical concurrent requests share one ticket group and read the same result through MCP', async () => {
  const f = await fixture()
  try {
    const tools = await f.operator.listTools()
    expect(tools.tools.find(tool => tool.name === 'ci_run')?.description).toMatch(/joined/)
    const other = await f.connect(requesterActions)
    const input = { suite: 'typecheck', commit }
    const [first, second] = await Promise.all([
      f.value(f.operator, 'ci_run', { ...input, commandId: 'first-requester' }),
      f.value(other, 'ci_run', { ...input, commandId: 'second-requester' }),
    ]).then(outputs => outputs.map(output => CiRunOutputSchema.parse(output)))
    expect(second!.ticketId).toBe(first!.ticketId)
    expect(second!.partitions).toEqual(first!.partitions)
    expect([first!.joined, second!.joined].filter(Boolean)).toEqual([true])
    expect([first!, second!].find(output => output.joined)!.sharedWith).toBe(1)
    const persisted = await tickets(f)
    expect(new Set(persisted.map(row => row.group_id)).size).toBe(1)
    expect(persisted.map(row => row.id).sort()).toEqual((first!.partitions ?? [first!]).map(ticket => ticket.ticketId).sort())

    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_run', { ...input, commandId: 'without-ci-grant' })).isError).toBe(true)
    expect(await tickets(f)).toHaveLength(persisted.length)
    expect(CiRunOutputSchema.parse(await f.value(other, 'ci_run', { ...input, commandId: 'second-requester' })))
      .toEqual(second)

    await f.ci.dispatch()
    await f.ci.drain()
    expect(f.started).toHaveLength(persisted.length)
    for (const { request } of f.started) {
      if (request.operation === 'start') f.finish(request.runId, 0, `${request.part ?? request.suite} passed\n`)
    }
    const wait = { ticketId: first!.ticketId, waitUntil: 'group-terminal', waitSeconds: 5, logTail: false }
    const [own, joined] = await Promise.all([f.value(f.operator, 'ci_get', wait), f.value(other, 'ci_get', wait)])
      .then(outputs => outputs.map(output => CiGetOutputSchema.parse(output)))
    expect(own!.wait?.status).toBe('settled')
    expect(own!.group?.state).toBe('passed')
    expect(joined!.group).toEqual(own!.group)
    expect(joined!.partitions).toEqual(own!.partitions)
    expect(own!.sharing?.requesters).toHaveLength(2)
    expect(own!.sharing?.requesters.every(requester => requester.active)).toBe(true)
    const logs = await Promise.all([f.operator, other].map(async client => CiLogsOutputSchema.parse(
      await f.value(client, 'ci_logs_read', { ticketId: first!.ticketId }))))
    expect(logs[1]!.text).toBe(logs[0]!.text)
    expect(logs[0]!.text).toMatch(/passed/)
  } finally { await f.close() }
})

it('does not share across workspaces, commits or suites', async () => {
  const f = await fixture()
  f.computers.splice(0)
  try {
    const otherWorkspace = randomUUID()
    await f.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [otherWorkspace, JSON.stringify({
      id: otherWorkspace, name: 'Other CI workspace',
      repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
    })])
    const elsewhere = await f.connect(requesterActions, { workspaceIds: [otherWorkspace] })
    const base = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commit, commandId: 'base' }))
    const outputs = [
      await f.value(elsewhere, 'ci_run', { workspaceId: otherWorkspace, suite: 'install', commit, commandId: 'workspace' }),
      await f.value(f.operator, 'ci_run', { suite: 'install', commit: 'd'.repeat(40), commandId: 'commit' }),
      await f.value(f.operator, 'ci_run', { suite: 'build', commit, commandId: 'suite' }),
    ].map(output => CiRunOutputSchema.parse(output))
    for (const output of outputs) {
      expect(output.ticketId).not.toBe(base.ticketId)
      expect(output.joined).toBeUndefined()
    }
    expect(await tickets(f, otherWorkspace)).toHaveLength(1)
    expect(new Set((await tickets(f)).map(row => row.group_id)).size).toBe(3)
  } finally { await f.close() }
})

it('detaches one requester on cancel and cancels the shared ticket once no requester remains', async () => {
  const f = await fixture()
  f.computers.splice(1)
  const canceled: string[] = []
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    const reply = await request(computer, input)
    if (input.operation === 'cancel') canceled.push(input.runId)
    return reply
  }
  try {
    const other = await f.connect(requesterActions)
    const input = { suite: 'install', commit }
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { ...input, commandId: 'cancel-first' }))
    const second = CiRunOutputSchema.parse(await f.value(other, 'ci_run', { ...input, commandId: 'cancel-second' }))
    expect(second).toMatchObject({ ticketId: first.ticketId, joined: true, sharedWith: 1 })
    await f.ci.dispatch()
    await f.ci.drain()
    expect(CiGetOutputSchema.parse(await f.value(other, 'ci_get', { ticketId: first.ticketId })).run.state).toBe('running')

    const detached = CiCancelOutputSchema.parse(await f.value(f.operator, 'ci_cancel', { ticketId: first.ticketId }))
    expect(detached.run.state).toBe('running')
    expect(detached.detached).toEqual({ remainingRequesters: 1 })
    await f.ci.dispatch()
    await f.ci.drain()
    expect(canceled).toEqual([])
    const kept = CiGetOutputSchema.parse(await f.value(other, 'ci_get', { ticketId: first.ticketId }))
    expect(kept.run.state).toBe('running')
    expect(kept.sharing?.requesters.filter(requester => requester.active)).toHaveLength(1)
    expect(CiCancelOutputSchema.parse(await f.value(f.operator, 'ci_cancel', { ticketId: first.ticketId })).run.state)
      .toBe('running')
    expect(canceled).toEqual([])

    const last = CiCancelOutputSchema.parse(await f.value(other, 'ci_cancel', { ticketId: first.ticketId }))
    expect(last.run.state).toBe('canceled')
    expect(last.detached).toBeUndefined()
    expect(canceled).toEqual([first.ticketId])
    expect((await tickets(f)).map(row => row.state)).toEqual(['canceled'])
  } finally { await f.close() }
})

it('keeps a shared group for the remaining requester when another requester moves to a newer commit', async () => {
  const older = 'a'.repeat(40)
  const newer = 'b'.repeat(40)
  const f = await fixture({ supersession: {
    branch: () => 'feature', isAncestor: (ancestor, descendant) => ancestor === older && descendant === newer,
  } })
  f.computers.splice(0)
  try {
    const other = await f.connect(requesterActions)
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commit: older, commandId: 'old-a' }))
    expect(CiRunOutputSchema.parse(await f.value(other, 'ci_run', { suite: 'install', commit: older, commandId: 'old-b' })))
      .toMatchObject({ ticketId: old.ticketId, joined: true })
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commit: newer, commandId: 'new-a' }))
    await f.ci.drain()
    const kept = CiGetOutputSchema.parse(await f.value(other, 'ci_get', { ticketId: old.ticketId }))
    expect(kept.run.state).toBe('queued')
    expect(kept.run.supersededBy).toBeUndefined()
    expect(kept.sharing?.requesters.filter(requester => requester.active)).toHaveLength(1)

    expect(CiRunOutputSchema.parse(await f.value(other, 'ci_run', { suite: 'install', commit: newer, commandId: 'new-b' })))
      .toMatchObject({ ticketId: next.ticketId, joined: true })
    await f.ci.dispatch()
    await f.ci.drain()
    expect(CiGetOutputSchema.parse(await f.value(other, 'ci_get', { ticketId: old.ticketId })).run)
      .toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: next.ticketId })).run.state).toBe('queued')
  } finally { await f.close() }
})

it('lists a joined group under the joining Agent execution of its Run', async () => {
  const f = await fixture({ agent: true })
  f.computers.splice(0)
  try {
    const input = { suite: 'install', commit: 'a'.repeat(40) }
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { ...input, commandId: randomUUID() }))
    const joined = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', { ...input, commandId: randomUUID() }))
    expect(joined).toMatchObject({ ticketId: first.ticketId, joined: true, sharedWith: 1 })
    const read = CiGetOutputSchema.parse(await f.value(f.agent!, 'ci_get', { ticketId: joined.ticketId }))
    const execution = read.sharing?.requesters.find(requester => requester.executionId !== null)
    expect(execution).toMatchObject({ initiator: false, active: true })
    const row = (await f.pool.query<{ run_id: string }>('select run_id from harness_executions where id=$1',
      [execution!.executionId])).rows[0]!
    const operator = await f.connect([...CI_GET_ACTIONS, 'runs:read'])
    const listed = CiListOutputSchema.parse(await f.value(operator, 'ci_list', { runId: row.run_id }))
    expect(listed.jobs).toEqual([expect.objectContaining({ ticketId: first.ticketId,
      requester: expect.objectContaining({ executionId: execution!.executionId }) })])
    expect(CiListOutputSchema.parse(await f.value(operator, 'ci_list', {
      runId: row.run_id, executionId: execution!.executionId,
    })).jobs).toHaveLength(1)
  } finally { await f.close() }
})
