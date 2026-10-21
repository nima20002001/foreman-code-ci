import { describe, expect, it } from 'vitest'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import type { ClosedWorkflowSession } from '../src/modules/interactions/workflowClosure.js'
import { assertRepeatNativeClosure, assertRepeatNativeUpdate } from '../src/modules/interactions/repeatNativeEvidence.js'
import { prepareRepeatNativeUpdate } from '../src/modules/runs/repeatNode.js'
import { nativeAt, nativeCompleted, nativeFixture } from './eng04-native-fixtures.js'

function closure(execution: HarnessExecution): { session: NativeSessionReference; proof: ClosedWorkflowSession } {
  const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: execution.nativeSessionId! }
  const proof: ClosedWorkflowSession = { execution, session, durableGeneration: '17' }
  return { session, proof }
}

describe('ENG04 native evidence and first-terminal immutability', () => {
  it('accepts only the same durable generation and exact session identity', () => {
    const execution = nativeCompleted(nativeFixture().execution), { session, proof } = closure(execution)
    expect(assertRepeatNativeClosure(execution, session, proof)).toBe('17')
    expect(() => assertRepeatNativeClosure(execution, session, undefined)).toThrowError(expect.objectContaining({ code: 'REPEAT_CLEANUP_PENDING' }))
    const noGeneration: ClosedWorkflowSession = { execution: proof.execution, session: proof.session }
    expect(() => assertRepeatNativeClosure(execution, session, noGeneration))
      .toThrowError(expect.objectContaining({ code: 'REPEAT_CLEANUP_PENDING' }))
  })
  it.each(['0', '-1', '1.5', 'NaN', '', '01'])('rejects invalid closure generation %s', (durableGeneration) => {
    const execution = nativeCompleted(nativeFixture().execution), { session, proof } = closure(execution)
    expect(() => assertRepeatNativeClosure(execution, session, { ...proof, durableGeneration })).toThrow()
  })
  it.each(['id', 'runId', 'workflowNodeId', 'agentId', 'agentConfigurationVersionId', 'workingDirectory', 'runtimeDirectory', 'nativeSessionId'] as const)('rejects a closure from another %s', (key) => {
    const execution = nativeCompleted(nativeFixture().execution), { session, proof } = closure(execution)
    expect(() => assertRepeatNativeClosure(execution, session, { ...proof, execution: { ...proof.execution, [key]: 'other' } }))
      .toThrowError(expect.objectContaining({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' }))
  })
  it('rejects another attempt, provider or provider version without changing evidence', () => {
    const execution = nativeCompleted(nativeFixture().execution), { session, proof } = closure(execution)
    expect(() => assertRepeatNativeClosure(execution, session, { ...proof, execution: { ...proof.execution, attempt: 2 } })).toThrow()
    expect(() => assertRepeatNativeClosure(execution, session, { ...proof, session: { ...session, harness: 'claude' } })).toThrow()
    expect(() => assertRepeatNativeClosure(execution, session, { ...proof, session: { ...session, providerVersion: 'different' } })).toThrow()
  })
  it('preserves exact valid native text bytes at the first durable terminal', () => {
    const f = nativeFixture()
    const text = ' {"routing":{"outcome":"issues"},"data":{"latestDeliverable":{"a":1},"remainingFindings":[]}} '
    const incoming = nativeCompleted(f.execution, { text })
    expect(prepareRepeatNativeUpdate(f.version, f.scope, f.ref, f.execution, incoming)).toEqual(incoming)
    expect(incoming.result?.output).toEqual({ text })
  })
  it.each([
    { text: 'prose {"routing":{"outcome":"issues"}}' },
    { text: '{"routing":{"outcome":"issues"},"data":' },
    { routing: { outcome: 'issues' }, data: { latestDeliverable: null, remainingFindings: [] } },
    { routing: { outcome: 'invented' }, data: { latestDeliverable: {}, remainingFindings: [] } },
    { text: '{"routing":{"outcome":"pass"},"data":{"latestDeliverable":{},"remainingFindings":[]}}', extra: true },
  ])('fails closed only on first invalid complete terminal %j', (output) => {
    const f = nativeFixture(), incoming = nativeCompleted(f.execution, output)
    const before = structuredClone(incoming)
    const result = prepareRepeatNativeUpdate(f.version, f.scope, f.ref, f.execution, incoming)
    expect(result.result).toMatchObject({ outcome: 'failed', error: { code: 'REPEAT_RESULT_INVALID', retryable: false } })
    expect(incoming).toEqual(before) // Raw/history and caller evidence are not rewritten.
  })
  it('never repairs an already-written invalid success on replay', () => {
    const f = nativeFixture(), prior = nativeCompleted(f.execution, { text: 'invalid' })
    expect(prepareRepeatNativeUpdate(f.version, f.scope, f.ref, prior, prior)).toEqual(prior)
    const normalized = prepareRepeatNativeUpdate(f.version, f.scope, f.ref, f.execution, prior)
    expect(() => prepareRepeatNativeUpdate(f.version, f.scope, f.ref, prior, normalized))
      .toThrowError(expect.objectContaining({ code: 'REPEAT_TERMINAL_CONFLICT' }))
  })
  it('rejects input/session/path/attempt replacement before normalization', () => {
    const f = nativeFixture(), incoming = nativeCompleted(f.execution)
    for (const mutation of [{ input: { replaced: true } }, { nativeSessionId: 'other' }, { runtimeDirectory: '/other' }, { attempt: 2 }]) {
      expect(() => assertRepeatNativeUpdate(f.execution, { ...incoming, ...mutation })).toThrow()
    }
  })
  it('rejects changing or dropping the application system prompt snapshot after session start', () => {
    const snapshot = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    const previous = { ...nativeFixture().execution, systemPrompt: snapshot }
    const incoming = nativeCompleted(previous)
    expect(assertRepeatNativeUpdate(previous, incoming)).toBe('write')
    expect(() => assertRepeatNativeUpdate(previous, { ...incoming,
      systemPrompt: { ...snapshot, revision: 4 } })).toThrow()
    const missing = { ...incoming }
    delete missing.systemPrompt
    expect(() => assertRepeatNativeUpdate(previous, missing)).toThrow()
  })
  it('allows identical terminal replay but rejects changed terminal time or business output', () => {
    const prior = nativeCompleted(nativeFixture().execution)
    expect(assertRepeatNativeUpdate(prior, structuredClone(prior))).toBe('replay')
    expect(() => assertRepeatNativeUpdate(prior, { ...prior, finishedAt: '2026-09-25T00:00:01.000Z' })).toThrow()
    expect(() => assertRepeatNativeUpdate(prior, { ...prior, result: { outcome: 'canceled' } })).toThrow()
  })
  it('does not rewind native state or permit nonterminal results', () => {
    const prior = nativeFixture().execution
    expect(() => assertRepeatNativeUpdate(prior, { ...prior, state: 'queued' })).toThrow()
    expect(() => assertRepeatNativeUpdate(prior, { ...prior, state: 'waiting', finishedAt: nativeAt })).toThrow()
    expect(() => assertRepeatNativeUpdate(prior, { ...prior, result: { outcome: 'succeeded' } })).toThrow()
  })
})
