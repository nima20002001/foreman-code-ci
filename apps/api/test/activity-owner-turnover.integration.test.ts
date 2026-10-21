import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { deferred } from './helpers/deferred.js'
import { readUntil } from './helpers/observableCondition.js'

describe.skipIf(!postgresEnabled)('activity during native owner turnover', () => {
  it('rejects the predecessor callback after a concurrent turn change commits', async () => {
    const db = await currentDatabase()
    const graph = await graphFixture(db, { form: 'single' })
    const applicationName = `activity-append-${randomUUID()}`
    const appendPool = new pg.Pool({ ...db.pool.options, application_name: applicationName })
    const changed = deferred()
    const release = deferred()
    let turnover: Promise<unknown> | undefined
    let append: ReturnType<PostgresOperatorActivityRepository['append']> | undefined
    try {
      const node = agentWorkflowNode(graph.version.definition.nodes[0])
      const context = { workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId,
        workflowNodeId: node.id, agentId: node.agentId }
      const repository = new PostgresAgentChatRepository(db.pool)
      const conversation = await repository.ensureForControls(agentChatKey(context), {
        context, agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId]!,
        harness: 'codex', origin: { kind: 'fresh' }, workingDirectory: db.directory,
        runtimeDirectory: db.directory,
      }, async () => {})
      await repository.admit({ key: agentChatKey(context), context, delivery: 'queued', request: {
        requestId: 'request', content: 'Input', attachments: [], intent: 'next_turn',
        expectedConversationId: conversation.id,
        context: { workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId },
      } })
      expect(await repository.claim(conversation.id, 'request')).toBe(true)
      await repository.bindSession(conversation.id, '0.154.0', 'session')
      expect(await repository.accepted(conversation.id, 'request', 'predecessor')).toBe(true)
      const activity = new PostgresOperatorActivityRepository(appendPool)
      const before = await activity.page(conversation.id)
      turnover = withTransaction(db.pool, async sql => {
        await sql.query('update operator_conversations set active_native_turn_id=$2 where id=$1',
          [conversation.id, 'successor'])
        changed.resolve()
        await release.promise
      })
      await changed.promise
      append = activity.append(conversation.id, 'request', {
        id: 'late-tool', requestId: 'request', kind: 'tool', title: 'Stale callback', status: 'running',
      }, { nativeSessionId: 'session', nativeTurnId: 'predecessor',
        source: { eventId: 'late-event', sequence: '1' } })
      await readUntil(async () => (await db.pool.query<{ blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity where application_name=$1
          and cardinality(pg_blocking_pids(pid))>0) as blocked`, [applicationName])).rows[0]!.blocked,
      Boolean, { timeoutMs: 2000, description: 'activity callback waiting for owner turnover' })
      release.resolve()
      await turnover
      expect(await append).toBeUndefined()
      expect(await activity.page(conversation.id)).toEqual(before)
      expect((await repository.state(conversation.id))?.row.active_native_turn_id).toBe('successor')
    } finally {
      release.resolve()
      await Promise.allSettled([turnover, append])
      await appendPool.end()
      await graph.app.close()
      await db.close()
    }
  }, 60_000)
})
