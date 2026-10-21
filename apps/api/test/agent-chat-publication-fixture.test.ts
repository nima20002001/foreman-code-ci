import { describe, expect, it } from 'vitest'
import { F1Store } from './helpers/agentChatF1.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { readConversationPublicationReceipts } from '../src/modules/conversations/messagePublications.js'
import { readClaudeMessagePublications } from '../src/modules/harnesses/claudeSdk/publications.js'

function seeded() {
  const store = new F1Store(), now = new Date()
  store.row.harness = 'claude'
  const receipt = { request_id: 'accepted-request', turn_sequence: '1', intent: 'next_turn' as const,
    delivery: 'completed' as const, message_id: 'accepted-message', native_turn_id: null, target_native_turn_id: null,
    delivery_error: null, input_hash: 'original-hash', created_at: now, updated_at: now,
    payload: { content: 'original input', ownerPrincipalId: 'original-sender', nativeSubmission: { kind: 'message',
      nativeSessionId: 'observed-session', nativeMessageId: 'observed-message', clientCorrelationId: 'accepted-correlation' } } }
  store.turns.set(receipt.request_id, receipt)
  store.messages.set(receipt.message_id, { id: receipt.message_id, conversationId: store.row.id,
    requestId: receipt.request_id, role: 'user', content: receipt.payload.content, createdAt: now.toISOString() })
  const binding = bindingIdentity({ ownerPrincipalId: receipt.payload.ownerPrincipalId,
    nativeSessionId: receipt.payload.nativeSubmission.nativeSessionId, nativeMessageId: receipt.payload.nativeSubmission.nativeMessageId,
    messageId: receipt.message_id, allowMutation: false, allowedTools: [], scope: { kind: 'temporary', chat: { kind: 'agent',
      conversationId: store.row.id, agentId: store.row.agent_id, workspaceId: store.row.workspace_id, workflowId: store.row.workflow_id } } })
  const publication = { binding, owner_principal_id: receipt.payload.ownerPrincipalId, request_id: 'original-publication',
    file_id: 'output-file', revision_id: 'original-revision' }
  const allocation = { owner_principal_id: publication.owner_principal_id, request_id: publication.request_id,
    file_id: publication.file_id, revision_id: publication.revision_id, state: 'finalized' }
  const file = { owner_principal_id: publication.owner_principal_id, activity_record_revision: '23', state: 'deleted' }
  store.publications.push(publication); store.allocations.push(allocation); store.files.set(publication.file_id, file)
  const read = () => readConversationPublicationReceipts(store.pool, store.row.id, [receipt.message_id])
  return { store, receipt, publication, allocation, file, read }
}

describe('F1 exact Claude publication query fixture', () => {
  it('returns original finalized receipt evidence before message adoption, preserving independent file state', async () => {
    const f = seeded()
    expect(await f.read()).toEqual([{ receiptId: 'original-publication', messageId: 'accepted-message', fileId: 'output-file',
      fileRevisionId: 'original-revision', nativeSessionId: 'observed-session', nativeMessageId: 'observed-message',
      fileActivityRevision: '23', fileState: 'deleted' }])
    expect(await readClaudeMessagePublications(f.store.pool, f.store.row.id, [f.receipt.message_id])).toEqual(
      new Map([['accepted-message', [{ fileId: 'output-file', revisionId: 'original-revision' }]]]))
    expect(f.store.messages.get(f.receipt.message_id)).not.toHaveProperty('publicationRefs')
    expect(f.store.statements.every(({ sql }) => sql.startsWith('select'))).toBe(true)
  })
  it.each(['owner', 'request', 'file', 'revision', 'state', 'fileOwner', 'binding'] as const)('does not fabricate receipts when %s mismatches', async fault => {
    const f = seeded()
    if (fault === 'owner') f.allocation.owner_principal_id = 'other-owner'
    if (fault === 'request') f.allocation.request_id = 'other-request'
    if (fault === 'file') f.allocation.file_id = 'other-file'
    if (fault === 'revision') f.allocation.revision_id = 'other-revision'
    if (fault === 'state') f.allocation.state = 'allocated'
    if (fault === 'fileOwner') f.file.owner_principal_id = 'other-owner'
    if (fault === 'binding') f.publication.binding = 'other-message-binding'
    expect(await f.read()).toEqual([])
  })
  it.each(['codex', 'deleted', 'steer', 'missingMessage', 'assistant', 'otherConversation', 'otherRequest', 'missingOwner', 'wrongKind', 'missingSession', 'missingNativeMessage', 'missingCorrelation'] as const)(
    'does not admit a Claude publication candidate for %s', async fault => {
      const f = seeded(), message = f.store.messages.get(f.receipt.message_id)!
      if (fault === 'codex') f.store.row.harness = fault
      if (fault === 'deleted') f.store.row.deleted_at = new Date()
      if (fault === 'steer') f.store.turns.get(f.receipt.request_id)!.intent = 'steer'
      if (fault === 'missingMessage') f.store.messages.clear()
      if (fault === 'assistant') message.role = 'assistant'
      if (fault === 'otherConversation') message.conversationId = 'other-conversation'
      if (fault === 'otherRequest') message.requestId = 'other-request'
      if (fault === 'missingOwner') delete f.store.turns.get(f.receipt.request_id)!.payload.ownerPrincipalId
      if (fault === 'wrongKind') f.receipt.payload.nativeSubmission.kind = 'turn'
      if (fault === 'missingSession') f.receipt.payload.nativeSubmission.nativeSessionId = ''
      if (fault === 'missingNativeMessage') f.receipt.payload.nativeSubmission.nativeMessageId = ''
      if (fault === 'missingCorrelation') f.receipt.payload.nativeSubmission.clientCorrelationId = ''
      expect(await f.read()).toEqual([])
      expect(f.store.statements.some(({ sql }) => sql.includes('from file_tool_publications p'))).toBe(false)
    })
  it('keeps unsupported SQL visible rather than returning generic empty rows', async () => {
    const store = new F1Store()
    await expect(store.pool.query('select * from file_tool_publications')).rejects.toThrow('Unhandled F1 SQL')
  })
})
