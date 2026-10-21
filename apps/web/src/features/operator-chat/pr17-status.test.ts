import { describe, expect, it } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, type ApprovalResponseOption } from '@foreman-code/contracts'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { newerOperatorSummaries, operatorNeedsAttention, operatorNavigationStatus, operatorTurnStatus, summarizeOperatorConversation } from './operatorChatStatus'
import { operatorDecision, operatorState } from './pr17-test-fixtures'

const once = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
describe('PR17 decision scope and Operator status', () => {
  it.each<ApprovalResponseOption['persistence']>(['request', 'turn', 'session', 'provider_instance', 'project', 'persistent_config'])('names the %s scope even without a summary', (persistence) => {
    const text = approvalOptionScope({ ...once, persistence, scopeSummary: undefined })
    expect(text).toMatch(/^Scope: /)
    expect(text).not.toContain('undefined')
  })
  it('does not let a friendly summary conceal persistent changes or other pending requests', () => {
    const text = approvalOptionScope({ ...once, scopeSummary: 'Continue', mutatesPersistentPolicy: true, affectsOtherPendingRequests: true })
    expect(text).toContain('Changes persistent native policy')
    expect(text).toContain('other pending requests')
  })
  it('distinguishes a pending decision from an active turn', () => {
    const state = operatorState({ pendingInteraction: operatorDecision, responseDelivery: 'offered' })
    expect(operatorNeedsAttention(state)).toBe(true)
    expect(operatorTurnStatus(state, 'connected')).toBe('Waiting for your decision.')
    expect(operatorNavigationStatus(summarizeOperatorConversation(state))).toBe('Needs your decision')
  })
  it.each(['submitted', 'uncertain'] as const)('does not offer another decision during %s delivery', (responseDelivery) => {
    const state = operatorState({ pendingInteraction: operatorDecision, responseDelivery })
    expect(operatorNeedsAttention(state)).toBe(false)
    expect(operatorTurnStatus(state, 'connected')).toContain('Checking delivery')
  })
  it('does not report a disconnected active turn as finished', () => {
    const text = operatorTurnStatus(operatorState(), 'reconnecting')
    expect(text).toContain('Connecting to activity updates.')
    expect(text).toContain('Operator is working')
    expect(text).not.toContain('finished')
  })
  it('names requested cancellation without adding a finished notice after confirmation', () => {
    expect(operatorTurnStatus(operatorState({ turnState: 'canceling' }), 'connected'))
      .toBe('Stop requested—execution not yet confirmed stopped.')
    expect(operatorTurnStatus(operatorState({ turnState: 'idle', activeRequestId: null, lastResult: { outcome: 'canceled' } }), 'connected')).toBe('')
  })
  it('does not resurrect a decision from an older summary poll', () => {
    const before = summarizeOperatorConversation(operatorState({ pendingInteraction: operatorDecision, responseDelivery: 'offered' }))
    const after = { ...before, revision: 2, needsAttention: false }
    expect(newerOperatorSummaries([after], [before])).toEqual([after])
  })
})
