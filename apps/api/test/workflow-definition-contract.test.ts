import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import {
  CURRENT_WORKFLOW_CAPABILITIES, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowSaveInputSchema,
  ManualRunStartInputSchema, makeCurrentWorkflowFixture, WorkflowVersionV3Schema, ExecutableWorkflowV3Schema,
  RepeatPlanV1Schema, RepeatGraphSnapshotV3Schema, repeatGraphTopologyV3, WorkflowRunV3Schema,
  CurrentWorkflowCreateInputSchema, SavedWorkflowVersionSchema, SavedWorkflowDefinitionSchema,
  CanonicalRunGraphScopeSchema, CurrentEditStageInputSchema, CurrentOperatorToolNameSchema,
  parseRepeatExitResultV1, type CurrentFixtureForm,
} from '@foreman-code/contracts/wave25'
import { currentWorkflowAvailable, requireCurrentWorkflowAccess } from '../src/modules/workflows/currentWorkflowPolicy.js'

const f = makeCurrentWorkflowFixture('current-contract')
const forms: CurrentFixtureForm[] = ['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat']
function input() {
  return { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedRevision: 1, expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
    graph: f.version.definition }
}
function principal(grants: unknown) {
  return ManagementPrincipalSchema.parse({ id: 'current-principal', name: 'Contract caller', audience: 'operator',
    expiresAt: '2999-01-01T00:00:00.000Z', revokedAt: null, grants })
}
const actions = ['workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save', 'agents:read', 'workspace_locations:read']

