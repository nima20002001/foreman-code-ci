import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { productionClaudeFileAdmission } from '../src/modules/harnesses/claudeSdk/fileProduction.js'
import type { ClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'

function fixture() {
  const context = { nativeSessionId: 'observed-session', nativeMessageId: 'observed-message', clientCorrelationId: 'accepted-correlation', generation: 'owned-generation' }
  const identity = { ...context, ownerPrincipalId: 'sender', attemptId: 'accepted-request', toolUseId: 'observed-root-tool' }
  const row = { kind: 'agent', workspace_id: 'workspace', owner_principal_id: null, sender_id: 'sender', native_session_id: context.nativeSessionId,
    active_request_id: identity.attemptId, cancel_requested: false, message_id: 'original-user-message', native_submission: {
      kind: 'message', nativeSessionId: context.nativeSessionId, nativeMessageId: context.nativeMessageId, clientCorrelationId: context.clientCorrelationId } }
  const principal = { id: 'sender', name: 'Sender', audience: 'operator', grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }],
    expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('join operator_conversation_turns t')) return { rows: [row] }
    if (sql.includes('from management_principals where id=')) return { rows: [principal] }
    if (sql.includes('select kind,id,owner_principal_id,operator_id')) return { rows: [{ kind: 'agent', id: 'conversation', workspace_id: 'workspace',
      workflow_id: 'workflow', agent_id: 'agent', origin_run_id: 'selected-run', origin_execution_id: 'source-execution' }] }
    throw new Error('Unexpected SQL: ' + sql.slice(0, 80))
  })
  const manager = { nativeCallbackContext: vi.fn(() => context), callbackAuthority: vi.fn(() => ({ ownerPrincipalId: 'sender', attemptId: identity.attemptId })) }
  const admission = productionClaudeFileAdmission({ pool: { query } as unknown as pg.Pool,
    binding: { kind: 'agent', conversationId: 'conversation', workspaceId: 'workspace', repository: { pending: vi.fn() } },
    manager: () => manager as unknown as ClaudeNativeSessionManager, allowMutation: false })
  return { admission, identity, row, principal, query, manager }
}
it('derives selected-Run file provenance from the actual conversation, sender and observed message receipt', async () => {
  const f = fixture(), accepted = await f.admission.current(f.identity)
  expect(accepted?.context).toMatchObject({ ownerPrincipalId: 'sender', nativeSessionId: 'observed-session', nativeMessageId: 'observed-message',
    messageId: 'original-user-message', allowMutation: false, allowedTools: ['files.list', 'files.read'], scope: { kind: 'temporary', chat: {
      kind: 'agent', conversationId: 'conversation', workspaceId: 'workspace', workflowId: 'workflow', runId: 'selected-run', executionId: 'source-execution' } } })
  expect(accepted?.context.turnId).toBeUndefined()
})
it('rejects stale message/sender/cancel receipts before resolving any file principal or scope', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.row.native_submission.nativeMessageId = 'another-message' },
    (f: ReturnType<typeof fixture>) => { f.row.sender_id = 'uploader' }, (f: ReturnType<typeof fixture>) => { f.row.cancel_requested = true }]) {
    const f = fixture(); change(f)
    expect(await f.admission.current(f.identity)).toBeUndefined()
    expect(f.query).toHaveBeenCalledOnce()
  }
})
it('rechecks current sender grants and the same root map after SQL authority reads', async () => {
  const f = fixture(); f.principal.grants = []
  await expect(f.admission.current(f.identity)).rejects.toThrow('not authorized')
  const stale = fixture()
  stale.manager.nativeCallbackContext.mockReturnValueOnce(stale.identity).mockReturnValueOnce({ ...stale.identity, generation: 'successor' })
  expect(await stale.admission.current(stale.identity)).toBeUndefined()
})
