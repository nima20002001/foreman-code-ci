import { randomUUID } from 'node:crypto'
import { CiRunOutputSchema, CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('recovers an agent ticket typo and a joined ticket through authenticated MCP reads', async () => {
  const f = await fixture({ agent: true })
  f.computers.splice(0)
  try {
    const input = { suite: 'integration', scope: 'full', partitions: 2, commit: 'c'.repeat(40) }
    const started = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', input))
    const shared = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(shared.joined).toBe(true)
    expect(shared.ticketId).toBe(started.ticketId)
    const typo = `${started.ticketId.slice(0, -1)}${started.ticketId.endsWith('0') ? '1' : '0'}`
    for (const client of [f.agent!, f.operator]) {
      for (const tool of ['ci_get', 'ci_logs_read']) {
        const result = await f.call(client, tool, { ticketId: typo })
        expect(result.isError).toBe(true)
        const { error } = JSON.parse((result.content as { text: string }[])[0]!.text)
        expect(error.code).toBe('CI_RUN_NOT_FOUND')
        expect(error.message).toContain(started.ticketId)
        expect(error.details.recentTickets).toEqual([expect.objectContaining({ ticketId: started.ticketId,
          suite: 'integration', scope: 'full', state: 'queued', createdAt: expect.any(String) })])
      }
    }
    const unrelated = await f.connect(CI_GET_ACTIONS)
    const result = await f.call(unrelated, 'ci_get', { ticketId: typo })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).error.details.recentTickets).toEqual([])
  } finally { await f.close() }
})

it('limits recent groups to five and matches both the principal and execution for initiators and joiners', async () => {
  const f = await fixture({ agent: true })
  f.computers.splice(0)
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', {
      suite: 'integration', scope: 'full', commit: 'c'.repeat(40),
    }))
    const template = CiRunRecordSchema.parse((await f.pool.query<{ record: unknown }>(
      'select record from ci_runs where id=$1', [started.ticketId])).rows[0]!.record)
    const insert = async (initiator: CiRunRecord['initiator'], minute: number) => {
      const record = { ...template, id: randomUUID(), groupId: randomUUID(), initiator }
      const createdAt = new Date(Date.now() + minute * 60_000).toISOString()
      await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,created_at)
        values($1,$2,$3,$4,$5::jsonb,$6)`,
      [record.id, f.workspaceId, record.groupId, record.state, JSON.stringify(record), createdAt])
      return record
    }
    const owned = []
    for (let minute = 1; minute <= 6; minute++) owned.push(await insert(template.initiator, minute))
    const otherExecution = { ...template.initiator, executionId: 'other-execution' }
    const otherPrincipal = { ...template.initiator, principalId: 'other-principal' }
    await insert(otherExecution, 10)
    await insert(otherPrincipal, 11)
    const joined = await insert({ principalId: 'other-principal', executionId: null }, 7)
    const join = async (record: CiRunRecord, requester: CiRunRecord['initiator']) => {
      await f.pool.query(`insert into ci_group_requesters(group_id,workspace_id,principal_id,execution_id,initiator)
        values($1,$2,$3,$4,false)`, [record.groupId, f.workspaceId, requester.principalId, requester.executionId])
    }
    await join(joined, template.initiator)
    await join(await insert({ principalId: 'unrelated-principal', executionId: null }, 12), otherExecution)
    await join(await insert({ principalId: 'unrelated-principal', executionId: null }, 13), otherPrincipal)
    // A second partition and a requester row must not turn one group into multiple hints.
    const sibling = { ...owned[5]!, id: randomUUID(), state: 'running' }
    await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,created_at)
      values($1,$2,$3,$4,$5::jsonb,$6)`, [sibling.id, f.workspaceId, sibling.groupId, sibling.state,
      JSON.stringify(sibling), new Date(Date.now() + 6 * 60_000).toISOString()])
    await join(owned[5]!, template.initiator)
    const result = await f.call(f.agent!, 'ci_get', { ticketId: randomUUID() })
    expect(result.isError).toBe(true)
    const { error } = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(error.details.recentTickets.map((ticket: { ticketId: string }) => ticket.ticketId))
      .toEqual([joined.id, ...owned.slice(2).reverse().map(record => record.id)])
    expect(error.details.recentTickets[1].state).toBe('running')
  } finally { await f.close() }
})
