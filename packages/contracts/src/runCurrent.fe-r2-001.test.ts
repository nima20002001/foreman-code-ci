import { describe, expect, it } from 'vitest'
import * as retiredCurrent from './runCurrent.js'
import * as retiredHistory from './runHistory.js'
import { GraphSequenceSchema, RunGraphScopeSchema } from './wave25/graphPrimitives.js'
import { RunDetailsV3Schema } from './wave25/saved.js'
import { makeCurrentWorkflowFixture } from './wave25/currentFixture.js'

const fixture = makeCurrentWorkflowFixture('current-read-retirement')
const identity = fixture.identities[0]!
const execution = {
  id: identity.executionId, runId: fixture.run.id, workflowNodeId: identity.workflowNodeId,
  agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
  attempt: 1, state: 'running', input: {}, createdAt: fixture.createdAt,
}
const current = () => ({ run: { ...fixture.run, executionState: 'running' as const }, executions: [execution], activity: [], cleanupPending: false })

describe('FE-R2-001 read invariants on the sole current V3 pipeline', () => {
  it('retains only denial identifiers, not success contracts for retired read adapters', () => {
    expect(Object.keys(retiredCurrent).sort()).toEqual(['RUN_CURRENT_MCP_TOOL', 'RUN_CURRENT_ROUTE'])
    expect(Object.keys(retiredHistory).sort()).toEqual(['RUN_HISTORY_MCP_TOOL', 'RUN_HISTORY_ROUTE'])
    expect(retiredCurrent.RUN_CURRENT_MCP_TOOL).toBe('run_current_get_v1')
    expect(retiredHistory.RUN_HISTORY_MCP_TOOL).toBe('run_history_get_v1')
    expect(RunDetailsV3Schema.parse(current())).toEqual(current())
    for (const extension of [{ history: 'complete' }, { settlement: 'settled' }, { kind: 'legacy-run-current' }]) {
      expect(RunDetailsV3Schema.safeParse({ ...current(), ...extension }).success).toBe(false)
    }
  })

  it('rejects absent, retired, string and future execution tags on scopes and Run reads', () => {
    expect(RunGraphScopeSchema.parse(fixture.scope)).toEqual(fixture.scope)
    for (const executionSemanticsVersion of [undefined, null, 1, 2, '3', 4]) {
      expect(RunGraphScopeSchema.safeParse({ ...fixture.scope, executionSemanticsVersion }).success).toBe(false)
      expect(RunDetailsV3Schema.safeParse({ ...current(), run: { ...fixture.run, executionSemanticsVersion } }).success).toBe(false)
    }
  })

  it('keeps lifecycle/outcome coherence separate from cleanup and never fabricates settlement', () => {
    for (const cleanupPending of [false, true]) {
      const run = { ...fixture.run, executionState: 'completed', outcome: 'succeeded',
        result: { outcome: 'succeeded' }, finishedAt: fixture.createdAt }
      const parsed = RunDetailsV3Schema.parse({ ...current(), run, cleanupPending })
      expect(parsed.cleanupPending).toBe(cleanupPending)
      expect(parsed).not.toHaveProperty('settlement')
      expect(parsed.run.outcome).toBe('succeeded')
    }
    expect(RunDetailsV3Schema.safeParse({ ...current(), run: { ...fixture.run, outcome: 'succeeded' } }).success).toBe(false)
    expect(RunDetailsV3Schema.safeParse({ ...current(), run: { ...fixture.run, executionState: 'completed' } }).success).toBe(false)
  })

  it('validates exact decimal graph batch positions without rounding or invalid BigInt conversion', () => {
    // These are current graph batch cursors, NOT legacy Activity high-water values.
    for (const sequence of ['0', '9007199254740993', '9223372036854775807']) {
      expect(GraphSequenceSchema.parse(sequence)).toBe(sequence)
    }
    for (const sequence of ['-1', '01', '', 'abc', '1e3', '9223372036854775808', '1'.repeat(100)]) {
      expect(GraphSequenceSchema.safeParse(sequence).success).toBe(false)
    }
  })

  it('rejects duplicate identities, foreign-Run attempts and changed immutable configuration pins', () => {
    for (const extra of [execution, { ...execution, id: 'foreign-execution', runId: 'foreign-run' },
      { ...execution, id: 'wrong-config', agentConfigurationVersionId: 'not-the-pin' }]) {
      expect(RunDetailsV3Schema.safeParse({ ...current(), executions: [execution, extra] }).success).toBe(false)
    }
    // Current detail is real attempt history, not the retired latest-per-node projection.
    const secondAttempt = { ...execution, id: 'second-attempt', attempt: 2 }
    expect(RunDetailsV3Schema.parse({ ...current(), executions: [execution, secondAttempt] }).executions)
      .toEqual([execution, secondAttempt])
  })
})
