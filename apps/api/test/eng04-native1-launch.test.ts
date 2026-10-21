import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { repeatLaunchClaim, repeatPossibleSubmissionLocked, requireRepeatNativeHooks } from '../src/modules/runs/repeatNativeRepository.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { nativeAt, nativeFixture } from './eng04-native-fixtures.js'

/** SQL-shaped repository checks, NOT authenticated endpoint or PostgreSQL tests.
 * No native session, credential, acknowledgement or provider is constructed. */
describe('ENG04 NATIVE-1 immutable launch and possible-submission identities', () => {
  it('reconstructs one claim despite later lifecycle, result and session observations', () => {
    const f = nativeFixture()
    const digest = repeatDigest({ frozen: 'input' })
    const first = repeatLaunchClaim(f.scope, f.ref, f.execution, digest)
    const next = HarnessExecutionSchema.parse({ ...f.execution, state: 'completed', finishedAt: nativeAt,
      result: { outcome: 'failed', error: { code: 'FAILED', message: 'Fixture', retryable: false } } })
    expect(repeatLaunchClaim(f.scope, f.ref, next, digest)).toEqual(first)
  })
  it('distinguishes occurrence, exact execution, technical attempt and frozen input', () => {
    const f = nativeFixture(), input = repeatDigest({ frozen: 'input' })
    const claim = repeatLaunchClaim(f.scope, f.ref, f.execution, input)
    const variants = [
      repeatLaunchClaim(f.scope, { ...f.ref, occurrence: { ...f.occurrence.identity, occurrenceId: 'another-occurrence', occurrenceIndex: 2 } }, f.execution, input),
      repeatLaunchClaim(f.scope, f.ref, { ...f.execution, id: 'another-execution' }, input),
      repeatLaunchClaim(f.scope, f.ref, { ...f.execution, attempt: 2 }, input),
      repeatLaunchClaim(f.scope, f.ref, f.execution, repeatDigest({ frozen: 'other' })),
    ]
    expect(new Set([claim, ...variants].map((value) => repeatDigest(value))).size).toBe(5)
  })
  it('does not retain mutable caller aliases in a launch claim', () => {
    const f = nativeFixture(), claim = repeatLaunchClaim(f.scope, f.ref, f.execution, repeatDigest({}))
    const saved = structuredClone(claim)
    f.scope.workflowId = 'other-workflow'
    f.ref.occurrence.occurrenceIndex = 2
    expect(claim).toEqual(saved)
  })
  it('rejects cross-Run and cross-workspace occurrence scope before hashing', () => {
    const f = nativeFixture()
    for (const key of ['runId', 'workspaceId', 'workflowId', 'workflowVersionId'] as const) {
      expect(() => repeatLaunchClaim(f.scope, { ...f.ref, occurrence: { ...f.occurrence.identity,
        scope: { ...f.scope, [key]: 'crossed' } } }, f.execution, repeatDigest({}))).toThrow('launch envelope')
    }
  })
  it.each([0, -1, 1.5, 2147483648])('rejects invalid technical attempt %s', (attempt) => {
    const f = nativeFixture()
    expect(() => repeatLaunchClaim(f.scope, f.ref, { ...f.execution, attempt }, repeatDigest({}))).toThrow()
  })
  it('uses execution identity in the runtime leaf; same node/attempt cannot collide across occurrences', () => {
    const f = nativeFixture()
    const a = repeatRuntimeDirectory('/runtime', f.scope, f.execution)
    const b = repeatRuntimeDirectory('/runtime', f.scope, { ...f.execution, id: 'occurrence-two-execution' })
    expect(a).not.toEqual(b)
    expect(a).toContain(f.execution.id)
    expect(a).toContain('attempt-1')
  })
  it('requires all native publication and authority hooks', () => {
    expect(() => requireRepeatNativeHooks(undefined)).toThrow('host is not installed')
    const keys = ['assertLaunchLocked', 'assertBoundaryLocked', 'assertUpdateLocked', 'publishLocked',
      'assertReceiptLocked', 'assertLaunchReceiptLocked'] as const
    const hooks = Object.fromEntries(keys.map((key) => [key, async () => undefined]))
    for (const key of keys) {
      const missing = { ...hooks }; delete missing[key]
      expect(() => requireRepeatNativeHooks(missing as unknown as Parameters<typeof requireRepeatNativeHooks>[0])).toThrow()
    }
  })
  it('treats all pre-allocation, raw, session, approval and credential evidence as possible submission', async () => {
    const f = nativeFixture()
    const queued = HarnessExecutionSchema.parse({ id: f.execution.id, runId: f.execution.runId,
      workflowNodeId: f.execution.workflowNodeId, agentId: f.execution.agentId,
      agentConfigurationVersionId: f.execution.agentConfigurationVersionId,
      attempt: 1, state: 'queued', input: {}, createdAt: nativeAt })
    let reads = 0
    const sql = { transaction: true, async query(text: string, values: unknown[]) {
      reads++
      expect(values).toEqual([queued.runId, queued.id])
      for (const table of ['run_graph_effects', 'execution_native_sessions', 'execution_native_closures',
        'harness_native_events', 'run_native_correlations', 'worker_credential_bindings',
        'approval_execution_state', 'durable_interactions', 'review_jobs']) expect(text).toContain(table)
      return { rows: [{ possible_submission: true }], rowCount: 1 }
    } } as unknown as GraphTransactionSql
    expect(await repeatPossibleSubmissionLocked(sql, queued)).toBe(true)
    expect(reads).toBe(1)
    for (const mutation of [{ startedAt: nativeAt }, { runtimeDirectory: '/already/allocated' },
      { workingDirectory: '/accepted/root' }, { nativeSessionId: 'already-bound' }]) {
      expect(await repeatPossibleSubmissionLocked(sql, { ...queued, ...mutation })).toBe(true)
    }
    expect(reads).toBe(1)
  })
  it('accepts only an explicit boolean absence result, not an empty or unknown query reply', async () => {
    const f = nativeFixture(), queued = HarnessExecutionSchema.parse({ id: f.execution.id, runId: f.execution.runId,
      workflowNodeId: f.execution.workflowNodeId, agentId: f.execution.agentId,
      agentConfigurationVersionId: f.execution.agentConfigurationVersionId,
      attempt: 1, state: 'queued', input: {}, createdAt: nativeAt })
    for (const rows of [[], [{ possible_submission: null }], [{ possible_submission: 'false' }]]) {
      const sql = { query: async () => ({ rows }) } as unknown as GraphTransactionSql
      await expect(repeatPossibleSubmissionLocked(sql, queued)).rejects.toMatchObject({ code: 'REPEAT_SUBMISSION_EVIDENCE_MISSING' })
    }
    const sql = { query: async () => ({ rows: [{ possible_submission: false }] }) } as unknown as GraphTransactionSql
    expect(await repeatPossibleSubmissionLocked(sql, queued)).toBe(false)
  })
})
