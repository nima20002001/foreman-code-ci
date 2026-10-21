import { describe, expect, it } from 'vitest'
import { makeCurrentGraphFixture } from './currentGraphFixture.js'
import {
  WorkflowChoiceSchema, parseChoiceResultEnvelope, NodeResolutionSchema,
  GraphSequenceSchema, GraphFactSchema, RunGraphBatchSchema, RunGraphPageSchema, RunGraphEventSchema,
  RUN_GRAPH_LIMITS, graphJsonBytes, applyRunGraphPageFixture,
} from '../src/wave25/index.js'

const choice = WorkflowChoiceSchema.parse({ outcomes: [
  { outcome: 'pass', target: { kind: 'branch_end' } },
  { outcome: 'issues', target: { kind: 'edge', relationshipId: 'fixer-link' } },
] })

describe('finite choice outcomes and one-shot resolutions', () => {
  it.each(['pass', 'issues'])('accepts the complete declared %s envelope', (outcome) => {
    const output = { routing: { outcome }, data: { summary: 'Synthetic result' } }
    expect(parseChoiceResultEnvelope({ outcome: 'succeeded', output }, choice)).toEqual(output)
    expect(parseChoiceResultEnvelope({ outcome: 'succeeded', output: JSON.stringify(output) }, choice)).toEqual(output)
  })
  it.each(['pass', '```json\n{"routing":{"outcome":"pass"},"data":{}}\n```', '{"routing":{"outcome":"other"},"data":{}}', '{"routing":{"outcome":"pass"}}', '{"routing":{"outcome":"pass"},"data":{}} trailing'])('has no prose, malformed, undeclared or partial fallback: %s', (output) => {
    expect(() => parseChoiceResultEnvelope({ outcome: 'succeeded', output }, choice)).toThrow()
  })
  it('validates declarations and never treats skipped/failed/unknown as accepted success', () => {
    expect(WorkflowChoiceSchema.safeParse({ outcomes: [...choice.outcomes, choice.outcomes[0]] }).success).toBe(false)
    expect(() => parseChoiceResultEnvelope({ outcome: 'canceled' }, choice)).toThrow()
    const fixture = makeCurrentGraphFixture()
    const resolution = { workflowNodeId: fixture.identities[0]!.workflowNodeId, resolution: 'skipped', branchEnded: false,
      selectedRelationshipIds: [], unselectedRelationshipIds: [fixture.version.definition.edges[0]!.id], resolvedAt: fixture.createdAt }
    expect(NodeResolutionSchema.safeParse(resolution).success).toBe(true)
    expect(NodeResolutionSchema.safeParse({ ...resolution, execution: fixture.identities[0] }).success).toBe(false)
    expect(NodeResolutionSchema.safeParse({ ...resolution, resolution: 'unknown' }).success).toBe(false)
    expect(NodeResolutionSchema.safeParse({ ...resolution, resolution: 'succeeded' }).success).toBe(false)
  })
})

