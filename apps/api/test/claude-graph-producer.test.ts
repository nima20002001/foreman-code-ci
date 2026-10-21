import { describe, expect, it } from 'vitest'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, parseNativeGraphObservation, type NativeGraphProjectionKey, type RunGraphScope } from '@foreman-code/contracts/wave25'
import { claudeNativeGraphObservation } from '../src/modules/run-graph/nativeIngestion.js'
import { projectNativeEvidence, type ProjectionBinding } from '../src/modules/run-graph/nativeProjection.js'
import { ReviewEvidenceTracker } from '../src/modules/interactions/reviewerEvidence.js'
import { reviewSourceReadiness } from '../src/modules/interactions/reviewNativeProof.js'

const saved = makeCurrentWorkflowFixture('claude-graph', 'single')
const scope: RunGraphScope = { workspaceId: saved.run.workspaceId, workflowId: saved.run.workflowId,
  workflowVersionId: saved.version.id, runId: saved.run.id, executionSemanticsVersion: 3 }
const key: NativeGraphProjectionKey = { execution: saved.identities[0]!, workKind: 'review', workId: 'review' }
const binding = { nativeSessionId: 'native-session', nativeMessageId: 'native-input-message',
  clientCorrelationId: 'client-request', connectionGeneration: '4', terminalReady: true }
const event = (type: string, patch: Record<string, unknown> = {}): HarnessNativeEvent => ({
  executionId: key.execution.executionId, connectionId: 'connection', sequence: 1, occurredAt: saved.createdAt,
  type, payload: { nativeSessionId: binding.nativeSessionId, nativeMessageId: binding.nativeMessageId,
    clientCorrelationId: binding.clientCorrelationId, ...patch } })
const observation = (input: HarnessNativeEvent, ready = true) => claudeNativeGraphObservation(scope, key, input,
  { ...binding, terminalReady: ready })
const tracker = () => new ReviewEvidenceTracker({ harness: 'claude', nativeSessionId: binding.nativeSessionId,
  providerVersion: '2.1.284' }, binding.clientCorrelationId, binding.nativeMessageId)

describe('Claude actual message graph producer evidence', () => {
  it('acknowledges only consumed input message and exact callback facts', () => {
    const ack = observation(event('message.submitted'))!
    expect(parseNativeGraphObservation(ack)).toEqual(ack)
    expect(ack).toMatchObject({ kind: 'submission', submissionId: binding.nativeMessageId, state: 'acknowledged' })
    expect(observation(event('interaction.pending', { nativeRequestId: 'callback', generation: 4 }))).toMatchObject({ kind: 'submission' })
    expect(observation(event('interaction.pending', { nativeRequestId: 'callback', generation: 3 }))).toBeUndefined()
    expect(observation(event('interaction.pending'))).toBeUndefined()
    for (const patch of [{ nativeSessionId: 'other-session' }, { nativeMessageId: 'other-message' },
      { clientCorrelationId: 'other-request' }, { nativeMessageId: undefined, turnId: binding.nativeMessageId }]) {
      expect(observation(event('message.submitted', patch))).toBeUndefined()
    }
  })
  it('requires qualified per-message result and pending-free readiness for review settlement', () => {
    const completed = event('turn.completed', { result: { outcome: 'succeeded', output: 'private result' } })
    expect(observation(completed)).toMatchObject({ kind: 'terminal', terminal: { outcome: 'succeeded', nativeSettled: true } })
    expect(JSON.stringify(observation(completed))).not.toContain('private result')
    expect(observation(completed, false)).toBeUndefined()
    expect(observation(event('turn.completed', { status: 'completed', turnId: binding.nativeMessageId }))).toBeUndefined()
    expect(observation(event('claude.result.unattributed', { result: { outcome: 'succeeded' } }))).toBeUndefined()
    expect(observation(event('session.idle'))).toBeUndefined()
    const source = { session: { harness: 'claude' as const, nativeSessionId: binding.nativeSessionId, providerVersion: '2.1.284' },
      job: { id: 'review', interactionId: 'interaction', reviewerAgentId: 'reviewer', provider: 'claude' as const,
        nativeSessionId: binding.nativeSessionId, correlationId: binding.clientCorrelationId },
      original: { type: 'event' as const, event: completed, pending: null } }
    expect(reviewSourceReadiness(source, binding.nativeMessageId).terminalReady).toBe(true)
    const pending = { session: source.session, turn: { nativeMessageId: binding.nativeMessageId, nativeRequestId: 'callback' },
      nativeRequestType: 'permission', request: {}, responseOptions: [] }
    expect(reviewSourceReadiness({ ...source, original: { ...source.original, pending } }, binding.nativeMessageId).terminalReady).toBe(false)
  })
  it('projects normalized Claude evidence with nativeMessageId and no provider turn alias', () => {
    const bound: ProjectionBinding = { key, provider: 'claude', nativeSessionId: binding.nativeSessionId,
      nativeTurnId: binding.nativeMessageId, connectionGeneration: '4', interactionId: 'interaction', closed: false }
    const cut = { nativeSequence: '1', sourcePosition: '1', sourceStreamId: 'stream', connectionGeneration: '4', sourceId: 'source' }
    const payload = { nativeSessionId: binding.nativeSessionId, nativeMessageId: binding.nativeMessageId }
    const ack = projectNativeEvidence(undefined, bound, { ...cut, type: 'graph.native.acknowledged', payload })
    expect(ack.activity).toMatchObject({ status: 'active', action: 'reviewing', acknowledgementId: 'source' })
    const terminal = projectNativeEvidence(ack.state, bound, { ...cut, nativeSequence: '2', sourcePosition: '2',
      type: 'graph.native.terminal', payload: { ...payload, terminal: { evidenceKind: 'provider_terminal',
        evidenceId: 'terminal-source', nativeSettled: true, outcome: 'succeeded' } } })
    expect(terminal.state.terminalNativeSequence).toBe('2')
    expect(terminal.activity.status).toBe('none')
    expect(projectNativeEvidence(undefined, bound, { ...cut, type: 'turn.started',
      payload: { sessionID: binding.nativeSessionId, turnId: binding.nativeMessageId, turn: { id: binding.nativeMessageId, status: 'inProgress' } } }).activity.status).toBe('unknown')
  })
  it('does not settle reviewer evidence from another message or an invented turn alias', () => {
    const actual = tracker(); actual.observeEvent(event('turn.completed', { result: { outcome: 'failed', error: { code: 'ERROR', message: 'Failure', retryable: false } } }))
    expect(actual.snapshot().terminal).toBe(true)
    for (const patch of [{ nativeMessageId: 'other-message' }, { nativeSessionId: 'other-session' },
      { nativeMessageId: undefined, turnId: binding.nativeMessageId }, { clientCorrelationId: 'other-request' }]) {
      const evidence = tracker(); evidence.observeEvent(event('turn.completed', { result: { outcome: 'succeeded' }, ...patch }))
      expect(evidence.snapshot().terminal).toBe(false)
    }
  })
})
