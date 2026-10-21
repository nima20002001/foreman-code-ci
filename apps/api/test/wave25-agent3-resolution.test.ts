import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { bindRepeatNodeInput, repeatExecutionIdentity, repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { normalizeRepeatTerminal, repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'

function choiceFixture() {
  const fixture = makeCurrentWorkflowFixture('a3-choice')
  fixture.version.definition.nodes[0]!.choice = { outcomes: [
    { outcome: 'pass', target: { kind: 'branch_end' } },
    { outcome: 'issues', target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } },
  ] }
  const executions = fixture.identities.map((identity) => HarnessExecutionSchema.parse({
    id: identity.executionId, runId: fixture.run.id, workflowNodeId: identity.workflowNodeId,
    agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt,
  }))
  return { ...fixture, executions }
}

describe('Agent 3 complete accepted evidence and exact input receipts', () => {
  it.each(['pass', 'issues'])('selects the finite %s route from a complete envelope', (outcome) => {
    const f = choiceFixture()
    const execution = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output: { routing: { outcome }, data: { ok: true } } } })
    const resolved = repeatTerminalResolution(f.version, f.scope, { nodeId: execution.workflowNodeId, occurrence: null }, normalizeRepeatTerminal(f.version, f.scope, { nodeId: execution.workflowNodeId, occurrence: null }, execution)).value
    expect(resolved.selectedRelationshipIds).toEqual(outcome === 'issues' ? [f.version.definition.edges[0]!.id] : [])
    expect(resolved.branchEnded).toBe(outcome === 'pass')
  })
  it.each([
    '```json\n{"routing":{"outcome":"pass"},"data":{}}\n```',
    'prefix {"routing":{"outcome":"pass"},"data":{}}',
    '{"routing":{"outcome":"pass"},"data":{}} trailing',
    { routing: { outcome: 'unknown' }, data: {} },
    { routing: { outcome: 'pass', targetNodeId: 'fixer' }, data: {} },
    { routing: { outcome: 'pass' } },
    { data: {} },
    { routing: { outcome: 'issues' }, data: {}, extra: true },
    { routing: { outcome: 'issues' }, data: 'x'.repeat(70 * 1024) },
  ])('fails malformed or oversized routing evidence without a fallback', (output) => {
    const f = choiceFixture()
    const execution = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output } })
    const normalized = normalizeRepeatTerminal(f.version, f.scope, { nodeId: execution.workflowNodeId, occurrence: null }, execution)
    expect(normalized.result?.outcome).toBe('failed')
    const resolved = repeatTerminalResolution(f.version, f.scope, { nodeId: normalized.workflowNodeId, occurrence: null }, normalized).value
    expect(resolved.selectedRelationshipIds).toEqual([])
    expect(resolved.unselectedRelationshipIds).toEqual([f.version.definition.edges[0]!.id])
  })
  it('binds exact accepted predecessor identity, result digest, input ordinal, and stable receipt ID', () => {
    const f = choiceFixture()
    const previous = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output: { routing: { outcome: 'issues' }, data: { finding: 7 } } } })
    const source = { relationshipId: f.version.definition.edges[0]!.id, execution: repeatExecutionIdentity(previous),
      occurrence: null, acceptedResult: previous.result!, acceptedResultDigest: repeatDigest(previous.result) }
    const request = { version: f.version, runInput: f.run.input, recipient: f.executions[1]!,
      ref: { nodeId: f.executions[1]!.workflowNodeId, occurrence: null }, occurrence: null, entry: null, predecessors: [source] }
    const first = bindRepeatNodeInput(request)
    expect(bindRepeatNodeInput(request)).toEqual(first)
    expect(first.bindings[0]).toMatchObject({ ordinal: 0, source: { execution: { executionId: previous.id } },
      recipient: { executionId: f.executions[1]!.id } })
    expect(first.input).toMatchObject({ predecessors: [{ acceptedResult: previous.result, execution: { executionId: previous.id } }] })
    expect(() => bindRepeatNodeInput({ ...request, predecessors: [{ ...source,
      acceptedResult: { outcome: 'failed', error: { code: 'FAIL', message: 'Rejected', retryable: false } } }] })).toThrow()
    expect(() => bindRepeatNodeInput({ ...request, predecessors: [{ ...source,
      acceptedResult: { outcome: 'succeeded', output: 'different' } }] })).toThrow()
  })
})