describe('ENG-S3-ONLY current definition and shared authoring policy', () => {
  it.each(forms)('%s uses the SAME actual V3 validator; no-repeat stays omitted', (form) => {
    const fixture = makeCurrentWorkflowFixture(`form-${form}`, form)
    const parsed = ExecutableWorkflowV3Schema.parse({ version: fixture.version, configurations: fixture.configurations })
    expect(parsed.version.executionSemanticsVersion).toBe(3)
    expect(Object.hasOwn(parsed.version.definition, 'repeat')).toBe(form === 'repeat')
    expect(Object.hasOwn(repeatGraphTopologyV3(parsed.version), 'repeat')).toBe(form === 'repeat')
    expect(Object.hasOwn(WorkflowRunV3Schema.parse(fixture.run), 'repeat')).toBe(false)
    expect(JSON.stringify(parsed.version.definition).includes('"repeat":')).toBe(form === 'repeat')
  })
  it.each([null, { contractVersion: 1, blocks: [] }, { contractVersion: 2, blocks: [] }])('does not accept a fake ordinary repeat plan %j', (repeat) => {
    const version = { ...f.version, definition: { ...f.version.definition, repeat } }
    expect(WorkflowVersionV3Schema.safeParse(version).success).toBe(false)
    expect(CurrentWorkflowSaveInputSchema.safeParse({ ...input(), graph: version.definition }).success).toBe(false)
    expect(RepeatPlanV1Schema.safeParse(repeat).success).toBe(false)
  })
  it('round-trips omission through Save and Stage without a manufactured key', () => {
    const save = CurrentWorkflowSaveInputSchema.parse(input())
    expect(Object.hasOwn(save.graph, 'repeat')).toBe(false)
    const stage = CurrentEditStageInputSchema.parse({ ...save, action: 'stage_edits', draftId: 'editor-current' })
    expect(Object.hasOwn(stage.graph, 'repeat')).toBe(false)
    expect(CurrentWorkflowSaveInputSchema.parse(JSON.parse(JSON.stringify(save)))).toEqual(save)
  })
  it.each([1, 2, 4, '3', undefined, null])('rejects execution tag %s at every explicitly tagged current boundary', (executionSemanticsVersion) => {
    expect(ManualRunStartInputSchema.safeParse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      workflowVersionId: f.version.id, executionSemanticsVersion, commandId: randomUUID(), input: {},
      expectedWorkflowRevision: 1, expectedLocationRevision: 1, expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds }).success).toBe(false)
    expect(SavedWorkflowVersionSchema.safeParse({ ...f.version, executionSemanticsVersion }).success).toBe(false)
    expect(SavedWorkflowDefinitionSchema.safeParse({ ...f.version.definition, executionSemanticsVersion }).success).toBe(false)
    expect(WorkflowRunV3Schema.safeParse({ ...f.run, executionSemanticsVersion }).success).toBe(false)
    expect(CanonicalRunGraphScopeSchema.safeParse({ ...f.scope, executionSemanticsVersion }).success).toBe(false)
  })
  it.each([1, 2, 4, '3', null])('creation rejects an explicit retired/unknown tag %s', (executionSemanticsVersion) => {
    expect(CurrentWorkflowCreateInputSchema.safeParse({ workspaceId: f.scope.workspaceId, commandId: randomUUID(), name: 'Current', executionSemanticsVersion }).success).toBe(false)
  })
  it.each(['expectedRevision', 'expectedWorkflowVersionId', 'expectedAgentConfigurationVersionIds'])(
    'requires the explicit %s Save pin', (key) => {
      const value: Record<string, unknown> = input(); delete value[key]
      expect(CurrentWorkflowSaveInputSchema.safeParse(value).success).toBe(false)
    })
  it('generates a Save command ID when omitted and preserves an explicit ID', () => {
    const { commandId, ...value } = input()
    expect(CurrentWorkflowSaveInputSchema.parse(value).commandId).toEqual(expect.any(String))
    expect(CurrentWorkflowSaveInputSchema.parse(input()).commandId).toBeTruthy()
    expect(CurrentWorkflowSaveInputSchema.parse({ ...value, commandId }).commandId).toBe(commandId)
  })
  it('retains current DAG, named-result, configuration, role and scope guards without repeat', () => {
    expect(ExecutableWorkflowV3Schema.safeParse({ version: f.version, configurations: [] }).success).toBe(false)
    expect(WorkflowVersionV3Schema.safeParse({ ...f.version, definition: { ...f.version.definition, workspaceId: 'other' } }).success).toBe(false)
    expect(WorkflowVersionV3Schema.safeParse({ ...f.version, definition: { ...f.version.definition, edges: [...f.version.definition.edges,
      { id: 'cycle', kind: 'execution', source: f.version.definition.nodes[1]!.id, target: f.version.entryNodeId }] } }).success).toBe(false)
    expect(WorkflowVersionV3Schema.safeParse({ ...f.version, definition: { ...f.version.definition, nodes: f.version.definition.nodes.map((node, i) =>
      i === 0 ? { ...node, choice: { outcomes: [{ outcome: 'go', target: { kind: 'edge', relationshipId: 'missing' } }] } } : node) } }).success).toBe(false)
  })
  it.each([0, -1, 1.5, Infinity, NaN, undefined, 2147483648])('rejects nonfinite/missing repeat cap %s', (maxOccurrences) => {
    const version = makeCurrentWorkflowFixture('bad-cap', 'repeat').version
    expect(WorkflowVersionV3Schema.safeParse({ ...version, definition: { ...version.definition,
      repeat: { ...version.definition.repeat, blocks: version.definition.repeat!.blocks.map((block) => ({ ...block, maxOccurrences })) } } }).success).toBe(false)
  })
  it.each(['overlap', 'side-exit', 'unknown-node', 'outcomes', 'limit-route', 'budget'])(
    'rejects unsupported repeat %s without a different schema family', (kind) => {
      const version = makeCurrentWorkflowFixture('bad-repeat', 'repeat').version
      const block = version.definition.repeat!.blocks[0]!
      if (kind === 'overlap') version.definition.repeat!.blocks.push({ ...block, id: 'overlap' })
      if (kind === 'side-exit') block.nodeIds = [block.entryNodeId]
      if (kind === 'unknown-node') block.nodeIds.push('missing')
      if (kind === 'outcomes') block.earlyExitOutcome = block.repeatOutcome
      if (kind === 'limit-route') block.limitExit = { kind: 'edge', relationshipId: 'missing' }
      if (kind === 'budget') version.definition.executionPolicy!.maxNodeExecutions = 2
      expect(WorkflowVersionV3Schema.safeParse(version).success).toBe(false)
    })
  it('does not turn metadata-read support, omission or a request flag into native admission', () => {
    expect(CURRENT_WORKFLOW_CAPABILITIES).toMatchObject({ executionSemanticsVersion: 3, repeatOptional: true,
      runtimeAdmission: false, stopAvailable: false, meaningfulEdit: false })
    expect(CurrentWorkflowCapabilitiesSchema.safeParse({ ...CURRENT_WORKFLOW_CAPABILITIES, runtimeAdmission: true }).success).toBe(false)
    expect(CurrentWorkflowSaveInputSchema.safeParse({ ...input(), runtimeAdmission: true }).success).toBe(false)
    expect(CurrentOperatorToolNameSchema.safeParse('run_graph_snapshot_v1').success).toBe(true)
    expect(CurrentOperatorToolNameSchema.safeParse('graph_save').success).toBe(false)
  })
  it('ordinary canonical metadata rejects repeat occurrences not declared by its topology', () => {
    const ordinary = { kind: 'snapshot', protocolVersion: 1, scope: f.scope, asOfSequence: '1', retentionFloor: '0',
      historyCoverage: 'from_admission', topology: repeatGraphTopologyV3(f.version), state: {
        run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false,
          unsettledReviewCount: 0, pendingInteractionCount: 0 }, nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], executions: [],
        resolutions: [], results: [], bindings: [], decisions: [],
      } }
    expect(RepeatGraphSnapshotV3Schema.parse(ordinary)).toEqual(ordinary)
    expect(RepeatGraphSnapshotV3Schema.safeParse({ ...ordinary, topology: { ...ordinary.topology, repeat: { contractVersion: 1, blocks: [] } } }).success).toBe(false)
  })
  it('keeps complete finite-exit result validation, not prose extraction', () => {
    const choice = makeCurrentWorkflowFixture('exit-data', 'repeat').version.definition.nodes[1]!.choice!
    const output = { routing: { outcome: 'issues' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: ['fix'] } }
    expect(parseRepeatExitResultV1({ outcome: 'succeeded', output }, choice)).toEqual(output)
    for (const invalid of ['Here is my result: ' + JSON.stringify(output), { ...output, data: { latestDeliverable: null, remainingFindings: [] } },
      { ...output, routing: { outcome: 'guessed' } }]) expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output: invalid }, choice)).toThrow()
  })
  it('uses compatible scopes for discovery, with a workspace-only location requirement', () => {
    const writer = principal([{ actions, scope: { workspaceIds: ['a'] } }])
    expect(currentWorkflowAvailable(writer, 'save')).toBe(true)
    expect(() => requireCurrentWorkflowAccess(writer, 'save', { workspaceId: 'b', workflowId: 'wf' })).toThrow()
    const split = principal([{ actions: ['workflows:read', 'graph:read', 'agents:read', 'workspace_locations:read'], scope: { workspaceIds: ['a'] } },
      { actions: ['workflows:update', 'graph:edit', 'graph:save'], scope: { workspaceIds: ['b'] } }])
    expect(currentWorkflowAvailable(split, 'save')).toBe(false)
    expect(currentWorkflowAvailable(principal([{ actions, scope: { workspaceIds: ['a'], workflowIds: ['wf'] } }]), 'save')).toBe(false)
    expect(currentWorkflowAvailable(principal([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: ['a'] } }]), 'save')).toBe(false)
    expect(currentWorkflowAvailable({ ...writer, revokedAt: '2026-09-25T00:00:00.000Z' }, 'save')).toBe(false)
  })
})
