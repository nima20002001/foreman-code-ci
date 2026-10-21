import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, PendingNativeInteractionSchema, type ApprovalResponseOption } from '@foreman-code/contracts'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { OperatorChatCommands } from '../src/modules/conversations/operatorChatCommands.js'
import type pg from 'pg'
import { memoryConversation } from './fixtures/agent1OperatorChat.js'
import { ActivitySnapshotV1Schema } from '@foreman-code/contracts/activity'

function fixture() {
  const principal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }] }
  const configuration = { id: 'configuration', operatorId: 'application-operator', version: 1, harness: DEFAULT_HARNESS_DEFAULTS.codex,
    contentHash: `sha256:${'a'.repeat(64)}`, createdAt: new Date().toISOString() }
  const option: ApprovalResponseOption = { optionId: 'reject', label: 'Reject', semantic: 'reject',
    persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }
  const pending = PendingNativeInteractionSchema.parse({
    session: { harness: 'codex', providerVersion: 'test', nativeSessionId: 'session' },
    turn: { nativeTurnId: 'turn', nativeRequestId: 'approval' }, nativeRequestType: 'item/commandExecution/requestApproval',
    request: { command: 'printf requested' }, responseOptions: [option],
  })
  const lifecycle = memoryConversation(configuration, principal.id, 'chat')
  const row = Object.assign(lifecycle.row, { id: 'chat', owner_principal_id: principal.id, operator_configuration_version_id: configuration.id,
    harness: 'codex', provider_version: 'test', native_session_id: 'session', active_request_id: 'request',
    active_native_turn_id: 'turn', active_phase: 'submitted', cancel_requested: false, revision: 1,
    pending_interaction: pending })
  const records = new Map<string, { target_key: unknown; input_hash: unknown; result: unknown }>()
  const commands = new OperatorChatCommands({ query: async (sql: string, values: unknown[]) => {
    const key = JSON.stringify(values.slice(0, 3))
    if (sql.includes('with claimed as')) {
      if (records.has(key)) return { rows: [], rowCount: 0 }
      records.set(key, { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[6])) }); return { rows: [], rowCount: 1 }
    }
    if (sql.includes('with settled as')) { records.get(key)!.result = JSON.parse(String(values[3])); return { rows: [], rowCount: 1 } }
    if (sql.includes('select target_key,input_hash,result')) return { rows: [records.get(key)], rowCount: 1 }
    throw new Error(`Unexpected receipt SQL: ${sql}`)
  } } as unknown as Pick<pg.Pool, 'query'>)
  const repository = { ...lifecycle.repository, createControlCommands: () => commands, active: vi.fn(async () => row), configuration: vi.fn(async () => configuration),
    claimResponse: vi.fn(async () => true), pending: vi.fn(async (_id, _requestId, pending) => { Object.assign(row, { pending_interaction: pending ?? null }) }), submitted: vi.fn(async () => true),
    finish: vi.fn(async () => true), uncertain: vi.fn(async () => {}), unfinished: vi.fn(async () => [row]),
    activity: { append: vi.fn(), unfinishedOwners: vi.fn(async () => ({ owners: [] })) }, get: vi.fn(async () => ({})) }
  const manager = { harness: 'codex', attachSession: vi.fn(async (session: { nativeSessionId: string }) => session), createSession: vi.fn(), startTurn: vi.fn(),
    respond: vi.fn(async () => {}), stopAutomaticResponses: vi.fn(), dispose: vi.fn(async () => {}),
    reconcile: vi.fn(async () => ({ correlationId: nativeCorrelation('chat', 'request'), nativeTurnId: 'turn', events: [],
      pendingInteractions: [], nativeMessageId: 'answer', terminalResult: { outcome: 'succeeded', output: { text: 'completed before removal' } } })) }
  const authority = { current: vi.fn(async () => principal), assertConfiguration: vi.fn(),
    setup: vi.fn(async () => { throw new Error('native configuration removed or inspection unavailable') }),
    prepare: vi.fn(async () => { throw new Error('new launch must be blocked') }), release: vi.fn(async () => {}) }
  const chat = new OperatorChatService(repository as never, {} as never, (() => manager) as never, '/tmp/pr18-operator', authority as never)
  const activitySnapshot = ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: 'chat' },
    revision: '1', sourceRevisions: [], active: [{ ref: { kind: 'chat_request', conversationId: 'chat', requestId: 'request' },
      phase: 'active', outcome: null, delivery: 'accepted', evidence: 'confirmed', startedAt: null }], queued: [],
    latest: { kind: 'chat_request', conversationId: 'chat', requestId: 'request' }, pendingInteractions: [], activities: [],
    page: { before: null, nextCursor: null, hasMore: false } })
  vi.spyOn(chat, 'get').mockResolvedValue({ ...OperatorConversationStateSchema.parse({ conversation: { id: 'chat', agentId: 'application-operator',
    scope: 'application', operatorConfigurationVersionId: configuration.id }, messages: [], turnState: 'active', revision: 1, activeRequestId: 'request' }),
  activitySnapshot, qualificationKey: 'a'.repeat(64) })
  return { chat, repository, manager, authority, principal, option }
}
it('delivers an owner rejection after MCP removal without setup or issuing new credentials', async () => {
  const f = fixture()
  await f.chat.respond('chat', { requestId: 'request', nativeRequestId: 'approval', optionId: 'reject' }, f.principal as never)
  await f.chat.reconcileActive()
  expect(f.manager.respond).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'session' }), 'approval', f.option, expect.anything())
  expect(f.authority.setup).not.toHaveBeenCalled(); expect(f.authority.prepare).not.toHaveBeenCalled()
  expect(f.manager.createSession).not.toHaveBeenCalled(); expect(f.manager.startTurn).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.repository.finish).toHaveBeenCalledWith(
    'chat', 'request', expect.objectContaining({ outcome: 'succeeded' }), 'answer', false))
})
it('records a detached terminal result after MCP removal without launching or checking installation', async () => {
  const f = fixture()
  await f.chat.reconcileActive()
  expect(f.repository.finish).toHaveBeenCalledWith('chat', 'request', expect.objectContaining({ outcome: 'succeeded' }), 'answer', false)
  expect(f.repository.uncertain).not.toHaveBeenCalled()
  expect(f.authority.setup).not.toHaveBeenCalled(); expect(f.authority.prepare).not.toHaveBeenCalled()
  expect(f.manager.createSession).not.toHaveBeenCalled(); expect(f.manager.startTurn).not.toHaveBeenCalled()
})
