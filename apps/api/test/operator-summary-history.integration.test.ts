import { expect, it, vi } from 'vitest'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

type Plan = { 'Rows Removed by Filter'?: number; Plans?: Plan[] }
function filteredRows(plan: Plan): number {
  return (plan['Rows Removed by Filter'] ?? 0) + (plan.Plans ?? []).reduce((sum, child) => sum + filteredRows(child), 0)
}

it('reads unresolved Operator summaries without scanning persisted completed or thinking activity', async () => {
  const database = await currentDatabase()
  const { pool } = database
  try {
    const access = new PostgresAccessService(pool)
    const owner = (await access.issue({ name: 'Summary owner', audience: 'operator',
      grants: [{ scope: {}, actions: ['operator_chat:read'] }],
      expiresAt: new Date(Date.now() + 60000) })).principal
    const { operator, configuration } = await new PostgresOperatorRepository(pool).ensure()
    const repository = new PostgresOperatorConversationRepository(pool)
    const conversations = []
    for (const title of ['Idle', 'Running', 'Unknown']) {
      const conversation = await repository.create(operator.id, configuration, owner.id, title)
      conversations.push(conversation)
      await repository.beginTurn(conversation.id, { requestId: 'history', content: `History for ${title}` }, owner.id)
      await repository.finish(conversation.id, 'history', { outcome: 'succeeded' })
      await pool.query(`insert into operator_conversation_activity(conversation_id,request_id,activity_id,record)
        select $1,'history',n::text,jsonb_build_object('id',n::text,'requestId','history',
          'kind',case when n%2=0 then 'thinking' else 'tool' end,
          'title','Historical activity','status',case when n%2=0 then 'running' else 'completed' end)
        from generate_series(1,6000) n`, [conversation.id])
    }
    for (const [index, status] of ['running', 'unknown'].entries()) {
      await pool.query(`insert into operator_conversation_activity(conversation_id,request_id,activity_id,record)
        values($1,'history','unresolved',$2::jsonb)`, [conversations[index + 1]!.id, JSON.stringify({
        id: 'unresolved', requestId: 'history', kind: 'tool', title: 'Unresolved tool', status,
      })])
    }
    await repository.create(operator.id, configuration, owner.id, 'Empty draft')
    await pool.query('analyze operator_conversation_activity')
    const observed = vi.spyOn(pool, 'query')
    let query: string
    let parameters: unknown[]
    try {
      const summaries = await repository.summaries(owner.id)
      expect(summaries.map(summary => [summary.title, summary.backgroundActivity]).sort()).toEqual([
        ['Idle', null], ['Running', 'running'], ['Unknown', 'unknown'],
      ])
      const call = observed.mock.calls[0]!
      query = call[0] as string
      parameters = call[1] as unknown[]
    } finally { observed.mockRestore() }
    const explained = await pool.query(`explain (analyze,buffers,format json) ${query}`, parameters)
    const plan = explained.rows[0]['QUERY PLAN'][0].Plan as Plan
    expect(filteredRows(plan)).toBeLessThan(100)
    expect((await pool.query('select count(*)::int as count from operator_conversation_activity')).rows[0].count)
      .toBe(18002)
  } finally { await database.close() }
})
