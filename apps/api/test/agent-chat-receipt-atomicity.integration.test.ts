import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

describe('Agent chat receipt atomicity', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  let seeded: ReturnType<typeof makeCurrentWorkflowFixture>
  beforeAll(async () => {
    database = await migratedDatabase()
    seeded = await seedAgent3(database.pool, database.directory,
      makeCurrentWorkflowFixture(randomUUID(), 'single'), { run: false })
  }, 60_000)
  afterAll(async () => { await database?.close() })

  async function setup() {
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(entry => entry.agentId === node.agentId)!
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const repository = new PostgresAgentChatRepository(database.pool)
    const admitted = await repository.admit({ key: `${agentChatKey(context)}:${randomUUID()}`, context, delivery: 'queued',
      request: { requestId: 'application-request', content: 'Original prompt', context: query,
        intent: 'next_turn', expectedConversationId: null },
      create: { context, agentConfigurationVersionId: configuration.id, harness: 'codex', origin: { kind: 'fresh' },
        workingDirectory: database.directory, runtimeDirectory: database.directory } })
    const id = admitted.conversationId
    expect(await repository.claim(id, 'application-request')).toBe(true)
    await repository.bindSession(id, 'fixture-provider', `session-${id}`)
    return { id, repository }
  }

  async function snapshot(id: string) {
    return {
      conversation: await new PostgresAgentChatRepository(database.pool).get(id),
      turns: (await database.pool.query('select * from operator_conversation_turns where conversation_id=$1', [id])).rows,
      activities: (await database.pool.query('select * from operator_conversation_activity where conversation_id=$1 order by sequence', [id])).rows,
    }
  }

  it('rolls back receipt, activity, ownership and revision when the activity write fails', async () => {
    const { id, repository } = await setup()
    await repository.accepted(id, 'application-request', 'native-turn')
    await repository.pending(id, 'application-request', {
      session: { harness: 'codex', providerVersion: 'fixture-provider', nativeSessionId: `session-${id}` },
      turn: { nativeTurnId: 'native-turn', nativeRequestId: 'native-approval' },
      nativeRequestType: 'item/commandExecution/requestApproval', request: { command: 'check' },
      responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE,
    })
    await repository.requestCancel(id, 'application-request')
    await database.pool.query(`insert into operator_conversation_activity(conversation_id,request_id,activity_id,record)
      values($1,'application-request','tool',$2::jsonb)`, [id, JSON.stringify({ id: 'tool', requestId: 'application-request', kind: 'tool', title: 'Check', status: 'running' })])
    await database.pool.query(`alter table operator_conversation_activity add constraint reject_unknown_activity
      check (record->>'status'<>'unknown')`)
    const before = await snapshot(id)
    try {
      await expect(repository.unknown(id, 'application-request', 'Unconfirmed delivery'))
        .rejects.toMatchObject({ code: '23514', constraint: 'reject_unknown_activity' })
      expect(await snapshot(id)).toEqual(before)
    } finally {
      await database.pool.query('alter table operator_conversation_activity drop constraint reject_unknown_activity')
    }
    await repository.unknown(id, 'application-request', 'Unconfirmed delivery')
    expect(await repository.turn(id, 'application-request')).toMatchObject({ delivery: 'unknown', nativeTurnId: 'native-turn' })
    const after = await snapshot(id)
    expect(after.activities[0]).toMatchObject({ revision: '2', record: { status: 'unknown' } })
    expect(after.conversation).toMatchObject({ active_request_id: 'application-request', active_native_turn_id: 'native-turn',
      cancel_requested: true, turn_state: 'uncertain' })
    expect(BigInt(after.conversation!.revision)).toBeGreaterThan(BigInt(before.conversation!.revision))
  })

  it('persists the native turn identity and startup receipt together', async () => {
    const { id, repository } = await setup()
    expect(await repository.accepted(id, 'application-request', 'native-turn')).toBe(true)
    expect(await repository.turn(id, 'application-request')).toMatchObject({ delivery: 'accepted', nativeTurnId: 'native-turn' })
    expect(await repository.get(id)).toMatchObject({ active_request_id: 'application-request', active_native_turn_id: 'native-turn',
      record: { startupDelivered: true, startupReceipt: { requestId: 'application-request', nativeSessionId: `session-${id}` } } })
  })

  it('keeps acceptance and startup state unchanged when startup persistence fails', async () => {
    const { id, repository } = await setup()
    await database.pool.query(`alter table operator_conversations add constraint reject_startup_delivery
      check (id<> '${id}' or record->>'startupDelivered' is distinct from 'true')`)
    const before = await snapshot(id)
    try {
      await expect(repository.accepted(id, 'application-request', 'native-turn'))
        .rejects.toMatchObject({ code: '23514', constraint: 'reject_startup_delivery' })
      expect(await snapshot(id)).toEqual(before)
    } finally {
      await database.pool.query('alter table operator_conversations drop constraint reject_startup_delivery')
    }
  })
})
