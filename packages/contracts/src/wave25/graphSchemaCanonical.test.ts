import { describe, expect, it } from 'vitest'
import {
  GraphFactSchema, InputBindingSchema, PublicGraphDeltaSchema, PublicGraphProjectionSchema, RunGraphErrorCodeSchema,
  RunGraphErrorResponseSchema, RunGraphEventSchema, RunGraphSnapshotSchema,
} from './index.js'

const digest = (char: string) => `sha256:${char.repeat(64)}`
const scope = { workspaceId: 'ws-1', workflowId: 'wf-1', runId: 'run-1', workflowVersionId: 'wv-1', executionSemanticsVersion: 3 }
const agent = (node: string) => ({ workflowNodeId: node, executionId: `exec-${node}`, agentId: `agent-${node}`,
  agentConfigurationVersionId: `acv-${node}`, attempt: 1 })
const binding = (inputOrdinal: number) => ({ bindingId: 'binding-1', relationshipId: 'rel-1', sender: agent('a'),
  recipient: agent('b'), acceptedResultDigest: digest('a'), recipientInputDigest: digest('b'), inputOrdinal,
  boundAt: '2026-10-13T00:00:00.000Z' })
const node = (id: string, lifecycle: 'succeeded' | 'running') => ({
  state: { workflowNodeId: id, lifecycle, execution: agent(id) },
  activity: { workflowNodeId: id, status: 'none' },
  attention: { workflowNodeId: id, pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'current' },
})
const projection = (inputOrdinal: number) => ({
  run: { executionState: 'running', outcome: 'pending', stopRequested: false, cleanupPending: false,
    unsettledReviewCount: 0, pendingInteractionCount: 0 },
  nodes: [node('a', 'succeeded'), node('b', 'running')], inputBindings: [binding(inputOrdinal)], interactions: [], reviews: [],
})

/** Every public entry point that validates an input binding, so the ordinal rule cannot drift between copies. */
const bindingEntryPoints = {
  InputBindingSchema: (ordinal: number) => InputBindingSchema.safeParse(binding(ordinal)).success,
  GraphFactSchema: (ordinal: number) => GraphFactSchema.safeParse({ type: 'input.bound', binding: binding(ordinal) }).success,
  RunGraphEventSchema: (ordinal: number) => RunGraphEventSchema.safeParse({ eventId: '00000000-0000-4000-8000-000000000001',
    evidence: { sourceKind: 'input_binding', sourceId: 'binding-1', sourceRevision: '1' },
    fact: { type: 'input.bound', binding: binding(ordinal) } }).success,
  PublicGraphProjectionSchema: (ordinal: number) => PublicGraphProjectionSchema.safeParse(projection(ordinal)).success,
  PublicGraphDeltaSchema: (ordinal: number) => PublicGraphDeltaSchema.safeParse({ ...projection(ordinal),
    retiredInputBindingIds: [], retiredInteractionIds: [], retiredReviewIds: [] }).success,
  RunGraphSnapshotSchema: (ordinal: number) => RunGraphSnapshotSchema.safeParse({
    protocolVersion: 1, scope, asOfSequence: '1', retentionFloor: '0', historyCoverage: 'from_admission',
    topology: { entryNodeId: 'a', nodes: ['a', 'b'].map((id) => ({ workflowNodeId: id, agentId: `agent-${id}`,
      agentConfigurationVersionId: `acv-${id}`, productRole: 'coder' })),
    relationships: [{ relationshipId: 'rel-1', kind: 'execution', source: 'a', target: 'b' }] },
    state: projection(ordinal),
  }).success,
}

describe('canonical graph protocol schemas', () => {
  // Saved run_repeat_bindings rows allow ordinals 0..16000; public reads of them must parse.
  it.each(Object.entries(bindingEntryPoints))('%s accepts persisted input ordinals up to 16000 and nothing beyond', (_name, accepts) => {
    expect(accepts(0)).toBe(true)
    expect(accepts(7999)).toBe(true)
    expect(accepts(8000)).toBe(true)
    expect(accepts(16000)).toBe(true)
    expect(accepts(16001)).toBe(false)
    expect(accepts(-1)).toBe(false)
  })

  it('names the execution-semantics error the engine produces and not the retired rollout flag', () => {
    expect(RunGraphErrorCodeSchema.safeParse('EXECUTION_SEMANTICS_UNSUPPORTED').success).toBe(true)
    expect(RunGraphErrorCodeSchema.safeParse('EXECUTION_SEMANTICS_ROLLOUT_DISABLED').success).toBe(false)
    expect(RunGraphErrorResponseSchema.safeParse({ error: { code: 'EXECUTION_SEMANTICS_UNSUPPORTED', message: 'x' } }).success).toBe(true)
    expect(RunGraphErrorResponseSchema.safeParse({ error: { code: 'EXECUTION_SEMANTICS_ROLLOUT_DISABLED', message: 'x' } }).success).toBe(false)
  })
})
