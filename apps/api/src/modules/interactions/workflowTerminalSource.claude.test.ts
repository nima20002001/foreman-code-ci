import { expect, it } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'
import { assertOriginalWorkflowTerminal, workflowProviderId } from './workflowTerminalSource.js'

function fixture() {
  const execution = { id: 'execution', agentId: 'agent' }
  const session: NativeSessionReference = { harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'session' }
  const raw: Record<string, unknown> = { type: 'result', uuid: 'result', session_id: 'session',
    user_message_uuid: 'input', subtype: 'success', is_error: false, result: 'done' }
  const history: NativeHistory = {
    correlationId: 'execution:execution',
    nativeSubmission: { kind: 'message', nativeSessionId: 'session', nativeMessageId: 'input',
      clientCorrelationId: 'execution:execution' },
    terminalTurn: { correlationId: 'execution:execution', providerId: 'input',
      result: { outcome: 'succeeded', output: 'done' } },
    pendingInteractions: [],
    events: [{ sequence: 1, occurredAt: '2026-10-06T00:00:00.000Z', type: 'claude.result', payload: {
      clientCorrelationId: 'execution:execution', source: { eventId: 'result' }, nativeResult: raw,
    } }],
  }
  return { execution, session, raw, history }
}

it('accepts the original Claude root result bound to its native message receipt', () => {
  const f = fixture()
  expect(f.history.nativeTurnId).toBeUndefined()
  expect(workflowProviderId(f.session, f.history)).toBe('input')
  expect(() => assertOriginalWorkflowTerminal(f.execution, f.session, f.history)).not.toThrow()
})

it.each(['session', 'prompt', 'result-id', 'text', 'parent', 'deferred', 'source', 'receipt', 'missing'] as const)(
  'rejects Claude terminal evidence with changed %s', (fault) => {
    const f = fixture()
    if (fault === 'session') f.raw.session_id = 'foreign'
    if (fault === 'prompt') f.raw.user_message_uuid = 'foreign'
    if (fault === 'result-id') f.raw.uuid = 'foreign'
    if (fault === 'text') f.raw.result = 'foreign'
    if (fault === 'parent') f.raw.parent_tool_use_id = 'child'
    if (fault === 'deferred') f.raw.deferred_tool_use = {}
    if (fault === 'source') f.history.events[0]!.type = 'claude.result.unattributed'
    if (fault === 'receipt') f.history.nativeSubmission = { kind: 'message', nativeSessionId: 'foreign',
      nativeMessageId: 'input', clientCorrelationId: 'execution:execution' }
    if (fault === 'missing') f.history.events = []
    expect(() => assertOriginalWorkflowTerminal(f.execution, f.session, f.history))
      .toThrow('original native terminal frame')
  },
)
