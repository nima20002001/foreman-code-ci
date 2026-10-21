import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS, OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { messageAttachmentIdentity } from '@foreman-code/contracts/files'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'

import { acceptedOperatorFileInputs, adoptOperatorFilePublications, operatorTurnHasFileInputs, recordOperatorFileSubmission } from '../src/modules/harnesses/operatorFiles/postgres.js'

const conversationId = 'operator-conversation-a', requestId = 'operator-request-a'
const ref = { fileId: 'file-a', revisionId: 'revision-a' }
const now = '2026-09-28T00:00:00.000Z'
const configuration = OperatorConfigurationVersionSchema.parse({
  id: 'operator-configuration-a', operatorId: 'application-operator', version: 1,
  harness: DEFAULT_HARNESS_DEFAULTS.codex,
  showThinking: false, contentHash: `sha256:${'a'.repeat(64)}`, createdAt: now,
})
const message = { id: 'message-a', conversationId, requestId, role: 'user', content: '', createdAt: now,
  attachmentRefs: [ref] }
function queryPool(rows: unknown[], rowCount = rows.length) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount })
  return { pool: { query } as unknown as pg.Pool, query }
}
function admissionRow() {
  return { owner_principal_id: 'owner-a', operator_id: configuration.operatorId,
    operator_configuration_version_id: configuration.id, native_session_id: 'session-a', provider_version: '0.154.0', harness: 'codex',
    active_request_id: requestId, active_native_turn_id: null, active_phase: 'submitting', cancel_requested: false,
    request_id: requestId, native_turn_id: null, turn_message_id: null, accepted_configuration_id: configuration.id,
    payload: { attachmentIdentity: messageAttachmentIdentity({ requestId, attachments: [ref] }) },
    message_id: message.id, message_record: message, configuration_record: configuration }
}

describe('AF-02 Operator file admission rejects mixed identity before file authority', () => {
  it('keeps old text-only cleanup receipts independent of configuration pins and file storage', async () => {
    const { pool, query } = queryPool([{ payload: { content: 'old text' }, message_record: { ...message, content: 'old text', attachmentRefs: [] } }])
    expect(await operatorTurnHasFileInputs(pool, conversationId, requestId)).toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('selects file-only mode from a durable attachment receipt, including attachment-only content', async () => {
    const { pool } = queryPool([{ payload: admissionRow().payload, message_record: message }])
    expect(await operatorTurnHasFileInputs(pool, conversationId, requestId)).toBe(true)
  })
  it.each([
    { payload: {}, message_record: message },
    { payload: admissionRow().payload, message_record: { ...message, attachmentRefs: [] } },
    { payload: admissionRow().payload, message_record: null },
  ])('never downgrades an inconsistent file receipt to management chat: %j', async (row) => {
    const { pool } = queryPool([row])
    await expect(operatorTurnHasFileInputs(pool, conversationId, requestId)).rejects.toMatchObject({ code: 'OPERATOR_FILE_ADMISSION_MISMATCH' })
  })
  it('does not infer file mode from a missing receipt', async () => {
    const { pool } = queryPool([])
    await expect(operatorTurnHasFileInputs(pool, conversationId, requestId)).rejects.toMatchObject({ code: 'OPERATOR_FILE_ADMISSION_NOT_FOUND' })
  })
  it('rejects Agent/foreign correlations without querying an Operator receipt', async () => {
    const { pool, query } = queryPool([])
    for (const correlation of [`agent-chat:${conversationId}:${requestId}`, nativeCorrelation('another-operator-chat', requestId)]) {
      await expect(acceptedOperatorFileInputs(pool, conversationId, correlation, configuration, 'session-a'))
        .rejects.toMatchObject({ code: 'OPERATOR_FILE_ADMISSION_MISMATCH' })
    }
    expect(query).not.toHaveBeenCalled()
  })
  it.each([
    { active_request_id: 'different-request' },
    { active_phase: 'ready' },
    { cancel_requested: true },
    { native_session_id: 'another-native-session' },
    { operator_configuration_version_id: 'different-configuration' },
    { turn_message_id: 'foreign-message' },
    { payload: { attachmentIdentity: 'different-attachment-pins' } },
  ])('rejects a changed accepted binding before owner/token lookup: %j', async (change) => {
    const { pool, query } = queryPool([{ ...admissionRow(), ...change }])
    await expect(acceptedOperatorFileInputs(pool, conversationId, nativeCorrelation(conversationId, requestId), configuration, 'session-a'))
      .rejects.toMatchObject({ code: 'OPERATOR_FILE_ADMISSION_MISMATCH' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('requires durable native/message acknowledgement before a file session can be activated', async () => {
    const refused = queryPool([], 0)
    await expect(recordOperatorFileSubmission(refused.pool, conversationId, requestId, 'turn-a'))
      .rejects.toMatchObject({ code: 'OPERATOR_FILE_SUBMISSION_MISMATCH' })
    const accepted = queryPool([], 1)
    await expect(recordOperatorFileSubmission(accepted.pool, conversationId, requestId, 'turn-a')).resolves.toBeUndefined()
    const [, bindings] = accepted.query.mock.calls[0]!
    expect(bindings).toEqual([conversationId, requestId, 'turn-a'])
  })
  it('refuses publication adoption for Agent scope or a substituted Operator owner before a DB checkout', async () => {
    const context: FileToolContext = { ownerPrincipalId: 'owner-a', nativeSessionId: 'session-a', turnId: 'turn-a', messageId: message.id,
      allowMutation: true, allowedTools: ['files.publish_result'],
      scope: { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner-b', operatorId: configuration.operatorId, conversationId } } }
    const connect = vi.fn()
    const pool = { connect } as unknown as pg.Pool
    await expect(adoptOperatorFilePublications(pool, context)).rejects.toMatchObject({ code: 'OPERATOR_FILE_ADOPTION_MISMATCH' })
    await expect(adoptOperatorFilePublications(pool, { ...context,
      scope: { kind: 'temporary', chat: { kind: 'agent', conversationId, agentId: 'agent-a', workspaceId: 'workspace-a', workflowId: 'workflow-a' } } }))
      .rejects.toMatchObject({ code: 'OPERATOR_FILE_ADOPTION_MISMATCH' })
    expect(connect).not.toHaveBeenCalled()
  })
  it('closes a pre-ACK input-only turn without inventing a native acknowledgement', async () => {
    const context: FileToolContext = { ownerPrincipalId: 'owner-a', nativeSessionId: 'session-a', turnId: 'not-acknowledged', messageId: message.id,
      allowMutation: false, allowedTools: ['files.read'],
      scope: { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner-a', operatorId: configuration.operatorId, conversationId } } }
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const release = vi.fn()
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool
    await expect(adoptOperatorFilePublications(pool, context)).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(1)
  })

})
