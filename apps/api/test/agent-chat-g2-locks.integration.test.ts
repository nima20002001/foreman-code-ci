import { migratedDatabase } from './helpers/migratedDatabase.js'
import { readUntil } from './helpers/observableCondition.js'
import { AgentHarnessSchema } from '@foreman-code/contracts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

/** Real, independent PostgreSQL sessions. No app server, HTTP transport or native provider.
 * The shared helper owns a separate migrated database on the disposable loopback server. */
describe.skipIf(!postgresEnabled)('G2 A2-PF-06: acknowledgement / unknown PostgreSQL lock interleavings', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  let seeded: ReturnType<typeof makeCurrentWorkflowFixture>
  beforeAll(async () => {
    database = await migratedDatabase()
    seeded = await seedAgent3(database.pool, database.directory, makeCurrentWorkflowFixture(`g2-${randomUUID()}`, 'single'), { run: false })
  })
  beforeEach(async () => {
    await database.pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [seeded.scope.workspaceId])
  })
  afterAll(async () => { await database?.close() })

  async function setup(steer: boolean) {
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find((entry) => entry.agentId === node.agentId)!
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const repository = new PostgresAgentChatRepository(database.pool)
    const admitted = await repository.admit({ key: agentChatKey(context), context, delivery: 'queued',
      request: { requestId: 'A', content: 'G2 synthetic A', context: query, intent: 'next_turn', expectedConversationId: null },
      create: { context, agentConfigurationVersionId: configuration.id, harness: AgentHarnessSchema.parse(configuration.harness.harness),
        origin: { kind: 'fresh' }, workingDirectory: database.directory, runtimeDirectory: database.directory } })
    const id = admitted.conversationId
    assert.equal(await repository.claim(id, 'A'), true)
    // These are inert test identifiers, not a claim of a real native session.
    await repository.bindSession(id, 'g2-test-provider', 'g2-test-session')
    if (steer) {
      await repository.accepted(id, 'A', 'native-A')
      await repository.admit({ key: agentChatKey(context), context, delivery: 'submitting', targetNativeTurnId: 'native-A',
        request: { requestId: 'steer-A', content: 'G2 synthetic steer', context: query, intent: 'steer', expectedNativeTurnId: 'native-A', expectedConversationId: id } })
    }
    await repository.requestCancel(id, 'A')
    return { repository, id, requestId: steer ? 'steer-A' : 'A' }
  }

  /** Reserve one physical session per operation. The production repository still owns
   * BEGIN/COMMIT/ROLLBACK; only final client release is deferred to the test's finally. */
  function onClient(client: pg.PoolClient, afterQuery?: (sql: string) => Promise<void>) {
    return new PostgresAgentChatRepository({ connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values)
        await afterQuery?.(sql.replace(/\s+/g, ' ').trim())
        return result
      },
      release() {},
    }) } as unknown as pg.Pool)
  }
  async function waitForBlocker(blocker: number, blocked: number) {
    await readUntil(async () => {
      const result = await database.pool.query<{ blocked: boolean }>(
        'select $1::int = any(pg_blocking_pids($2::int)) as blocked', [blocker, blocked],
      )
      return result.rows[0]?.blocked ?? false
    }, value => value, { timeoutMs: 2000, description: 'the second PostgreSQL session waiting on the first' })
      .catch((error: unknown) => { assert.fail(error instanceof Error ? error : String(error)) })
  }

  for (const steer of [false, true]) {
    for (const firstOperation of ['acknowledgement', 'unknown'] as const) {
      it(`${steer ? 'steer' : 'turn'}: ${firstOperation} holds its first lock while the other operation enters`, async () => {
        const f = await setup(steer)
        const firstClient = await database.pool.connect(), secondClient = await database.pool.connect()
        const held = deferred(), release = deferred()
        const pending: Promise<unknown>[] = []
        let firstLock = true
        try {
          const firstPid = (await firstClient.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          const secondPid = (await secondClient.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          const first = onClient(firstClient, async (sql) => {
            // On the broken head unknown() first locks the receipt; on the fixed head
            // both paths first lock the conversation. Exercise either ordering faithfully.
            if (firstLock && (sql.endsWith('for update') || sql.startsWith('update operator_conversation_turns '))) {
              firstLock = false; held.resolve(); await release.promise
            }
          })
          const second = onClient(secondClient)
          const acknowledge = (repository: PostgresAgentChatRepository) => steer
            ? repository.steerAccepted(f.id, f.requestId, 'native-A') : repository.accepted(f.id, f.requestId, 'native-A')
          const unknown = (repository: PostgresAgentChatRepository) => repository.unknown(f.id, f.requestId, 'G2 uncertain transport')
          const firstTask = firstOperation === 'acknowledgement' ? acknowledge(first) : unknown(first)
          pending.push(firstTask); void firstTask.catch(() => undefined)
          await Promise.race([held.promise, firstTask.then(() => { throw new Error('The first transaction never acquired a tested lock') })])
          const secondTask = firstOperation === 'acknowledgement' ? unknown(second) : acknowledge(second)
          pending.push(secondTask); void secondTask.catch(() => undefined)
          // No sleep-based guess: PostgreSQL must report the second backend blocked by
          // the first. Releasing now forms a cycle on the old receipt→conversation path.
          await waitForBlocker(firstPid, secondPid)
          release.resolve()
          const results = await Promise.allSettled(pending)
          for (const result of results) {
            if (result.status === 'rejected') throw result.reason
          }
          // Unknown can mean missing settlement evidence even after acceptance. A later
          // positive ACK must still repair it, with exact native/cancellation ownership.
          await acknowledge(f.repository)
          const receipt = await f.repository.turn(f.id, f.requestId), row = await f.repository.get(f.id)
          assert.equal(receipt?.delivery, 'accepted')
          assert.equal(receipt?.nativeTurnId, 'native-A')
          assert.equal(receipt?.error, undefined)
          assert.equal(row?.active_request_id, 'A')
          assert.equal(row?.active_native_turn_id, 'native-A')
          assert.equal(row?.cancel_requested, true)
          assert.equal(row?.record.startupDelivered, true)
        } finally {
          release.resolve()
          await Promise.allSettled(pending)
          await firstClient.query('rollback').catch(() => undefined)
          await secondClient.query('rollback').catch(() => undefined)
          firstClient.release(); secondClient.release()
        }
      })
    }
  }
})
