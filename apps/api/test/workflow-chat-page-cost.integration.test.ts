import { describe, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { readWorkflowNativeChat } from '../src/modules/interactions/workflowChatNativeRead.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('bounded workflow native chat reads', () => {
  it('reads recent and older pages without visiting the full retained transcript', async () => {
    const f = await currentOperatorIntegration({ executionChat: true, approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id)
      const execution = (await f.runs.listRepeatExecutions(f.f.run.id))[0]!.execution
      const target = await workflowChatTarget(f, execution.workflowNodeId, execution.id)
      await f.db.pool.query(`insert into harness_native_events(execution_id,sequence,record)
        select $1,100+n,jsonb_build_object('sequence',100+n,'occurredAt',clock_timestamp(),
          'type','item.completed','payload',jsonb_build_object('threadId',$2::text,'turnId','retained-turn',
            'item',jsonb_build_object('id','message-'||n,'type','agentMessage','text','Reply '||n)))
        from generate_series(1,8000) n`, [execution.id, execution.nativeSessionId])
      await f.db.pool.query('analyze harness_native_events')
      await withTransaction(f.db.pool, async sql => {
        const visited = async () => Number((await sql.query<{ count: string }>(
          'select coalesce(sum(seq_tup_read+idx_tup_fetch),0)::text as count from pg_stat_xact_user_tables')).rows[0]!.count)
        const before = await visited()
        const recent = await readWorkflowNativeChat(sql, target, { limit: 2, bindings: [] })
        const firstCost = await visited() - before
        // Database tuple visits measure work, independent of the shared runner's timing and cache warmth.
        expect(firstCost).toBeLessThan(256)
        expect(recent.messages.map(message => message.content)).toEqual(['Reply 7999', 'Reply 8000'])
        expect(recent.hasMore).toBe(true)
        const next = await readWorkflowNativeChat(sql, target, { limit: 2, bindings: [], cursor: recent.nextCursor! })
        const totalCost = await visited() - before
        expect(next.messages.map(message => message.content)).toEqual(['Reply 7997', 'Reply 7998'])
        expect(totalCost).toBeLessThan(512)
      })
    } finally { await f.close() }
  }, 60_000)
})
