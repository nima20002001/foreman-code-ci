import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'

describe.skipIf(!postgresEnabled)('conversation snapshot consistency', () => {
  it('reads conversation and activity from one snapshot across a concurrent committed update', async () => {
    const database = await currentDatabase()
    const graph = await graphFixture(database, { form: 'single' })
    try {
      const node = agentWorkflowNode(graph.version.definition.nodes[0])
      const context = { workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId,
        workflowNodeId: node.id, agentId: node.agentId }
      const repository = new PostgresAgentChatRepository(database.pool)
      const conversation = await repository.ensureForControls(agentChatKey(context), {
        context, agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId]!,
        harness: 'codex', origin: { kind: 'fresh' }, workingDirectory: database.directory,
        runtimeDirectory: database.directory,
      }, async () => {})
      await repository.admit({ key: agentChatKey(context), context, delivery: 'queued', request: {
        requestId: 'request', content: 'Input', attachments: [], intent: 'next_turn',
        expectedConversationId: conversation.id,
        context: { workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId },
      } })
      expect(await repository.claim(conversation.id, 'request')).toBe(true)
      await repository.bindSession(conversation.id, '0.154.0', 'session')
      expect(await repository.accepted(conversation.id, 'request', 'turn')).toBe(true)
      const activity = new PostgresOperatorActivityRepository(database.pool)
      const item = { id: 'tool', requestId: 'request', kind: 'tool' as const, title: 'Original', status: 'running' as const }
      const fence = { nativeSessionId: 'session', nativeTurnId: 'turn' }
      expect(await activity.append(conversation.id, 'request', item,
        { ...fence, source: { eventId: 'started', sequence: '1' } })).toBeDefined()
      const before = (await repository.state(conversation.id))!
      let interleaved = false
      const pool = new Proxy(database.pool, {
        get(target, property) {
          if (property === 'connect') return async () => {
            const client = await target.connect()
            const query = client.query.bind(client)
            return new Proxy(client, {
              get(connection, member) {
                if (member === 'query') return async (...args: unknown[]) => {
                  const result = await Reflect.apply(query, connection, args) as pg.QueryResult
                  if (!interleaved && result.rows.some(row => row.id === conversation.id && row.agent_key)) {
                    interleaved = true
                    expect(await activity.append(conversation.id, 'request',
                      { ...item, title: 'Updated', status: 'completed' },
                      { ...fence, source: { eventId: 'finished', sequence: '2' } })).toBeDefined()
                  }
                  return result
                }
                const value: unknown = Reflect.get(connection, member)
                return typeof value === 'function' ? value.bind(connection) : value
              },
            })
          }
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const snapshot = (await new PostgresAgentChatRepository(pool).state(conversation.id))!
      expect(interleaved).toBe(true)
      expect(snapshot).toEqual(before)
      const after = (await repository.state(conversation.id))!
      expect(Number(after.row.revision)).toBeGreaterThan(Number(before.row.revision))
      expect(after.activityPage.activities).toContainEqual(expect.objectContaining({ title: 'Updated', status: 'completed' }))
    } finally {
      await graph.app.close()
      await database.close()
    }
  }, 60_000)
})
