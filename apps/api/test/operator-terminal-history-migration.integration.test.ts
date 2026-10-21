import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { operatorTerminalHistoryMigration } from '../src/infrastructure/operatorTerminalHistoryMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
beforeAll(async () => {
  db = await currentDatabase({ beforeMigration: operatorTerminalHistoryMigration.version })
}, 60_000)
afterAll(async () => { await db?.close() })

it('upgrades cached terminal history without changing accepted input or permitting early settlement', async () => {
  const operator = await new PostgresOperatorRepository(db.pool).ensure()
  const owner = await new PostgresAccessService(db.pool).issue({ name: 'History migration owner',
    audience: 'operator', grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
    expiresAt: new Date(Date.now() + 300_000) })
  const repository = new PostgresOperatorConversationRepository(db.pool)
  const conversation = await repository.create(operator.operator.id, operator.configuration, owner.principal.id)
  const requestId = randomUUID()
  const input = { content: 'Accepted input', ownerPrincipalId: owner.principal.id }
  const history = { correlationId: `operator:${conversation.id}:${requestId}`,
    events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' as const } }
  const observation = { result: { outcome: 'succeeded' }, retryable: false,
    requiresRuntimeClosure: false, nativeSessionId: null }
  await db.pool.query(`insert into operator_conversation_turns
    (conversation_id,request_id,payload,input_hash,terminal_observation,native_closure_state)
    values ($1,$2,$3::jsonb,$4,$5::jsonb,'closed')`, [conversation.id, requestId,
    JSON.stringify({ ...input, terminalHistory: history, terminalHistoryPersisted: false }),
    'retained-input-hash', JSON.stringify(observation)])
  await db.pool.query(`update operator_conversations set active_request_id=$2,active_phase='accepted'
    where id=$1`, [conversation.id, requestId])
  await applyApplicationMigrations(db.pool)
  await applyApplicationMigrations(db.pool)
  const receipt = async () => (await db.pool.query(`select input_hash,payload from operator_conversation_turns
    where conversation_id=$1 and request_id=$2`, [conversation.id, requestId])).rows[0]
  expect(await receipt()).toEqual({ input_hash: 'retained-input-hash', payload: input })
  expect(await repository.terminal(conversation.id, requestId)).toMatchObject({
    history, historyPersisted: false, closureState: 'closed',
  })
  await expect(repository.finish(conversation.id, requestId, { outcome: 'succeeded' }))
    .rejects.toMatchObject({ code: 'OPERATOR_CLOSURE_PENDING' })
  expect(await repository.terminalHistoryPersisted(conversation.id, requestId)).toBe(true)
  expect(await repository.finish(conversation.id, requestId, { outcome: 'succeeded' })).toBe(true)
  expect(await receipt()).toEqual({ input_hash: 'retained-input-hash', payload: input })
})