describe('complete graph pages, identity and safe facts', () => {
  it('preserves decimal cursors above the JS safe integer limit', () => {
    expect(GraphSequenceSchema.parse('9007199254740993')).toBe('9007199254740993')
    for (const value of [9007199254740992, '01', '-1', '1.0', '9223372036854775808']) expect(GraphSequenceSchema.safeParse(value).success).toBe(false)
  })
  it('bounds complete batches by bytes as well as count, without accepting JSON prefixes', () => {
    const fixture = makeCurrentGraphFixture(), long = 'x'.repeat(200)
    const identity = { workflowNodeId: long, executionId: long, agentId: long, agentConfigurationVersionId: long, attempt: 1 }
    const event = { eventId: '00000000-0000-4000-8000-000000000001',
      evidence: { sourceKind: 'execution', sourceId: long, sourceRevision: '0' },
      fact: { type: 'node.state', state: { workflowNodeId: long, lifecycle: 'starting', execution: identity } } }
    expect(RunGraphEventSchema.safeParse(event).success).toBe(true)
    const batch = { protocolVersion: 1, scope: fixture.scope, batchId: '00000000-0000-4000-8000-000000000100', previousSequence: '0', sequence: '1',
      events: Array.from({ length: RUN_GRAPH_LIMITS.batchEvents }, (_, i) => ({ ...event, eventId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` })) }
    expect(graphJsonBytes(batch)).toBeGreaterThan(RUN_GRAPH_LIMITS.batchBytes)
    expect(RunGraphBatchSchema.safeParse(batch).success).toBe(false)
    expect(RunGraphBatchSchema.safeParse(JSON.stringify(batch).slice(0, 500)).success).toBe(false)
  })
  it('rejects partial cursor advancement, unsupported atomic content and raw bodies', () => {
    const fixture = makeCurrentGraphFixture()
    const batch = RunGraphBatchSchema.parse({ protocolVersion: 1, scope: fixture.scope,
      batchId: '00000000-0000-4000-8000-000000000001', previousSequence: '9007199254740992', sequence: '9007199254740993',
      events: [{ eventId: '00000000-0000-4000-8000-000000000002', evidence: { sourceKind: 'run', sourceId: fixture.run.id, sourceRevision: '1' },
        fact: { type: 'run.state', state: fixture.snapshot.state.run } }],
    })
    const page = { kind: 'page', protocolVersion: 1, scope: fixture.scope, baseSequence: batch.previousSequence, throughSequence: batch.sequence,
      headSequence: batch.sequence, retentionFloor: '0', hasMore: false, batches: [batch] }
    expect(RunGraphPageSchema.safeParse(page).success).toBe(true)
    expect(RunGraphPageSchema.safeParse({ ...page, batches: [] }).success).toBe(false)
    expect(RunGraphBatchSchema.safeParse({ ...batch, events: [...batch.events, ...batch.events] }).success).toBe(false)
    expect(GraphFactSchema.safeParse({ type: 'run.state', state: fixture.snapshot.state.run, rawBody: 'secret' }).success).toBe(false)
    expect(GraphFactSchema.safeParse({ type: 'transport.keepalive' }).success).toBe(false)
    expect(GraphFactSchema.safeParse({ type: 'node.activity', activity: { workflowNodeId: fixture.identities[0]!.workflowNodeId, status: 'active', action: 'working' } }).success).toBe(false)
  })
})

// Retained from the original bundle; imports and the erroneous copied errors module are repaired.
describe('compact settled-exchange retirement', () => {
  it('removes a settled current-window record, not domain history, and never infers Worker resumption', () => {
    const fixture = makeCurrentGraphFixture()
    fixture.snapshot.state.interactions = [{ interactionId: 'settled-interaction', revision: '1', requester: fixture.identities[0]!, handler: 'user', status: 'canceled', deliveryState: 'not_started', resumeState: 'not_started' }]
    const publication = RunGraphBatchSchema.parse({
      protocolVersion: 1, scope: fixture.scope, batchId: '00000000-0000-4000-8000-000000000001', previousSequence: '0', sequence: '1',
      events: [{ eventId: '00000000-0000-4000-8000-000000000002', evidence: { sourceKind: 'cleanup', sourceId: 'cleanup-confirmed', sourceRevision: '1' }, fact: { type: 'exchange.retired', exchangeKind: 'interaction', exchangeId: 'settled-interaction', finalRevision: '1' } }],
    })
    const page = { kind: 'page', protocolVersion: 1, scope: fixture.scope, baseSequence: '0', throughSequence: '1', headSequence: '1', retentionFloor: '0', hasMore: false, batches: [publication] }
    const applied = applyRunGraphPageFixture(fixture.snapshot, page, 1, 1)
    expect(applied.kind).toBe('applied')
    expect(applied.snapshot.state.interactions).toEqual([])
    expect(applied.snapshot.state.nodes).toBe(fixture.snapshot.state.nodes)
    fixture.snapshot.state.interactions[0]!.status = 'pending'
    expect(applyRunGraphPageFixture(fixture.snapshot, page, 1, 1).kind).toBe('reset')
  })
})
