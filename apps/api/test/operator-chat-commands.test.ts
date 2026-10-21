import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { OperatorChatCommands } from '../src/modules/conversations/operatorChatCommands.js'
import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
const principal: ManagementPrincipal = { id: 'operator-control-owner', name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['operator_chat:read', 'operator_chat:respond', 'operator_chat:cancel'], scope: {} }] }
const initial = OperatorConversationStateSchema.parse({ conversation: { id: 'conversation', agentId: 'operator', scope: 'application',
  operatorConfigurationVersionId: 'pinned-configuration' }, messages: [], turnState: 'idle', revision: 2, activeRequestId: null })
function ledger() {
  const records = new Map<string, { target_key: unknown; input_hash: unknown; result: Record<string, unknown> }>()
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    const key = JSON.stringify(values.slice(0, 3))
    if (sql.includes('with claimed as')) {
      if (records.has(key)) return { rowCount: 0, rows: [] }
      records.set(key, { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[6])) }); return { rowCount: 1, rows: [] }
    }
    if (sql.includes('with settled as')) { records.get(key)!.result = JSON.parse(String(values[3])); return { rowCount: 1, rows: [] } }
    if (sql.includes('select target_key,input_hash,result')) return { rowCount: 1, rows: [records.get(key)] }
    throw new Error(`Unrecognized control SQL: ${sql}`)
  })
  return { records, pool: { query } as unknown as Pick<pg.Pool, 'query'> }
}
it('uses one Operator receipt across HTTP/MCP with current readback, changed-choice conflict and no repeated native effect', async () => {
  const memory = ledger(), commands = new OperatorChatCommands(memory.pool)
  let state = initial
  const current = async () => state, perform = vi.fn(async () => state)
  const input = { kind: 'respond', requestId: 'model-request', nativeRequestId: 'native-question', optionId: 'approve-once' }
  await commands.execute(principal, 'http', 'conversation', 'caller-key', input, perform, current)
  state = { ...state, revision: 20 }
  expect((await new OperatorChatCommands(memory.pool).execute(principal, 'mcp', 'conversation', 'caller-key', input, perform, current)).revision).toBe(20)
  expect(perform).toHaveBeenCalledTimes(1)
  await expect(commands.execute(principal, 'mcp', 'conversation', 'caller-key', { ...input, optionId: 'deny' }, perform, current))
    .rejects.toMatchObject({ code: 'OPERATOR_CHAT_REQUEST_CONFLICT' })
  expect(memory.records.size).toBe(1)
})
it('never records authorization loss after dispatch as definite native rejection or replays uncertain effects', async () => {
  const memory = ledger(), commands = new OperatorChatCommands(memory.pool)
  const perform = vi.fn(async (markDispatchAttempt: () => void) => {
    markDispatchAttempt(); throw new DomainError('ACCESS_DENIED', 'Authority changed after dispatch.', 403)
  })
  for (const source of ['http', 'mcp'] as const) await expect(commands.execute(principal, source, 'conversation', 'caller-key',
    { kind: 'respond' }, perform, async () => initial)).rejects.toMatchObject({ code: 'OPERATOR_CHAT_CONTROL_UNCONFIRMED' })
  expect([...memory.records.values()][0]!.result.status).toBe('uncertain')
  expect(perform).toHaveBeenCalledTimes(1)
})
it.each(['NATIVE_RESPONSE_DELIVERY_FAILED', 'NATIVE_RESPONSE_INVALID'])('records Codex pre-write %s as rejected and permits a new explicit command', async (code) => {
  const memory = ledger(), commands = new OperatorChatCommands(memory.pool)
  const input = { kind: 'respond', requestId: 'model-request', nativeRequestId: 'native-question', optionId: 'approve-once' }
  const perform = vi.fn(async (markDispatchAttempt: () => void) => {
    markDispatchAttempt()
    throw new HarnessExecutionError(code, 'Nothing was submitted.')
  })
  for (const source of ['http', 'mcp'] as const) await expect(new OperatorChatCommands(memory.pool).execute(principal, source,
    'conversation', 'failed-command', input, perform, async () => initial)).rejects.toMatchObject({ code: 'NATIVE_RESPONSE_DELIVERY_FAILED', status: 409 })
  expect([...memory.records.values()][0]!.result.status).toBe('rejected')
  expect(perform).toHaveBeenCalledTimes(1)
  const retry = vi.fn(async (markDispatchAttempt: () => void) => { markDispatchAttempt(); return initial })
  await expect(commands.execute(principal, 'mcp', 'conversation', 'new-explicit-command', input, retry, async () => initial)).resolves.toEqual(initial)
  expect(retry).toHaveBeenCalledTimes(1)
  expect([...memory.records.values()][1]!.result.status).toBe('completed')
})
it.each([
  new HarnessExecutionError('NATIVE_RESPONSE_DELIVERY_UNCERTAIN', 'The write may have reached the provider.'),
  new HarnessExecutionError('CODEX_APP_SERVER_TIMEOUT', 'Delivery has not been disproved.'),
  new HarnessExecutionError('NATIVE_RESPONSE_CLEARED', 'Acceptance was not confirmed.'),
  { result: { error: { code: 'NATIVE_RESPONSE_DELIVERY_FAILED' } } },
])('fences ambiguous %j without repeating the native response', async (error) => {
  const memory = ledger()
  const perform = vi.fn(async (markDispatchAttempt: () => void) => {
    markDispatchAttempt()
    throw error
  })
  for (const source of ['http', 'mcp'] as const) await expect(new OperatorChatCommands(memory.pool).execute(principal, source,
    'conversation', 'caller-key', { kind: 'respond' }, perform, async () => initial)).rejects.toMatchObject({ code: 'OPERATOR_CHAT_CONTROL_UNCONFIRMED' })
  expect([...memory.records.values()][0]!.result.status).toBe('uncertain')
  expect(perform).toHaveBeenCalledTimes(1)
})
it('retains the accepted native choice and rechecks current action authority before reading a completed receipt', async () => {
  const memory = ledger(), commands = new OperatorChatCommands(memory.pool)
  const control = { schemaVersion: 1 as const, kind: 'respond' as const, conversationId: 'conversation', modelRequestId: 'model-request',
    scope: { kind: 'operator_chat' as const, conversationId: 'conversation' },
    native: { harness: 'codex', providerVersion: 'codex-cli 0.154.0', sessionId: 'native-session', turnId: 'native-turn', requestId: 'native-question', requestType: 'approval' },
    choice: { optionId: 'approve-once', semantic: 'approve_once' } }
  const payload = { kind: 'respond', requestId: 'model-request', nativeRequestId: 'native-question', optionId: 'approve-once' }
  const perform = vi.fn(async () => initial)
  await commands.execute(principal, 'http', 'conversation', 'caller-key', payload, perform, async () => initial, control)
  const recorded = structuredClone([...memory.records.values()][0]!.result)
  await commands.execute(principal, 'mcp', 'conversation', 'caller-key', payload, perform, async () => initial,
    { ...control, native: { ...control.native, requestId: 'newer-question' } })
  expect([...memory.records.values()][0]!.result).toEqual(recorded)
  expect(recorded.acceptedControl).toEqual(control)
  expect(perform).toHaveBeenCalledTimes(1)
  const queries = vi.mocked(memory.pool.query).mock.calls.length
  await expect(commands.execute(principal, 'mcp', 'conversation', 'caller-key', payload, perform, async () => {
    throw new DomainError('ACCESS_DENIED', 'The response grant was revoked.', 403)
  })).rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
  expect(vi.mocked(memory.pool.query).mock.calls).toHaveLength(queries)
  expect(perform).toHaveBeenCalledTimes(1)
})
