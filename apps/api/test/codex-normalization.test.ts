import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { normalizeCodexNotification, type CodexNotificationEnvelope } from '../src/modules/harnesses/codexNormalization.js'
import { codexNormalizationEnvelopes, codexNormalizationTranscript } from './fixtures/codex-normalization-transcript.js'
import { codexRequestKey, translateCodexInteraction, resolveCodexInteractionResponse } from '../src/modules/harnesses/codexInteractions.js'

const owner = { threadId: 'root', turnId: 'parent-turn', runtimeGeneration: 3, terminal: false }
const envelope = (method: string, params: CodexNotificationEnvelope['params'], runtimeGeneration = 3): CodexNotificationEnvelope => ({
  providerVersion: 'codex-cli 0.154.0', schemaIdentity: 'qualified-schema', connectionId: 'connection-3',
  runtimeGeneration, arrivalOrdinal: 4, method, params,
})
const context = { session: { harness: 'codex' as const, providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'root' },
  configuration: DEFAULT_HARNESS_DEFAULTS.codex, connectionId: 'connection-3', generation: 3 }
const approval = (method: string, params: Record<string, unknown> = {}, id: string | number = 1) =>
  translateCodexInteraction(context, { id, method, params: { threadId: 'root', turnId: 'parent-turn', ...params } })

describe('Codex validated-envelope normalization', () => {
  it('replays source-pinned synthetic frames without converting child or stale completion into root terminal', () => {
    const results = codexNormalizationEnvelopes().map((frame) => normalizeCodexNotification(codexNormalizationTranscript.owner, frame))
    expect(results.map((result) => result.kind)).toEqual(['unlinked', 'delta', 'item', 'ignored', 'turn'])
    expect(results.filter((result) => result.kind === 'turn' && result.terminal)).toHaveLength(1)
  })
  it('retains child-before-parent terminal identity without completing the parent or inventing linkage', () => {
    const input = envelope('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed', items: [] } })
    const result = normalizeCodexNotification(owner, input)
    expect(result).toEqual({ kind: 'unlinked', evidence: { ...input, threadId: 'child', turnId: 'child-turn' } })
    expect(result).not.toHaveProperty('parentThreadId')
    expect(normalizeCodexNotification(owner, envelope('turn/completed', {
      threadId: 'root', turn: { id: 'parent-turn', status: 'completed', items: [] },
    }))).toMatchObject({ kind: 'turn', terminal: true })
  })
  it('fences old-generation, old-turn and already-terminal callbacks', () => {
    const params = { threadId: 'root', turn: { id: 'parent-turn', status: 'completed', items: [] } }
    expect(normalizeCodexNotification(owner, envelope('turn/completed', params, 2))).toMatchObject({ kind: 'ignored', reason: 'stale_generation' })
    expect(normalizeCodexNotification(owner, envelope('turn/completed', { ...params, turn: { ...params.turn, id: 'old-turn' } })))
      .toMatchObject({ kind: 'ignored', reason: 'inactive_turn' })
    expect(normalizeCodexNotification({ ...owner, terminal: true }, envelope('turn/completed', params)))
      .toMatchObject({ kind: 'ignored', reason: 'inactive_turn' })
  })
  it('keeps deltas, native completed messages and terminal evidence distinct', () => {
    expect(normalizeCodexNotification(owner, envelope('item/agentMessage/delta', {
      threadId: 'root', turnId: 'parent-turn', itemId: 'answer', delta: 'partial',
    }))).toMatchObject({ kind: 'delta', delta: 'partial', evidence: { itemId: 'answer' } })
    expect(normalizeCodexNotification(owner, envelope('item/completed', {
      threadId: 'root', turnId: 'parent-turn', item: { id: 'answer', type: 'agentMessage', text: 'final', phase: 'final_answer' },
    }))).toMatchObject({ kind: 'item', completed: true, item: { id: 'answer', phase: 'final_answer' } })
    expect(normalizeCodexNotification(owner, envelope('turn/completed', {
      threadId: 'root', turn: { id: 'parent-turn', status: 'inProgress', items: [] },
    }))).toMatchObject({ kind: 'ignored' })
  })
  it('retains resolved as uncertain response-delivery evidence and requires exact native thread', () => {
    expect(normalizeCodexNotification(owner, envelope('serverRequest/resolved', { threadId: 'root', requestId: 1 })))
      .toMatchObject({ kind: 'resolved', responseDelivery: 'unknown' })
    expect(normalizeCodexNotification(owner, envelope('serverRequest/resolved', { requestId: 1 })))
      .toMatchObject({ kind: 'ignored', reason: 'missing_thread' })
  })
})

