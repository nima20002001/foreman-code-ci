import { expect, it } from 'vitest'
import { OperatorConfigurationVersionSchema, SendOperatorMessageRequestSchema, SessionPreferencesSchema } from '@foreman-code/contracts'
import { WorkerConversationRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { ConversationRow } from '../conversations/operatorChatRepository.js'
import { workerConversationFixture } from '../conversations/workerFixtures.test-support.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { prepareOperatorChatInput } from './chatInputPreparation.js'

const database: SqlQuery = { query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }) }

it.each([false, true])('prepares the accepted Operator Worker envelope with an existing session: %s', async active => {
  const fixture = workerConversationFixture('operator')
  const configuration = OperatorConfigurationVersionSchema.parse(fixture.configuration)
  const binding = { ...fixture.binding, appMcpAccess: 'scoped' as const }
  const row = { id: binding.owner.conversationId, worker_conversation_binding: binding,
    harness: 'codex', native_session_id: active ? fixture.session.nativeSessionId : null,
    provider_version: active ? fixture.session.providerVersion : null } as ConversationRow
  const request = SendOperatorMessageRequestSchema.parse({ requestId: 'prepared-input', content: 'Accepted prompt' })
  const prepared = await prepareOperatorChatInput(database, async () => binding.workingDirectory)({
    principalId: 'principal', conversationId: row.id, configuration, request, row,
    prompt: 'Accepted prompt', workingDirectory: binding.workingDirectory,
    settings: { sessionMode: 'regular', sessionPreferences: SessionPreferencesSchema.parse({}), profileKey: configuration.contentHash },
  })
  expect(prepared.prompt).toBe('Accepted prompt')
  expect(prepared.workerFrames).toHaveLength(1)
  const frame = WorkerConversationRpcRequestSchema.parse(prepared.workerFrames![0])
  expect(frame).toMatchObject({ method: active ? 'conversation.start-turn' : 'conversation.initial-turn',
    binding, prompt: 'Accepted prompt', correlationId: `operator:${row.id}:prepared-input`,
    preferences: SessionPreferencesSchema.parse({}), sessionMode: 'regular' })
  if (frame.method === 'conversation.initial-turn') {
    expect(frame.configuration).toEqual(configuration)
    expect(frame.applicationAccess).toMatchObject({ kind: 'operator-chat-mcp', token: expect.any(String) })
  } else if (frame.method === 'conversation.start-turn') expect(frame.session).toEqual(fixture.session)
})

it.each([true, false])('prepares the Claude access transition for attachment input: %s', async attachments => {
  const fixture = workerConversationFixture('operator', 'claude')
  const configuration = OperatorConfigurationVersionSchema.parse(fixture.configuration)
  const binding = { ...fixture.binding, appMcpAccess: attachments ? 'scoped' as const : 'none' as const }
  const row = { id: binding.owner.conversationId, worker_conversation_binding: binding,
    harness: 'claude', native_session_id: fixture.session.nativeSessionId,
    provider_version: fixture.session.providerVersion } as ConversationRow
  const request = SendOperatorMessageRequestSchema.parse({ requestId: 'access-transition', content: 'Continue',
    attachments: attachments ? [{ fileId: 'file', revisionId: 'revision' }] : [] })
  const prepared = await prepareOperatorChatInput(database, async () => binding.workingDirectory)({
    principalId: 'principal', conversationId: row.id, configuration, request, row,
    prompt: 'Continue', workingDirectory: binding.workingDirectory,
    settings: { sessionMode: 'regular', sessionPreferences: SessionPreferencesSchema.parse({}), profileKey: configuration.contentHash },
  })
  expect(WorkerConversationRpcRequestSchema.parse(prepared.workerFrames![0])).toMatchObject({
    method: 'conversation.start-turn', session: fixture.session,
    binding: { ...binding, appMcpAccess: attachments ? 'none' : 'scoped' },
  })
})

it('prepares a Worker steer using the locked active turn when the caller omits an expectation', async () => {
  const fixture = workerConversationFixture('operator')
  const configuration = OperatorConfigurationVersionSchema.parse(fixture.configuration)
  const binding = { ...fixture.binding, appMcpAccess: 'scoped' as const }
  const row = { id: binding.owner.conversationId, worker_conversation_binding: binding,
    harness: 'codex', native_session_id: fixture.session.nativeSessionId,
    provider_version: fixture.session.providerVersion, active_native_turn_id: 'owner-locked-turn' } as ConversationRow
  const request = SendOperatorMessageRequestSchema.parse({ requestId: 'steer-input', content: 'Focus here', intent: 'steer' })
  const prepared = await prepareOperatorChatInput(database, async () => binding.workingDirectory)({
    principalId: 'principal', conversationId: row.id, configuration, request, row,
    prompt: 'Focus here', workingDirectory: binding.workingDirectory,
    settings: { sessionMode: 'regular', sessionPreferences: SessionPreferencesSchema.parse({}), profileKey: configuration.contentHash },
  })
  expect(WorkerConversationRpcRequestSchema.parse(prepared.workerFrames![0])).toMatchObject({
    method: 'conversation.steer', expectedTurnId: 'owner-locked-turn', session: fixture.session, binding,
  })
})
