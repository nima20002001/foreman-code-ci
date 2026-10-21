import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, HarnessExecutionSchema } from '@foreman-code/contracts'
import { canContinueWorkflowSession, readWorkflowSessionContinuation } from './sessionContinuation.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import * as closures from '../interactions/workflowClosure.js'
import * as placement from '../placement/persistence.js'
import { assertRepeatNativeUpdate } from '../interactions/repeatNativeEvidence.js'
import { repeatLaunchClaim } from './repeatNativeRepository.js'

const previous = HarnessExecutionSchema.parse({
  id: 'previous', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
  agentConfigurationVersionId: 'configuration', attempt: 1, input: {},
  workingDirectory: '/project', runtimeDirectory: '/runtime/previous', nativeSessionId: 'thread',
  state: 'completed', result: { outcome: 'succeeded' },
  createdAt: '2026-10-10T00:00:00.000Z', finishedAt: '2026-10-10T00:01:00.000Z',
})
const execution = HarnessExecutionSchema.parse({ ...previous, id: 'next', nativeSessionId: undefined,
  result: undefined, finishedAt: undefined, state: 'starting', runtimeDirectory: '/runtime/next',
  startedAt: '2026-10-10T00:02:00.000Z',
})
const continuation = { previousExecutionId: previous.id,
  session: { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: 'thread' } }
afterEach(() => vi.restoreAllMocks())

describe('workflow session continuity', () => {
  it('keeps separate execution and runtime identities when continuing the same node', () => {
    expect(canContinueWorkflowSession(previous, execution)).toBe(true)
    expect(execution.id).not.toBe(previous.id)
    expect(execution.runtimeDirectory).not.toBe(previous.runtimeDirectory)
  })

  it.each(['CODEX_APP_SERVER_DISCONNECTED', 'EXECUTION_INTERRUPTED', 'NATIVE_EXECUTION_FAILED',
    'PROVIDER_TEMPORARILY_UNAVAILABLE'])(
    'starts a fresh session after an abandoned %s attempt', async code => {
      const failed = HarnessExecutionSchema.parse({ ...previous, result: { outcome: 'failed',
        error: { code, message: 'The original native connection was lost.', retryable: true } } })
      const retry = { ...execution, attempt: 2 }
      expect(canContinueWorkflowSession(failed, retry)).toBe(false)
      const query = vi.fn(async (text: string) => ({
        rows: text.includes('run_control_continuations') ? [] : [{ record: failed, configuration: {} }] }))
      const closure = vi.spyOn(closures, 'readWorkflowClosure')
      expect(await readWorkflowSessionContinuation({ query } as unknown as GraphTransactionSql, retry)).toBeUndefined()
      expect(closure).not.toHaveBeenCalled()
    },
  )

  it.each([
    { runId: 'other-run' }, { workflowNodeId: 'other-node' }, { agentId: 'other-agent' },
    { agentConfigurationVersionId: 'other-configuration' }, { workingDirectory: '/other-project' },
  ])('starts fresh when the accepted identity changes: %j', change => {
    expect(canContinueWorkflowSession(previous, { ...execution, ...change })).toBe(false)
  })

  it('requires a completed execution with a retained native session and working directory', () => {
    expect(canContinueWorkflowSession({ ...previous, state: 'running' }, execution)).toBe(false)
    expect(canContinueWorkflowSession({ ...previous, nativeSessionId: undefined }, execution)).toBe(false)
    expect(canContinueWorkflowSession({ ...previous, workingDirectory: undefined }, execution)).toBe(false)
  })

  it.each(['failed', 'canceled'] as const)('starts a fresh native session after a %s attempt', outcome => {
    const abandoned = HarnessExecutionSchema.parse({ ...previous, result: { outcome,
      ...(outcome === 'failed' ? { error: { code: '08006', message: 'Connection lost.', retryable: true } } : {}) } })
    expect(canContinueWorkflowSession(abandoned, { ...execution, attempt: 2 })).toBe(false)
  })

  it('starts fresh when the execution host or placement changes', () => {
    const original = { bindingHash: 'a'.repeat(64) }
    expect(canContinueWorkflowSession(previous, execution, { previous: original, current: original })).toBe(true)
    expect(canContinueWorkflowSession(previous, execution,
      { previous: original, current: { bindingHash: 'b'.repeat(64) } })).toBe(false)
    expect(canContinueWorkflowSession(previous, execution, { previous: original })).toBe(false)
  })

  it.each(['closed', 'live', 'different-harness', 'ephemeral'] as const)(
    'selects persisted history only when it is resumable (%s)', async scenario => {
      const harness = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
      if (scenario === 'ephemeral') harness.advanced!.sessionPersistence = 'ephemeral'
      const configuration = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
        prompt: {}, assignedSkills: [], harness, contentHash: 'fixture', createdAt: previous.createdAt }
      const sql = {
        query: vi.fn(async (text: string) => ({
          rows: text.includes('run_control_continuations') ? [] : [{ record: previous, configuration }] })),
      } as unknown as GraphTransactionSql
      vi.spyOn(placement, 'readExecutionPlacement').mockResolvedValue(undefined)
      vi.spyOn(placement, 'readDispatchIntent').mockResolvedValue(undefined)
      vi.spyOn(closures, 'readWorkflowClosure').mockResolvedValue(scenario === 'live' ? undefined : {
        execution: { ...previous, nativeSessionId: 'thread' }, durableGeneration: '1',
        session: { ...continuation.session, harness: scenario === 'different-harness' ? 'claude' : 'codex' },
      })
      const selected = await readWorkflowSessionContinuation(sql, execution)
      expect(selected).toEqual(scenario === 'closed' ? continuation : undefined)
    })

  it('binds continuation to the launch and rejects later replacement or removal', () => {
    const continued = HarnessExecutionSchema.parse({ ...execution, sessionContinuation: continuation })
    const claim = repeatLaunchClaim({ runId: 'run', workspaceId: 'workspace', workflowId: 'workflow',
      workflowVersionId: 'version', executionSemanticsVersion: 3 }, { nodeId: 'node', occurrence: null },
    continued, `sha256:${'1'.repeat(64)}`)
    expect(claim.sessionContinuation).toEqual(continuation)
    expect(() => assertRepeatNativeUpdate(continued, execution)).toThrow()
    expect(() => assertRepeatNativeUpdate(continued, { ...continued,
      sessionContinuation: { ...continuation, previousExecutionId: 'different' } })).toThrow()
    expect(() => HarnessExecutionSchema.parse({ ...continued, nativeSessionId: 'another-thread' })).toThrow()
  })
})