describe('Codex approval translation', () => {
  it('preserves offered scope, native response and stable process-local option identity', () => {
    const result = approval('item/commandExecution/requestApproval', { availableDecisions: ['accept', 'decline', 'cancel'] })!
    expect(result.pending.responseOptions.map((option) => option.semantic)).toEqual(['approve_once', 'reject', 'cancel'])
    expect(result.pending.responseOptions.every((option) => option.persistence === 'request')).toBe(true)
    expect(result.responses.values().next().value?.nativeResponse).toEqual({ decision: 'accept' })
    expect(approval('item/commandExecution/requestApproval', { availableDecisions: ['accept', 'decline', 'cancel'] })?.pending)
      .toEqual(result.pending)
    expect(codexRequestKey(3, 1)).not.toBe(codexRequestKey(3, '1'))
    expect(codexRequestKey(3, 1)).not.toBe(codexRequestKey(4, 1))
    const fresh = translateCodexInteraction({ ...context, generation: 4 }, {
      id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'root', turnId: 'parent-turn', availableDecisions: ['accept'] },
    })!
    expect(fresh.pending.responseOptions[0]!.optionId).not.toBe(result.pending.responseOptions[0]!.optionId)
  })
  it('keeps turn/session grants and persistent policy changes distinguishable', () => {
    const permissions = approval('item/permissions/requestApproval', { permissions: { fileSystem: { write: ['/work'] } } })!
    expect(permissions.pending.responseOptions.map((option) => option.semantic)).toEqual(['allow_turn', 'allow_session', 'reject'])
    const policy = approval('item/commandExecution/requestApproval', { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } }] })!
    expect(policy.pending.responseOptions[0]).toMatchObject({ semantic: 'persistent_policy_change', persistence: 'persistent_config', mutatesPersistentPolicy: true })
  })
  it('retains generic questions and form schemas for an explicit validated response', () => {
    const question = approval('item/tool/requestUserInput', { isBlocking: false, questions: [{
      id: 'generic', header: 'Continue?', question: 'Choose the next step',
      options: [{ label: 'Allow', description: '' }],
    }] })!
    const option = question.pending.responseOptions[0]!
    expect(option).toMatchObject({ input: { kind: 'questions' }, mutatesPersistentPolicy: false,
      affectsOtherPendingRequests: false, persistence: 'request' })
    expect(resolveCodexInteractionResponse(question.responses.get(option.optionId)!, { ...option,
      response: { generic: { answers: ['Allow'] } } })).toEqual({ answers: { generic: { answers: ['Allow'] } } })
    const form = approval('mcpServer/elicitation/request', { mode: 'form', requestedSchema: {
      type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'],
    } })!
    expect(form.pending.responseOptions[0]).toMatchObject({ input: { kind: 'form', schema: { required: ['secret'] } } })
    expect(approval('mcpServer/elicitation/request', { mode: 'form', requestedSchema: { type: 'object', properties: {} } })?.pending.responseOptions
      .map((option) => option.semantic)).toEqual(['approve_once', 'reject', 'cancel'])
  })
  it('does not offer session persistence for ephemeral configurations', () => {
    const result = translateCodexInteraction({ ...context, configuration: { ...context.configuration,
      advanced: { ...context.configuration.advanced!, sessionPersistence: 'ephemeral' } } }, {
      id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'root', turnId: 'parent-turn' },
    })!
    expect(result.pending.responseOptions.map((option) => option.semantic)).toEqual(['approve_once', 'reject', 'cancel'])
  })
})
